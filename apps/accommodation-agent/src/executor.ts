import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { TaskState, type Artifact } from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { rankDeterministically } from "@odft/domain";
import {
  RECOMMENDATION_PROMPT_VERSION,
  RECOMMENDATION_SYSTEM_PROMPT,
  type RecommendationContext,
} from "@odft/ai";
import {
  accommodationRecommendationsSchema,
  agentInputRequestSchema,
  agentTaskRequestSchema,
  type AccommodationRecommendations,
  type AgentInputRequest,
} from "@odft/contracts";
import {
  assertAuthorityCovers,
  claimDelegationTask,
  consumeInputContinuation,
  getTaskControl,
  loadDelegatedAuthority,
  recordInputRequest,
  requestTaskCancellation,
  setTaskState,
} from "@odft/persistence";
import {
  accrueActiveTime,
  canonicalHash,
  countedToolCall,
  createTaskClock,
  createTaskSession,
  dataPart,
  dataPartOf,
  DurableMessageAdmission,
  limitsForSkill,
  McpClient,
  safeFailureCode,
  type ProtocolConfig,
} from "@odft/protocols";
import {
  rankDelegatedOffers,
  type DelegatedFlightRankingDeps,
  type DelegatedOfferRankingResult,
} from "@odft/services";
import type { ServerConfig } from "@odft/persistence";
import {
  ACCOMMODATION_AGENT_IDENTITY,
  ACCOMMODATION_SKILL_ID,
  type AccommodationAgentConfig,
} from "./config.js";

/**
 * Phase 06 accommodation executor: durable admission, delegated authority,
 * counted MCP hotel reads, deterministic eligibility/rank, an optional governed
 * comparison and the genuine price-versus-location question with same-task
 * continuation (plan §3.3/§3.9/§3.10).
 */

export interface AccommodationAgentRuntime {
  readonly config: AccommodationAgentConfig;
  readonly serverConfig: ServerConfig;
  readonly admission: DurableMessageAdmission;
  readonly pool: Pool;
  readonly mcp: McpClient;
  readonly protocol: ProtocolConfig;
  /** Paid-path wiring (openrouter mode): delegated profile + governor-free adapter. */
  readonly rankingDeps?: DelegatedFlightRankingDeps;
}

interface HotelFact {
  readonly id: string;
  readonly name: string;
  readonly level: string;
  readonly partyTotalMinor: number;
  readonly centerDistanceKm: number;
  readonly luggageStorage: boolean;
}

const TRADEOFF_OPTION_CHEAPEST = "cheapest";
const TRADEOFF_OPTION_CENTRAL = "central";
/** A hotel within this premium of the cheapest is a viable alternative. */
const TRADEOFF_PREMIUM_RATIO = 0.5;
/** ...and it must be at least this much and this relatively closer to count. */
const TRADEOFF_MIN_DISTANCE_KM = 1.5;
const TRADEOFF_DISTANCE_RATIO = 0.6;
const INPUT_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** Deterministic price/id order (domain helper), used for the cheapest option. */
function byPrice(facts: readonly HotelFact[]): HotelFact[] {
  const order = rankDeterministically(facts);
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  return order.map((id) => byId.get(id) as HotelFact);
}

/** Deterministic distance/price/id order (the answered central preference). */
function byDistance(facts: readonly HotelFact[]): HotelFact[] {
  return [...facts].sort(
    (a, b) =>
      a.centerDistanceKm - b.centerDistanceKm ||
      a.partyTotalMinor - b.partyTotalMinor ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Genuine tradeoff question (analysis §5): a cheaper search where a hotel
 * within a small price premium of the cheapest sits meaningfully closer to the
 * centre than the cheapest, and no preference decides between them (the trip
 * preferences carry no centrality preference).
 */
export function hotelTradeoffAmbiguous(facts: readonly HotelFact[]): boolean {
  if (facts.length < 2) {
    return false;
  }
  const cheapest = byPrice(facts)[0];
  if (!cheapest) {
    return false;
  }
  const band = facts.filter(
    (fact) => fact.partyTotalMinor <= cheapest.partyTotalMinor * (1 + TRADEOFF_PREMIUM_RATIO),
  );
  return band.some(
    (fact) =>
      fact.centerDistanceKm <= cheapest.centerDistanceKm - TRADEOFF_MIN_DISTANCE_KM &&
      fact.centerDistanceKm <= cheapest.centerDistanceKm * TRADEOFF_DISTANCE_RATIO,
  );
}

export function createAccommodationExecutor(runtime: AccommodationAgentRuntime): AgentExecutor {
  const sleep = async (ms: number): Promise<void> => {
    if (ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  };

  return {
    async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
      const message = requestContext.userMessage;
      const task = requestContext.task;
      if (!task) {
        throw new Error("admission must have committed the canonical task");
      }
      const startedAt = Date.now();
      const session = createTaskSession({
        pool: runtime.pool,
        agentIdentity: ACCOMMODATION_AGENT_IDENTITY,
        eventBus,
        admission: runtime.admission,
        task,
        messageId: message.messageId,
      });

      // 1. Initial task event is mandatory for every invocation (incl. continuations).
      eventBus.publish({
        kind: "task",
        data: {
          ...task,
          status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: new Date().toISOString() },
        },
      });

      await runtime.admission.markWorking(task.id);
      try {
        if (runtime.config.crashBeforeWork) {
          process.stderr.write("accommodation-agent: simulated crash before work\n");
          process.exit(3);
        }
        const request = agentTaskRequestSchema.safeParse(dataPartOf(message));
        if (!request.success || request.data.skillId !== ACCOMMODATION_SKILL_ID) {
          await session.publishFailure("INVALID_ARTIFACT", "the task request is not a valid accommodation request");
          return;
        }
        const data = request.data;

        // A continuation must be a properly rebound answer of the pending
        // question before ANY work: generation, request id and expiry are
        // validated and the pending binding is consumed exactly once.
        let answerOption: string | null = null;
        if (data.continuation) {
          const consumed = await consumeInputContinuation(runtime.pool, {
            agentIdentity: ACCOMMODATION_AGENT_IDENTITY,
            taskId: task.id,
            inputGeneration: data.continuation.inputGeneration,
            answerRequestId: data.continuation.answerRequestId,
          });
          if (!consumed.ok) {
            await session.publishFailure(
              consumed.code ?? "STALE_AGENT_RESULT",
              consumed.reason ?? "the continuation is not a valid answer",
            );
            return;
          }
          if (
            data.continuation.selectedOptionId !== TRADEOFF_OPTION_CHEAPEST &&
            data.continuation.selectedOptionId !== TRADEOFF_OPTION_CENTRAL
          ) {
            await session.publishFailure(
              "INVALID_ARTIFACT",
              "the continuation selected an unknown option of the pending question",
            );
            return;
          }
          answerOption = data.continuation.selectedOptionId;
        }

        let authority = await loadDelegatedAuthority(runtime.pool, {
          agentIdentity: ACCOMMODATION_AGENT_IDENTITY,
          delegationId: data.delegationId,
        });
        if (!authority.taskId) {
          await claimDelegationTask(runtime.pool, {
            delegationId: authority.delegationId,
            agentIdentity: ACCOMMODATION_AGENT_IDENTITY,
            taskId: task.id,
          });
          authority = await loadDelegatedAuthority(runtime.pool, {
            agentIdentity: ACCOMMODATION_AGENT_IDENTITY,
            delegationId: data.delegationId,
          });
        }
        assertAuthorityCovers(authority, {
          domain: "hotel",
          snapshotId: data.snapshot.snapshotId,
          taskId: task.id,
        });

        // 2. Real MCP reads: metadata + the delegated hotel query.
        const clock = await createTaskClock({
          pool: runtime.pool,
          agentIdentity: ACCOMMODATION_AGENT_IDENTITY,
          taskId: task.id,
          skillId: ACCOMMODATION_SKILL_ID,
          startedAtMs: startedAt,
        });
        clock.assertNow({ mcpInvocation: true });
        session.publishStatus(TaskState.TASK_STATE_WORKING, "MCP discovery: travel-data search_hotels");
        await countedToolCall({
          mcp: runtime.mcp,
          pool: runtime.pool,
          agentIdentity: ACCOMMODATION_AGENT_IDENTITY,
          taskId: task.id,
          clock,
          service: "odft-travel-data",
          name: "get_scenario_metadata",
          arguments: { delegationId: authority.delegationId, snapshotId: authority.snapshotId },
        });
        await sleep(runtime.config.stepDelayMs);
        const hotelsPage = await countedToolCall({
          mcp: runtime.mcp,
          pool: runtime.pool,
          agentIdentity: ACCOMMODATION_AGENT_IDENTITY,
          taskId: task.id,
          clock,
          service: "odft-travel-data",
          name: "search_hotels",
          arguments: {
            delegationId: authority.delegationId,
            snapshotId: authority.snapshotId,
            pageSize: 20,
          },
        });
        const page = hotelsPage.structuredContent as {
          domainHash?: string;
          error?: string;
          items?: HotelFact[];
          providerStatus?: string;
          reason?: string | null;
        };
        if (page.providerStatus !== "ok" || !page.items?.length) {
          await session.publishFailure(
            "AGENT_UNAVAILABLE",
            page.error
              ? `the delegated hotel query failed: ${page.error}`
              : `the delegated hotel query returned no usable offers (${page.providerStatus ?? "unknown"}${page.reason ? `: ${page.reason}` : ""})`,
          );
          return;
        }
        if (!page.domainHash) {
          await session.publishFailure(
            "INVALID_ARTIFACT",
            "the delegated hotel query returned no hotels domain content hash",
          );
          return;
        }
        const facts: HotelFact[] = page.items.map((item) => ({
          id: item.id,
          name: item.name,
          level: item.level,
          partyTotalMinor: item.partyTotalMinor,
          centerDistanceKm: item.centerDistanceKm,
          luggageStorage: item.luggageStorage,
        }));

        // 3. The genuine missing-tradeoff question: asked once, only for a
        // cheaper search whose eligible set is actually ambiguous.
        if (
          data.searchObjective === "cheaper" &&
          !answerOption &&
          hotelTradeoffAmbiguous(facts)
        ) {
          clock.assertNow({ input: true });
          const control = await getTaskControl(runtime.pool, {
            agentIdentity: ACCOMMODATION_AGENT_IDENTITY,
            taskId: task.id,
          });
          const tradeoff = {
            reason: "the cheaper search has a genuine price-versus-location tradeoff",
            question:
              "The cheapest hotels are farther from the centre; slightly pricier options are much more central. Which matters more?",
            options: [
              { id: TRADEOFF_OPTION_CHEAPEST, label: "Lowest total price" },
              { id: TRADEOFF_OPTION_CENTRAL, label: "Closest to the centre" },
            ],
          };
          const inputRequest: AgentInputRequest = agentInputRequestSchema.parse({
            correlation: {
              schemaVersion: 1,
              skillId: ACCOMMODATION_SKILL_ID,
              tripId: data.tripId,
              operationId: data.operationId,
              acceptedRevision: data.acceptedRevision,
              delegationId: authority.delegationId,
              traceId: `trace-${task.id}`,
              snapshotId: authority.snapshotId,
              scenarioKey: data.snapshot.scenarioKey,
              inputFingerprint: data.inputFingerprint,
              domainFingerprints: { hotel: page.domainHash },
            },
            // Stable across retries of the same question on the same task.
            requestId: `accommodation-tradeoff:${task.id}`,
            taskId: task.id,
            contextId: task.contextId,
            inputGeneration: control?.inputGeneration ?? 1,
            reason: tradeoff.reason,
            question: tradeoff.question,
            options: tradeoff.options,
            expiresAt: new Date(Date.now() + INPUT_EXPIRY_MS).toISOString(),
            requestHash: canonicalHash(tradeoff),
          });
          await recordInputRequest(runtime.pool, {
            agentIdentity: ACCOMMODATION_AGENT_IDENTITY,
            taskId: task.id,
            requestId: inputRequest.requestId,
            requestHash: inputRequest.requestHash,
            expiresAt: inputRequest.expiresAt,
          });
          await session.publishInputRequired(
            inputRequest,
            "application/vnd.odft.agent-input-request.v1+json",
          );
          return;
        }

        // 4. Deterministic order per the answered/effective objective, then the
        // optional governed comparison (which may only permute supplied ids).
        clock.assertNow({});
        if (await session.cancellationRequested()) {
          await session.publishCancelled();
          return;
        }
        const deterministicFacts =
          answerOption === TRADEOFF_OPTION_CENTRAL ? byDistance(facts) : byPrice(facts);
        const deterministicOrder = deterministicFacts.map((fact) => fact.id);
        let ranking: DelegatedOfferRankingResult = {
          rankedOfferIds: deterministicOrder,
          reasons: [],
          mode: "fixture",
          fallbackUsed: false,
        };
        const paidConfigured =
          runtime.config.aiMode === "openrouter" || Boolean(runtime.rankingDeps?.paidAdapter);
        if (facts.length > 1 && paidConfigured && clock.allowance().remainingLlm > 0) {
          const context: RecommendationContext = {
            role: "recommendation",
            tradeoff:
              answerOption === TRADEOFF_OPTION_CENTRAL
                ? "closest to the centre first, then price"
                : "lowest total price first, then distance",
            target: "hotel",
            baselineOfferId:
              typeof data.queryContext.baselineOfferId === "string"
                ? data.queryContext.baselineOfferId
                : null,
            candidates: facts.map((fact) => ({
              offerId: fact.id,
              partyTotalMinor: fact.partyTotalMinor,
              level: fact.level as RecommendationContext["candidates"][number]["level"],
              centerDistanceKm: fact.centerDistanceKm,
            })),
          };
          ranking = await rankDelegatedOffers(runtime.pool, runtime.serverConfig, runtime.rankingDeps ?? {}, {
            authority: {
              kind: "delegation",
              delegationId: authority.delegationId,
              agentIdentity: ACCOMMODATION_AGENT_IDENTITY,
              skillId: ACCOMMODATION_SKILL_ID,
              taskId: task.id,
              traceId: `trace-${task.id}`,
            },
            effectScope: `recommendation:${task.history.length}`,
            signal: AbortSignal.timeout(Math.max(1, clock.deadlineMs - Date.now())),
            limits: {
              maxCallCostUsd: String(limitsForSkill(ACCOMMODATION_SKILL_ID).maxTaskCostUsd),
              maxCallsPerTrip: runtime.serverConfig.maxLlmCallsPerTrip,
              maxCostUsdPerTrip: String(runtime.serverConfig.maxLlmCostUsdPerTrip),
              maxAttemptsPerScope: 2,
              taskMaxCostUsd: String(limitsForSkill(ACCOMMODATION_SKILL_ID).maxTaskCostUsd),
            },
            rolePrompt: {
              promptVersion: RECOMMENDATION_PROMPT_VERSION,
              systemPrompt: RECOMMENDATION_SYSTEM_PROMPT,
            },
            context,
            allowedIds: facts.map((fact) => fact.id),
            deterministicOrder,
          });
        }
        const byId = new Map(facts.map((fact) => [fact.id, fact]));
        const rankedIds = ranking.rankedOfferIds.filter((id) => byId.has(id));
        if (rankedIds.length === 0) {
          await session.publishFailure("INVALID_ARTIFACT", "the ranking contained no usable hotel offer");
          return;
        }
        if (await session.cancellationRequested()) {
          await session.publishCancelled();
          return;
        }

        // 5. Validated artifact, persisted before completion.
        const artifact: AccommodationRecommendations = accommodationRecommendationsSchema.parse({
          correlation: {
            schemaVersion: 1,
            skillId: ACCOMMODATION_SKILL_ID,
            tripId: data.tripId,
            operationId: data.operationId,
            acceptedRevision: data.acceptedRevision,
            delegationId: authority.delegationId,
            traceId: `trace-${task.id}`,
            snapshotId: authority.snapshotId,
            scenarioKey: data.snapshot.scenarioKey,
            inputFingerprint: data.inputFingerprint,
            domainFingerprints: { hotel: page.domainHash },
          },
          rankedHotelOfferIds: rankedIds,
          effectiveLevel: data.effectiveLevel,
          searchObjective: data.searchObjective,
          findings: [],
          comparisons: rankedIds.map((id) => {
            // `rankedIds` was filtered to `byId` membership above.
            const fact = byId.get(id) as HotelFact;
            return {
              hotelOfferId: id,
              partyTotalMinor: fact.partyTotalMinor,
              distanceKm: fact.centerDistanceKm,
              note: `${fact.name}: price and centre distance facts of the delegated snapshot.`,
            };
          }),
          explanations:
            ranking.reasons.length > 0
              ? ranking.reasons.slice(0, 8).map((reason) => reason.explanation)
              : [
                  answerOption === TRADEOFF_OPTION_CENTRAL
                    ? `The traveler chose the centre; ${rankedIds.length} eligible hotel(s) ordered by distance, then price.`
                    : `Deterministic ranking of ${rankedIds.length} eligible hotel(s) by price, then id.`,
                ],
        });
        const artifactRecord: Artifact = {
          artifactId: randomUUID(),
          name: "accommodation-recommendations",
          description: "Ranked hotel offers of the delegated frozen snapshot",
          parts: [
            dataPart(artifact, "application/vnd.odft.accommodation-recommendations.v1+json"),
            {
              content: { $case: "text", value: `mode:${ranking.mode}` },
              mediaType: "text/plain",
              filename: "",
              metadata: {},
            },
          ],
          metadata: undefined,
          extensions: [],
        };
        session.publishArtifact(artifactRecord);
        // Settle the admission record BEFORE the terminal status is published:
        // a caller that observes COMPLETED can always read the settled row.
        await runtime.admission.markSettled({
          messageId: message.messageId,
          taskId: task.id,
          state: "completed",
        });
        session.publishStatus(
          TaskState.TASK_STATE_COMPLETED,
          "accommodation recommendations completed",
          { mode: ranking.mode },
        );
        eventBus.finished();
      } catch (error) {
        await session.publishFailure(
          safeFailureCode(error),
          error instanceof Error ? error.message : "accommodation recommendation failed",
        );
      } finally {
        await accrueActiveTime(runtime.pool, {
          agentIdentity: ACCOMMODATION_AGENT_IDENTITY,
          taskId: task.id,
          startedAtMs: startedAt,
        }).catch(() => undefined);
      }
    },

    async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
      const control = await getTaskControl(runtime.pool, {
        agentIdentity: ACCOMMODATION_AGENT_IDENTITY,
        taskId,
      });
      await requestTaskCancellation(runtime.pool, { agentIdentity: ACCOMMODATION_AGENT_IDENTITY, taskId });
      await setTaskState(runtime.pool, {
        agentIdentity: ACCOMMODATION_AGENT_IDENTITY,
        taskId,
        state: "cancelled",
      });
      eventBus.publish({
        kind: "statusUpdate",
        data: {
          taskId,
          contextId: control?.contextId ?? taskId,
          status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: new Date().toISOString() },
          metadata: undefined,
        },
      });
      eventBus.finished();
    },
  };
}
