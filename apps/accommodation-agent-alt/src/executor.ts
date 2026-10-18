import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { TaskState, type Artifact } from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
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
  ACCOMMODATION_ALT_AGENT_IDENTITY,
  ACCOMMODATION_ALT_SKILL_ID,
  type AccommodationAltAgentConfig,
} from "./config.js";

/**
 * Phase 10 Accommodation Agent B (plan §3.17): an INDEPENDENT executor.
 *
 * It shares the public request/artifact contracts, the official SDK plumbing
 * and the deterministic delegated read services, but implements its own
 * eligibility ordering, tradeoff detection, explanation strategy and optional
 * model profile. It imports no code from `apps/accommodation-agent`.
 *
 * Strategy: a value score that trades price against distance to the centre
 * (normalized within the eligible set), instead of the primary agent's
 * price-first or distance-first order. The same genuine input-required question
 * (price versus location) is asked when a cheaper search is ambiguous.
 */

export interface AccommodationAltAgentRuntime {
  readonly config: AccommodationAltAgentConfig;
  readonly serverConfig: ServerConfig;
  readonly admission: DurableMessageAdmission;
  readonly pool: Pool;
  readonly mcp: McpClient;
  readonly protocol: ProtocolConfig;
  readonly rankingDeps?: DelegatedFlightRankingDeps;
}

interface HotelCandidate {
  readonly id: string;
  readonly name: string;
  readonly level: string;
  readonly partyTotalMinor: number;
  readonly centerDistanceKm: number;
  readonly luggageStorage: boolean;
}

const TRADEOFF_OPTION_CHEAPEST = "cheapest";
const TRADEOFF_OPTION_CENTRAL = "central";
/** B's ambiguity band: a viable central alternative within this premium... */
const VALUE_PREMIUM_RATIO = 0.6;
/** ...and at least this much / this relatively closer to the centre. */
const VALUE_MIN_DISTANCE_KM = 1;
const VALUE_DISTANCE_RATIO = 0.7;
const INPUT_EXPIRY_MS = 24 * 60 * 60 * 1000;
/** Value score weights: price dominates, distance remains meaningful. */
const PRICE_WEIGHT = 0.6;
const DISTANCE_WEIGHT = 0.4;

function normalize(value: number, min: number, max: number): number {
  return max > min ? (value - min) / (max - min) : 0;
}

/** Independent value-score order (distinct from the primary executor). */
function valueOrder(facts: readonly HotelCandidate[]): HotelCandidate[] {
  const prices = facts.map((fact) => fact.partyTotalMinor);
  const distances = facts.map((fact) => fact.centerDistanceKm);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const minDistance = Math.min(...distances);
  const maxDistance = Math.max(...distances);
  return [...facts].sort((a, b) => {
    const scoreA =
      PRICE_WEIGHT * normalize(a.partyTotalMinor, minPrice, maxPrice) +
      DISTANCE_WEIGHT * normalize(a.centerDistanceKm, minDistance, maxDistance);
    const scoreB =
      PRICE_WEIGHT * normalize(b.partyTotalMinor, minPrice, maxPrice) +
      DISTANCE_WEIGHT * normalize(b.centerDistanceKm, minDistance, maxDistance);
    return (
      scoreA - scoreB ||
      a.partyTotalMinor - b.partyTotalMinor ||
      a.centerDistanceKm - b.centerDistanceKm ||
      a.id.localeCompare(b.id)
    );
  });
}

function cheapestOrder(facts: readonly HotelCandidate[]): HotelCandidate[] {
  return [...facts].sort(
    (a, b) =>
      a.partyTotalMinor - b.partyTotalMinor ||
      a.centerDistanceKm - b.centerDistanceKm ||
      a.id.localeCompare(b.id),
  );
}

function centralOrder(facts: readonly HotelCandidate[]): HotelCandidate[] {
  return [...facts].sort(
    (a, b) =>
      a.centerDistanceKm - b.centerDistanceKm ||
      a.partyTotalMinor - b.partyTotalMinor ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Genuine tradeoff (plan §3.10): a cheaper search where a hotel within B's
 * premium band is meaningfully closer than the cheapest one and no existing
 * preference decides between them.
 */
export function hotelTradeoffAmbiguous(facts: readonly HotelCandidate[]): boolean {
  if (facts.length < 2) {
    return false;
  }
  const cheapest = cheapestOrder(facts)[0];
  if (!cheapest) {
    return false;
  }
  return facts.some(
    (fact) =>
      fact.partyTotalMinor <= cheapest.partyTotalMinor * (1 + VALUE_PREMIUM_RATIO) &&
      fact.centerDistanceKm <= cheapest.centerDistanceKm - VALUE_MIN_DISTANCE_KM &&
      fact.centerDistanceKm <= cheapest.centerDistanceKm * VALUE_DISTANCE_RATIO,
  );
}

export function createAccommodationAltExecutor(
  runtime: AccommodationAltAgentRuntime,
): AgentExecutor {
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
        agentIdentity: ACCOMMODATION_ALT_AGENT_IDENTITY,
        eventBus,
        admission: runtime.admission,
        task,
        messageId: message.messageId,
      });

      // Every invocation publishes the initial task event first (SDK rule).
      eventBus.publish({
        kind: "task",
        data: {
          ...task,
          status: {
            state: TaskState.TASK_STATE_WORKING,
            message: undefined,
            timestamp: new Date().toISOString(),
          },
        },
      });
      await runtime.admission.markWorking(task.id);

      try {
        if (runtime.config.crashBeforeWork) {
          process.stderr.write("accommodation-agent-alt: simulated crash before work\n");
          process.exit(3);
        }

        const request = agentTaskRequestSchema.safeParse(dataPartOf(message));
        if (!request.success || request.data.skillId !== ACCOMMODATION_ALT_SKILL_ID) {
          await session.publishFailure(
            "INVALID_ARTIFACT",
            "the task request is not a valid accommodation request",
          );
          return;
        }
        const data = request.data;

        let answerOption: string | null = null;
        if (data.continuation) {
          const consumed = await consumeInputContinuation(runtime.pool, {
            agentIdentity: ACCOMMODATION_ALT_AGENT_IDENTITY,
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
          agentIdentity: ACCOMMODATION_ALT_AGENT_IDENTITY,
          delegationId: data.delegationId,
        });
        if (!authority.taskId) {
          await claimDelegationTask(runtime.pool, {
            delegationId: authority.delegationId,
            agentIdentity: ACCOMMODATION_ALT_AGENT_IDENTITY,
            taskId: task.id,
          });
          authority = await loadDelegatedAuthority(runtime.pool, {
            agentIdentity: ACCOMMODATION_ALT_AGENT_IDENTITY,
            delegationId: data.delegationId,
          });
        }
        assertAuthorityCovers(authority, {
          domain: "hotel",
          snapshotId: data.snapshot.snapshotId,
          taskId: task.id,
        });

        const clock = await createTaskClock({
          pool: runtime.pool,
          agentIdentity: ACCOMMODATION_ALT_AGENT_IDENTITY,
          taskId: task.id,
          skillId: ACCOMMODATION_ALT_SKILL_ID,
          startedAtMs: startedAt,
        });
        clock.assertNow({ mcpInvocation: true });
        session.publishStatus(TaskState.TASK_STATE_WORKING, "MCP discovery: travel-data search_hotels");
        await countedToolCall({
          mcp: runtime.mcp,
          pool: runtime.pool,
          agentIdentity: ACCOMMODATION_ALT_AGENT_IDENTITY,
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
          agentIdentity: ACCOMMODATION_ALT_AGENT_IDENTITY,
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
          items?: HotelCandidate[];
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
        const facts: HotelCandidate[] = page.items.map((item) => ({
          id: item.id,
          name: item.name,
          level: item.level,
          partyTotalMinor: item.partyTotalMinor,
          centerDistanceKm: item.centerDistanceKm,
          luggageStorage: item.luggageStorage,
        }));

        if (
          data.searchObjective === "cheaper" &&
          !answerOption &&
          hotelTradeoffAmbiguous(facts)
        ) {
          clock.assertNow({ input: true });
          const control = await getTaskControl(runtime.pool, {
            agentIdentity: ACCOMMODATION_ALT_AGENT_IDENTITY,
            taskId: task.id,
          });
          const tradeoff = {
            reason: "the cheaper search has a genuine value-versus-location tradeoff",
            question:
              "A slightly pricier hotel is much closer to the centre. Should the ranking optimize total price or location?",
            options: [
              { id: TRADEOFF_OPTION_CHEAPEST, label: "Lowest total price" },
              { id: TRADEOFF_OPTION_CENTRAL, label: "Closest to the centre" },
            ],
          };
          const inputRequest: AgentInputRequest = agentInputRequestSchema.parse({
            correlation: {
              schemaVersion: 1,
              skillId: ACCOMMODATION_ALT_SKILL_ID,
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
            requestId: `accommodation-alt-tradeoff:${task.id}`,
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
            agentIdentity: ACCOMMODATION_ALT_AGENT_IDENTITY,
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

        clock.assertNow({});
        if (await session.cancellationRequested()) {
          await session.publishCancelled();
          return;
        }
        const deterministicFacts =
          answerOption === TRADEOFF_OPTION_CHEAPEST
            ? cheapestOrder(facts)
            : answerOption === TRADEOFF_OPTION_CENTRAL
              ? centralOrder(facts)
              : valueOrder(facts);
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
                ? "closest to the centre first, then total price"
                : answerOption === TRADEOFF_OPTION_CHEAPEST
                  ? "lowest total price first, then distance"
                  : "best value: balance total price against distance to the centre",
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
          ranking = await rankDelegatedOffers(
            runtime.pool,
            runtime.serverConfig,
            runtime.rankingDeps ?? {},
            {
              authority: {
                kind: "delegation",
                delegationId: authority.delegationId,
                agentIdentity: ACCOMMODATION_ALT_AGENT_IDENTITY,
                skillId: ACCOMMODATION_ALT_SKILL_ID,
                taskId: task.id,
                traceId: `trace-${task.id}`,
              },
              effectScope: `recommendation:value:${task.history.length}`,
              signal: AbortSignal.timeout(Math.max(1, clock.deadlineMs - Date.now())),
              limits: {
                maxCallCostUsd: String(limitsForSkill(ACCOMMODATION_ALT_SKILL_ID).maxTaskCostUsd),
                maxCallsPerTrip: runtime.serverConfig.maxLlmCallsPerTrip,
                maxCostUsdPerTrip: String(runtime.serverConfig.maxLlmCostUsdPerTrip),
                maxAttemptsPerScope: 2,
                taskMaxCostUsd: String(limitsForSkill(ACCOMMODATION_ALT_SKILL_ID).maxTaskCostUsd),
              },
              rolePrompt: {
                promptVersion: RECOMMENDATION_PROMPT_VERSION,
                systemPrompt: RECOMMENDATION_SYSTEM_PROMPT,
              },
              context,
              allowedIds: facts.map((fact) => fact.id),
              deterministicOrder,
            },
          );
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

        const artifact: AccommodationRecommendations = accommodationRecommendationsSchema.parse({
          correlation: {
            schemaVersion: 1,
            skillId: ACCOMMODATION_ALT_SKILL_ID,
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
            const fact = byId.get(id) as HotelCandidate;
            return {
              hotelOfferId: id,
              partyTotalMinor: fact.partyTotalMinor,
              distanceKm: fact.centerDistanceKm,
              note: `${fact.name}: value-score facts of the delegated snapshot.`,
            };
          }),
          explanations:
            ranking.reasons.length > 0
              ? ranking.reasons.slice(0, 8).map((reason) => reason.explanation)
              : [
                  answerOption === TRADEOFF_OPTION_CENTRAL
                    ? `The traveler chose the centre; ${rankedIds.length} eligible hotel(s) ordered by distance, then price (alternative implementation).`
                    : answerOption === TRADEOFF_OPTION_CHEAPEST
                      ? `The traveler chose the lowest price; ${rankedIds.length} eligible hotel(s) ordered by price, then distance (alternative implementation).`
                      : `Value-scored ${rankedIds.length} eligible hotel(s) by total price and centre distance (alternative implementation).`,
                ],
        });
        const artifactRecord: Artifact = {
          artifactId: randomUUID(),
          name: "accommodation-recommendations",
          description: "Ranked hotel offers of the delegated frozen snapshot (alternative executor)",
          parts: [
            dataPart(artifact, "application/vnd.odft.accommodation-recommendations.v1+json"),
            {
              content: { $case: "text", value: `mode:${ranking.mode};strategy:value` },
              mediaType: "text/plain",
              filename: "",
              metadata: {},
            },
          ],
          metadata: undefined,
          extensions: [],
        };
        session.publishArtifact(artifactRecord);
        await runtime.admission.markSettled({
          messageId: message.messageId,
          taskId: task.id,
          state: "completed",
        });
        session.publishStatus(
          TaskState.TASK_STATE_COMPLETED,
          "accommodation recommendations completed (alternative executor)",
          { mode: ranking.mode, strategy: "value" },
        );
        eventBus.finished();
      } catch (error) {
        await session.publishFailure(
          safeFailureCode(error),
          error instanceof Error ? error.message : "accommodation recommendation failed",
        );
      } finally {
        await accrueActiveTime(runtime.pool, {
          agentIdentity: ACCOMMODATION_ALT_AGENT_IDENTITY,
          taskId: task.id,
          startedAtMs: startedAt,
        }).catch(() => undefined);
      }
    },

    async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
      const control = await getTaskControl(runtime.pool, {
        agentIdentity: ACCOMMODATION_ALT_AGENT_IDENTITY,
        taskId,
      });
      await requestTaskCancellation(runtime.pool, {
        agentIdentity: ACCOMMODATION_ALT_AGENT_IDENTITY,
        taskId,
      });
      await setTaskState(runtime.pool, {
        agentIdentity: ACCOMMODATION_ALT_AGENT_IDENTITY,
        taskId,
        state: "cancelled",
      });
      eventBus.publish({
        kind: "statusUpdate",
        data: {
          taskId,
          contextId: control?.contextId ?? taskId,
          status: {
            state: TaskState.TASK_STATE_CANCELED,
            message: undefined,
            timestamp: new Date().toISOString(),
          },
          metadata: undefined,
        },
      });
      eventBus.finished();
    },
  };
}
