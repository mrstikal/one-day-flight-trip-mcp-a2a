import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { Role, TaskState, type Artifact, type Message, type Part } from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { AdapterError } from "@odft/ai";
import {
  agentTaskRequestSchema,
  flightRecommendationsSchema,
  type FlightRecommendations,
} from "@odft/contracts";
import {
  assertAuthorityCovers,
  claimDelegationTask,
  DelegatedAuthorityError,
  getTaskControl,
  loadDelegatedAuthority,
  requestTaskCancellation,
  setTaskState,
} from "@odft/persistence";
import {
  accrueActiveTime,
  assertAllowance,
  countMcpInvocation,
  DurableMessageAdmission,
  limitsForSkill,
  loadTaskAllowance,
  McpClient,
  McpClientError,
  TaskLimitError,
  type ProtocolConfig,
} from "@odft/protocols";
import {
  createDelegatedFlightRanker,
  deterministicFlightOrder,
  DelegatedCallError,
  type DelegatedFlightRankingDeps,
  type DelegatedFlightRankingResult,
} from "@odft/services";
import type { ServerConfig } from "@odft/persistence";
import { FLIGHT_AGENT_IDENTITY, FLIGHT_SKILL_ID, type FlightAgentConfig } from "./config.js";

/**
 * Phase 05 flight executor: durable admission, real MCP reads, deterministic
 * initial ranking, an optional governed reorder (permutation/subset validated
 * with safe fallback), cumulative task limits and the §3.9 lifecycle.
 */

export interface FlightAgentRuntime {
  readonly config: FlightAgentConfig;
  readonly serverConfig: ServerConfig;
  readonly admission: DurableMessageAdmission;
  readonly pool: Pool;
  readonly mcp: McpClient;
  readonly protocol: ProtocolConfig;
  /** Paid-path wiring (openrouter mode): delegated profile + governor-free adapter. */
  readonly rankingDeps?: DelegatedFlightRankingDeps;
}

function dataPartOf(message: Message): unknown {
  for (const part of message.parts) {
    if (part.content?.$case === "data" && part.content.value !== undefined) {
      return part.content.value;
    }
  }
  return undefined;
}

function agentMessage(taskId: string, contextId: string, text: string): Message {
  return {
    messageId: randomUUID(),
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: [{ content: { $case: "text", value: text }, mediaType: "text/plain", filename: "", metadata: {} }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function dataPart(value: unknown, mediaType: string): Part {
  return { content: { $case: "data", value }, mediaType, filename: "", metadata: {} };
}

interface FlightCandidateFact {
  readonly id: string;
  readonly partyTotalMinor: number;
  readonly perAdultMinor: number;
  readonly totalDurationMinutes: number;
  readonly stops: number;
  readonly outboundDeparture: string;
  readonly outboundArrival: string;
  readonly inboundDeparture: string;
  readonly inboundArrival: string;
  readonly supportedVariants: ("one_night" | "two_nights")[];
}

export function createFlightExecutor(runtime: FlightAgentRuntime): AgentExecutor {
  const ranker = createDelegatedFlightRanker(runtime.pool, runtime.serverConfig, runtime.rankingDeps);

  const deterministicOrder = deterministicFlightOrder;

  return {
    async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
      const message = requestContext.userMessage;
      const task = requestContext.task;
      if (!task) {
        throw new Error("admission must have committed the canonical task");
      }
      const startedAt = Date.now();
      const publishFailure = async (code: string, reason: string): Promise<void> => {
        eventBus.publish({
          kind: "statusUpdate",
          data: {
            taskId: task.id,
            contextId: task.contextId,
            status: {
              state: TaskState.TASK_STATE_FAILED,
              message: agentMessage(task.id, task.contextId, reason),
              timestamp: new Date().toISOString(),
            },
            metadata: { failureCode: code },
          },
        });
        eventBus.finished();
        await runtime.admission.markSettled({
          messageId: message.messageId,
          taskId: task.id,
          state: "failed",
        });
      };
      // Local revocation check: a cancellation accepted while this invocation
      // runs stops it before any late artifact or completion is published.
      const cancellationRequested = async (): Promise<boolean> => {
        const control = await getTaskControl(runtime.pool, {
          agentIdentity: FLIGHT_AGENT_IDENTITY,
          taskId: task.id,
        });
        return Boolean(control?.cancelRequestedAt) || control?.state === "cancelled";
      };
      const publishCancelled = async (): Promise<void> => {
        eventBus.publish({
          kind: "statusUpdate",
          data: {
            taskId: task.id,
            contextId: task.contextId,
            status: {
              state: TaskState.TASK_STATE_CANCELED,
              message: undefined,
              timestamp: new Date().toISOString(),
            },
            metadata: undefined,
          },
        });
        eventBus.finished();
      };

      // 1. Initial task event is mandatory for every invocation.
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
          process.stderr.write("flight-agent: simulated crash before work\n");
          process.exit(3);
        }

        const request = agentTaskRequestSchema.safeParse(dataPartOf(message));
        if (!request.success || request.data.skillId !== FLIGHT_SKILL_ID) {
          await publishFailure("INVALID_ARTIFACT", "the task request is not a valid flight recommendation request");
          return;
        }
        let authority = await loadDelegatedAuthority(runtime.pool, {
          agentIdentity: FLIGHT_AGENT_IDENTITY,
          delegationId: request.data.delegationId,
        });
        if (!authority.taskId) {
          // First use claims the canonical task binding; a different existing
          // binding is refused by the helper.
          await claimDelegationTask(runtime.pool, {
            delegationId: authority.delegationId,
            agentIdentity: FLIGHT_AGENT_IDENTITY,
            taskId: task.id,
          });
          authority = await loadDelegatedAuthority(runtime.pool, {
            agentIdentity: FLIGHT_AGENT_IDENTITY,
            delegationId: request.data.delegationId,
          });
        }
        assertAuthorityCovers(authority, {
          domain: "flights",
          snapshotId: request.data.snapshot.snapshotId,
          taskId: task.id,
        });

        // 2. Real MCP discovery/read of the delegated frozen snapshot.
        let allowance = await loadTaskAllowance(runtime.pool, {
          agentIdentity: FLIGHT_AGENT_IDENTITY,
          taskId: task.id,
          skillId: FLIGHT_SKILL_ID,
        });
        assertAllowance(allowance, { mcpInvocation: true, activeTime: true });
        // Remaining active-execution allowance: asserted before every step, and
        // the paid attempt additionally aborts at this deadline, so no single
        // step can run past the 60-second cap. MCP calls stay bounded by the
        // client's own 5-second timeout.
        const deadlineMs = startedAt + allowance.remainingActiveMs;
        const assertWithinActiveTime = (): void => {
          if (Date.now() > deadlineMs) {
            throw new TaskLimitError("the task active-execution allowance is exhausted");
          }
        };
        eventBus.publish({
          kind: "statusUpdate",
          data: {
            taskId: task.id,
            contextId: task.contextId,
            status: {
              state: TaskState.TASK_STATE_WORKING,
              message: agentMessage(task.id, task.contextId, "MCP discovery: travel-data search_flights"),
              timestamp: new Date().toISOString(),
            },
            metadata: undefined,
          },
        });
        await runtime.mcp.callTool("odft-travel-data", {
          name: "get_scenario_metadata",
          arguments: { delegationId: authority.delegationId, snapshotId: authority.snapshotId },
        });
        await countMcpInvocation(runtime.pool, { agentIdentity: FLIGHT_AGENT_IDENTITY, taskId: task.id });
        // Reload the counters before each invocation: the allowance snapshot is
        // never stale, so the 4-invocation cap cannot be exceeded by one.
        allowance = await loadTaskAllowance(runtime.pool, {
          agentIdentity: FLIGHT_AGENT_IDENTITY,
          taskId: task.id,
          skillId: FLIGHT_SKILL_ID,
        });
        assertAllowance(allowance, { mcpInvocation: true, activeTime: true });
        assertWithinActiveTime();
        const flightsPage = await runtime.mcp.callTool("odft-travel-data", {
          name: "search_flights",
          arguments: {
            delegationId: authority.delegationId,
            snapshotId: authority.snapshotId,
            pageSize: 20,
          },
        });
        await countMcpInvocation(runtime.pool, { agentIdentity: FLIGHT_AGENT_IDENTITY, taskId: task.id });
        const page = flightsPage.structuredContent as {
          domainHash?: string;
          error?: string;
          items?: {
            id: string;
            partyTotalMinor: number;
            perAdultMinor: number;
            supportedVariants: ("one_night" | "two_nights")[];
            outbound: { departureInstant: string; arrivalInstant: string; durationMinutes: number }[];
            inbound: { departureInstant: string; arrivalInstant: string; durationMinutes: number }[];
          }[];
          providerStatus?: string;
          reason?: string | null;
        };
        if (page.providerStatus !== "ok" || !page.items?.length) {
          // A tool-level error (`isError`) carries the real reason; never hide it.
          await publishFailure(
            "AGENT_UNAVAILABLE",
            page.error
              ? `the delegated flight query failed: ${page.error}`
              : `the delegated flight query returned no usable combinations (${page.providerStatus ?? "unknown"}${page.reason ? `: ${page.reason}` : ""})`,
          );
          return;
        }
        if (!page.domainHash) {
          // Never write a fabricated correlation fingerprint into an artifact.
          await publishFailure(
            "INVALID_ARTIFACT",
            "the delegated flight query returned no flights domain content hash",
          );
          return;
        }
        const candidates: FlightCandidateFact[] = page.items.map((item) => ({
          id: item.id,
          partyTotalMinor: item.partyTotalMinor,
          perAdultMinor: item.perAdultMinor,
          totalDurationMinutes:
            item.outbound.reduce((total, segment) => total + segment.durationMinutes, 0) +
            item.inbound.reduce((total, segment) => total + segment.durationMinutes, 0),
          stops: Math.max(0, item.outbound.length - 1 + item.inbound.length - 1),
          outboundDeparture: item.outbound[0]?.departureInstant ?? "",
          outboundArrival: item.outbound[item.outbound.length - 1]?.arrivalInstant ?? "",
          inboundDeparture: item.inbound[0]?.departureInstant ?? "",
          inboundArrival: item.inbound[item.inbound.length - 1]?.arrivalInstant ?? "",
          supportedVariants: item.supportedVariants,
        }));

        // 3. Deterministic initial ranking, then the optional governed reorder.
        assertWithinActiveTime();
        if (await cancellationRequested()) {
          await publishCancelled();
          return;
        }
        const initialOrder = deterministicOrder(candidates);
        let ranking: DelegatedFlightRankingResult = {
          rankedOfferIds: initialOrder,
          reasons: [],
          mode: "fixture",
          fallbackUsed: false,
        };
        if (candidates.length > 1 && allowance.remainingLlm > 0) {
          const traceId = `trace-${task.id}`;
          ranking = await ranker.rank({
            authority: {
              kind: "delegation",
              delegationId: authority.delegationId,
              agentIdentity: FLIGHT_AGENT_IDENTITY,
              skillId: FLIGHT_SKILL_ID,
              taskId: task.id,
              traceId,
            },
            tradeoff: "best price for the delegated snapshot",
            baselineOfferId: null,
            candidates: candidates.map((candidate) => ({ ...candidate })),
            effectScope: `recommendation:${task.history.length}`,
            signal: AbortSignal.timeout(Math.max(1, deadlineMs - Date.now())),
            limits: {
              maxCallCostUsd: String(limitsForSkill(FLIGHT_SKILL_ID).maxTaskCostUsd),
              maxCallsPerTrip: runtime.serverConfig.maxLlmCallsPerTrip,
              maxCostUsdPerTrip: String(runtime.serverConfig.maxLlmCostUsdPerTrip),
              maxAttemptsPerScope: 2,
              taskMaxCostUsd: String(limitsForSkill(FLIGHT_SKILL_ID).maxTaskCostUsd),
            },
          });
        }
        const rankedIds = ranking.rankedOfferIds.filter((id) =>
          candidates.some((candidate) => candidate.id === id),
        );
        if (rankedIds.length === 0) {
          await publishFailure("INVALID_ARTIFACT", "the ranking contained no usable combination");
          return;
        }
        // Final local revocation check before the artifact is published.
        if (await cancellationRequested()) {
          await publishCancelled();
          return;
        }

        // 4. Validated artifact, persisted before completion.
        const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
        const artifact: FlightRecommendations = flightRecommendationsSchema.parse({
          correlation: {
            schemaVersion: 1,
            skillId: FLIGHT_SKILL_ID,
            tripId: request.data.tripId,
            operationId: request.data.operationId,
            acceptedRevision: request.data.acceptedRevision,
            delegationId: authority.delegationId,
            traceId: `trace-${task.id}`,
            snapshotId: authority.snapshotId,
            scenarioKey: request.data.snapshot.scenarioKey,
            inputFingerprint: request.data.inputFingerprint,
            domainFingerprints: { flights: page.domainHash },
          },
          rankedCombinationIds: rankedIds,
          findings: [],
          priceFacts: rankedIds.map((id) => ({
            combinationId: id,
            partyTotalMinor: byId.get(id)?.partyTotalMinor ?? 0,
            currency: "EUR" as const,
          })),
          explanations:
            ranking.reasons.length > 0
              ? ranking.reasons.slice(0, 8).map((reason) => reason.explanation)
              : [
                  `Deterministic ranking of ${rankedIds.length} schedule-valid combination(s) by price, then travel time.`,
                ],
          reorderNote: ranking.fallbackUsed
            ? "The governed reorder output was rejected; the deterministic order was kept."
            : null,
        });
        const artifactRecord: Artifact = {
          artifactId: randomUUID(),
          name: "flight-recommendations",
          description: "Ranked schedule-valid flight combinations of the delegated snapshot",
          parts: [
            dataPart(artifact, "application/vnd.odft.flight-recommendations.v1+json"),
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
        eventBus.publish({
          kind: "artifactUpdate",
          data: {
            taskId: task.id,
            contextId: task.contextId,
            artifact: artifactRecord,
            append: false,
            lastChunk: true,
            metadata: undefined,
          },
        });
        eventBus.publish({
          kind: "statusUpdate",
          data: {
            taskId: task.id,
            contextId: task.contextId,
            status: {
              state: TaskState.TASK_STATE_COMPLETED,
              message: agentMessage(task.id, task.contextId, "flight recommendations completed"),
              timestamp: new Date().toISOString(),
            },
            metadata: { mode: ranking.mode },
          },
        });
        eventBus.finished();
        await runtime.admission.markSettled({
          messageId: message.messageId,
          taskId: task.id,
          state: "completed",
        });
      } catch (error) {
        const code =
          error instanceof DelegatedAuthorityError
            ? error.code
            : error instanceof TaskLimitError
              ? error.code
              : error instanceof McpClientError
                ? error.code
                : error instanceof DelegatedCallError
                  ? error.code
                  : error instanceof AdapterError
                    ? error.code
                    : "INTERNAL_ERROR";
        await publishFailure(code, error instanceof Error ? error.message : "flight recommendation failed");
      } finally {
        await accrueActiveTime(runtime.pool, {
          agentIdentity: FLIGHT_AGENT_IDENTITY,
          taskId: task.id,
          startedAtMs: startedAt,
        }).catch(() => undefined);
      }
    },

    async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
      // Local revocation BEFORE the SDK processes the CANCELED event: the
      // control row records the request so a concurrently running invocation
      // stops before publishing a late artifact or completion.
      const control = await getTaskControl(runtime.pool, {
        agentIdentity: FLIGHT_AGENT_IDENTITY,
        taskId,
      });
      await requestTaskCancellation(runtime.pool, { agentIdentity: FLIGHT_AGENT_IDENTITY, taskId });
      await setTaskState(runtime.pool, {
        agentIdentity: FLIGHT_AGENT_IDENTITY,
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
