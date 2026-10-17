import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { TaskState, type Artifact, type Message, type Task } from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { rankDeterministically } from "@odft/domain";
import {
  agentTaskRequestSchema,
  cityGuideRecommendationsSchema,
  itineraryProposalSchema,
  itineraryTaskContextSchema,
  type AgentTaskRequest,
  type CityGuideDomainOutcome,
  type CityGuideRecommendations,
  type ItineraryProposal,
  type ResearchDomain,
} from "@odft/contracts";
import { plannerContextSchema } from "@odft/ai";
import { planDelegatedItinerary, type DelegatedItineraryDeps } from "@odft/services";
import {
  assertAuthorityCovers,
  claimDelegationTask,
  getTaskControl,
  loadDelegatedAuthority,
  requestTaskCancellation,
  setTaskState,
} from "@odft/persistence";
import {
  accrueActiveTime,
  countedToolCall,
  createTaskClock,
  createTaskSession,
  dataPart,
  dataPartOf,
  DurableMessageAdmission,
  limitsForSkill,
  McpClient,
  McpClientError,
  safeFailureCode,
  type ProtocolConfig,
  type TaskClock,
  type TaskSession,
} from "@odft/protocols";
import type { ServerConfig } from "@odft/persistence";
import {
  CITY_GUIDE_AGENT_IDENTITY,
  CITY_GUIDE_SKILL_ID,
  ITINERARY_SKILL_ID,
  type CityGuideAgentConfig,
} from "./config.js";

/**
 * Phase 06 City Guide executor (plan §3.11): exact requested meal/activity/
 * event domains over the delegated frozen snapshot, bounded parallel queries
 * (concurrency three) and per-domain outcomes where a completed domain is never
 * discarded because a sibling failed.
 */

export interface CityGuideAgentRuntime {
  readonly config: CityGuideAgentConfig;
  readonly serverConfig: ServerConfig;
  readonly admission: DurableMessageAdmission;
  readonly pool: Pool;
  readonly mcp: McpClient;
  readonly protocol: ProtocolConfig;
  readonly itineraryDeps: DelegatedItineraryDeps;
}

/** Meal/activity/event domains this service researches (never hotel/flights). */
export const CITY_GUIDE_DOMAINS: readonly ResearchDomain[] = [
  "breakfast",
  "lunch",
  "dinner",
  "attractions",
  "events",
];

const QUERY_CONCURRENCY = 3;

interface Fact {
  readonly id: string;
  readonly partyTotalMinor?: number;
}

interface DomainQueryResult {
  readonly outcome: CityGuideDomainOutcome;
  readonly domainHash: string | null;
}

/** Bounded parallel map: at most `limit` in flight, order of `items` preserved. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) {
        return;
      }
      results[index] = await run(item);
    }
  });
  await Promise.all(workers);
  return results;
}

function fingerprintFromQueryContext(queryContext: Record<string, unknown>, domain: string): string | null {
  const map = queryContext.domainInputFingerprints;
  if (map !== null && typeof map === "object") {
    const value = (map as Record<string, unknown>)[domain];
    if (typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) {
      return value;
    }
  }
  return null;
}

export function createCityGuideExecutor(runtime: CityGuideAgentRuntime): AgentExecutor {
  const queryDomain = async (
    domain: ResearchDomain,
    delegationId: string,
    snapshotId: string,
    clock: TaskClock,
    taskId: string,
  ): Promise<DomainQueryResult> => {
    const request =
      domain === "attractions"
        ? { name: "search_attractions", arguments: { delegationId, snapshotId, pageSize: 20 } }
        : domain === "events"
          ? { name: "search_events", arguments: { delegationId, snapshotId, pageSize: 20 } }
          : { name: "search_restaurants", arguments: { delegationId, snapshotId, meal: domain, pageSize: 20 } };
    let page: {
      domainHash?: string;
      error?: string;
      items?: Fact[];
      providerStatus?: string;
      reason?: string | null;
      simulated?: boolean;
    };
    try {
      const result = await countedToolCall({
        mcp: runtime.mcp,
        pool: runtime.pool,
        agentIdentity: CITY_GUIDE_AGENT_IDENTITY,
        taskId,
        clock,
        service: "odft-travel-data",
        name: request.name,
        arguments: request.arguments,
      });
      page = result.structuredContent as typeof page;
    } catch (error) {
      // A tool-level error (unknown/unauthorized domain, transport failure) is
      // an outcome of THIS domain, never a reason to fail its siblings.
      return {
        outcome: {
          domain,
          status: "unsupported",
          rankedOfferIds: [],
          inputFingerprint: null,
          reason: error instanceof Error ? error.message : "the domain query failed",
          simulatedFailure: false,
        },
        domainHash: null,
      };
    }
    if (page.providerStatus !== "ok" || !page.items?.length) {
      // A providerStatus "ok" with zero items (a genuinely empty domain of this
      // snapshot) is reported as `unavailable`: the artifact contract has no
      // distinct "empty" status, and the reason keeps the two distinguishable.
      const status =
        page.providerStatus === "retryable_error"
          ? "retryable_error"
          : page.providerStatus === "unavailable"
            ? "unavailable"
            : page.providerStatus === "unsupported" || page.error
              ? "unsupported"
              : "unavailable";
      return {
        outcome: {
          domain,
          status,
          rankedOfferIds: [],
          inputFingerprint: null,
          reason: page.error ?? page.reason ?? `the ${domain} query returned no usable result`,
          simulatedFailure: page.simulated === true,
        },
        domainHash: page.domainHash ?? null,
      };
    }
    // Deterministic ranking only: meals by price then id; attractions keep the
    // preference/reference order the read service already applies; events by id.
    const ids =
      domain === "attractions" || domain === "events"
        ? page.items.map((item) => item.id)
        : rankDeterministically(
            page.items.map((item) => ({ id: item.id, partyTotalMinor: item.partyTotalMinor ?? 0 })),
          );
    return {
      outcome: {
        domain,
        status: "ok",
        rankedOfferIds: ids,
        inputFingerprint: null,
        reason: null,
        simulatedFailure: false,
      },
      domainHash: page.domainHash ?? null,
    };
  };

  /**
   * Phase 08 itinerary skill: one application planning attempt. Candidate facts
   * and the deterministic preflight come from the authorized MCP tools; the
   * planner is a single delegated call. The coordinator remains authoritative
   * for assembly, validation and the review decision policy.
   */
  const runItinerary = async (input: {
    data: AgentTaskRequest;
    task: Task;
    message: Message;
    session: TaskSession;
    eventBus: ExecutionEventBus;
    startedAtMs: number;
  }): Promise<void> => {
    const { data, task, session } = input;
    const parsedContext = itineraryTaskContextSchema.safeParse(data.queryContext.itinerary);
    if (!parsedContext.success) {
      const issue = parsedContext.error.issues[0];
      await session.publishFailure(
        "INVALID_ARTIFACT",
        `the itinerary task context is missing or malformed: ${
          issue ? `${issue.path.join(".")}: ${issue.message}` : "unknown issue"
        }`.slice(0, 300),
      );
      return;
    }
    const context = parsedContext.data;
    const plannerContext = plannerContextSchema.safeParse(context.plannerContext);
    if (!plannerContext.success) {
      await session.publishFailure(
        "INVALID_ARTIFACT",
        "the itinerary planner context does not match the planner role contract",
      );
      return;
    }

    let authority = await loadDelegatedAuthority(runtime.pool, {
      agentIdentity: CITY_GUIDE_AGENT_IDENTITY,
      delegationId: data.delegationId,
    });
    if (!authority.taskId) {
      await claimDelegationTask(runtime.pool, {
        delegationId: authority.delegationId,
        agentIdentity: CITY_GUIDE_AGENT_IDENTITY,
        taskId: task.id,
      });
      authority = await loadDelegatedAuthority(runtime.pool, {
        agentIdentity: CITY_GUIDE_AGENT_IDENTITY,
        delegationId: data.delegationId,
      });
    }
    assertAuthorityCovers(authority, {
      snapshotId: data.snapshot.snapshotId,
      taskId: task.id,
    });
    if (!authority.scope.allowItinerary) {
      await session.publishFailure(
        "DELEGATION_REVOKED",
        "the delegation does not allow itinerary work",
      );
      return;
    }

    const clock = await createTaskClock({
      pool: runtime.pool,
      agentIdentity: CITY_GUIDE_AGENT_IDENTITY,
      taskId: task.id,
      skillId: ITINERARY_SKILL_ID,
      startedAtMs: input.startedAtMs,
    });
    clock.assertNow({ mcpInvocation: true });
    session.publishStatus(TaskState.TASK_STATE_WORKING, "MCP discovery: itinerary candidates");

    const structured = <T>(result: { isError?: boolean; structuredContent?: unknown }): T => {
      if (result.isError || result.structuredContent === undefined) {
        throw new McpClientError("MCP_UNAVAILABLE", "the MCP tool returned no usable result");
      }
      return result.structuredContent as T;
    };

    await countedToolCall({
      mcp: runtime.mcp,
      pool: runtime.pool,
      agentIdentity: CITY_GUIDE_AGENT_IDENTITY,
      taskId: task.id,
      clock,
      service: "odft-travel-data",
      name: "get_scenario_metadata",
      arguments: { delegationId: authority.delegationId, snapshotId: authority.snapshotId },
    });

    // Candidate/reference facts come from the authorized frozen snapshot. The
    // planner's membership is enforced against the compact planner context by
    // the delegated planner runtime; the MCP page check only proves the domain
    // is available for the deterministic preflight.
    const assertPageOk = (page: { providerStatus?: string }): void => {
      if (page.providerStatus !== "ok") {
        throw new McpClientError("MCP_UNAVAILABLE", "a candidate domain is unavailable on the snapshot");
      }
    };
    assertPageOk(
      structured(
        await countedToolCall({
          mcp: runtime.mcp,
          pool: runtime.pool,
          agentIdentity: CITY_GUIDE_AGENT_IDENTITY,
          taskId: task.id,
          clock,
          service: "odft-travel-data",
          name: "search_attractions",
          arguments: { delegationId: authority.delegationId, snapshotId: authority.snapshotId, pageSize: 50 },
        }),
      ),
    );
    for (const meal of ["breakfast", "lunch", "dinner"] as const) {
      if (context.toolContext.mealSelections[meal] === null) {
        continue;
      }
      assertPageOk(
        structured(
          await countedToolCall({
            mcp: runtime.mcp,
            pool: runtime.pool,
            agentIdentity: CITY_GUIDE_AGENT_IDENTITY,
            taskId: task.id,
            clock,
            service: "odft-travel-data",
            name: "search_restaurants",
            arguments: {
              delegationId: authority.delegationId,
              snapshotId: authority.snapshotId,
              meal,
              pageSize: 50,
            },
          }),
        ),
      );
    }

    clock.assertNow({ llmAttempt: true });
    const taskLimits = limitsForSkill(ITINERARY_SKILL_ID);
    const planned = await planDelegatedItinerary(
      runtime.pool,
      runtime.serverConfig,
      runtime.itineraryDeps,
      {
        authority: {
          kind: "delegation",
          delegationId: authority.delegationId,
          agentIdentity: CITY_GUIDE_AGENT_IDENTITY,
          skillId: ITINERARY_SKILL_ID,
          taskId: task.id,
          traceId: data.traceId,
        },
        effectScope: `itinerary:${context.attempt}`,
        signal: AbortSignal.timeout(Math.max(1, clock.deadlineMs - Date.now())),
        limits: {
          // The role ceiling is stricter than the task ceiling; the delegated
          // reservation must never exceed the planner profile's call cap.
          maxCallCostUsd: runtime.itineraryDeps.paidPlannerProfile?.maxCallCostUsd ?? "0.20",
          maxCallsPerTrip: runtime.serverConfig.maxLlmCallsPerTrip,
          maxCostUsdPerTrip: String(runtime.serverConfig.maxLlmCostUsdPerTrip),
          maxAttemptsPerScope: 2,
          taskMaxCostUsd: String(taskLimits.maxTaskCostUsd),
        },
        context: plannerContext.data,
        allowedIds: plannerContext.data.candidates.map((candidate) => candidate.id),
      },
    );

    session.publishStatus(TaskState.TASK_STATE_WORKING, "MCP preflight: validate itinerary");
    const preflight = structured<{
      status: "valid" | "invalid";
      errors: { code: string; message: string }[];
      warnings: { code: string; message: string }[];
    }>(
      await countedToolCall({
        mcp: runtime.mcp,
        pool: runtime.pool,
        agentIdentity: CITY_GUIDE_AGENT_IDENTITY,
        taskId: task.id,
        clock,
        service: "odft-itinerary-tools",
        name: "validate_itinerary",
        arguments: {
          delegationId: authority.delegationId,
          snapshotId: authority.snapshotId,
          context: context.toolContext,
          stops: planned.output.stops.map((stop) => ({
            kind: stop.kind,
            refId: stop.kind === "meal" || stop.kind === "activity" ? stop.refId : null,
            startMinute: stop.startMinute,
            durationMinutes: stop.durationMinutes,
          })),
        },
      }),
    );

    if (await session.cancellationRequested()) {
      await session.publishCancelled();
      return;
    }

    const candidateById = new Map(
      plannerContext.data.candidates.map((candidate) => [candidate.id, candidate]),
    );
    const mealRefs: { breakfast: string | null; lunch: string | null; dinner: string | null } = {
      breakfast: null,
      lunch: null,
      dinner: null,
    };
    for (const stop of planned.output.stops) {
      if (stop.kind !== "meal" || !stop.refId) {
        continue;
      }
      const candidate = candidateById.get(stop.refId);
      if (candidate?.kind === "meal" && candidate.meal) {
        mealRefs[candidate.meal] = stop.refId;
      }
    }
    const findings = [...preflight.errors, ...preflight.warnings]
      .slice(0, 16)
      .map((finding) => ({
        code: finding.code,
        explanation: finding.message.slice(0, 400),
        offerIds: [],
      }));
    const artifact: ItineraryProposal = itineraryProposalSchema.parse({
      correlation: {
        schemaVersion: 1,
        skillId: ITINERARY_SKILL_ID,
        tripId: data.tripId,
        operationId: data.operationId,
        acceptedRevision: data.acceptedRevision,
        delegationId: authority.delegationId,
        traceId: `trace-${task.id}`,
        snapshotId: authority.snapshotId,
        scenarioKey: data.snapshot.scenarioKey,
        inputFingerprint: data.inputFingerprint,
        domainFingerprints: data.snapshot.domainFingerprints,
      },
      attempt: context.attempt,
      candidateIds: plannerContext.data.candidates.map((candidate) => candidate.id),
      stops: planned.output.stops.map((stop) => ({
        kind: stop.kind,
        refId: stop.kind === "meal" || stop.kind === "activity" ? stop.refId : null,
        startMinute: stop.startMinute,
        durationMinutes: stop.durationMinutes,
      })),
      mealRefs,
      review: {
        verdict: preflight.status === "valid" ? "acceptable" : "conflict",
        issueCount: preflight.errors.length + preflight.warnings.length,
        findings,
      },
    });
    session.publishArtifact({
      artifactId: randomUUID(),
      name: "itinerary-proposal",
      description: "Planner-compatible sightseeing day over the delegated frozen snapshot",
      parts: [
        dataPart(artifact, "application/vnd.odft.itinerary-proposal.v1+json"),
        {
          content: {
            $case: "text",
            value: `stops:${artifact.stops.length} preflight:${preflight.status}`,
          },
          mediaType: "text/plain",
          filename: "",
          metadata: {},
        },
      ],
      metadata: undefined,
      extensions: [],
    });
    await runtime.admission.markSettled({
      messageId: input.message.messageId,
      taskId: task.id,
      state: "completed",
    });
    session.publishStatus(TaskState.TASK_STATE_COMPLETED, "city guide itinerary proposal completed", {
      stops: artifact.stops.length,
      preflight: preflight.status,
      mode: planned.mode,
    });
    input.eventBus.finished();
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
        agentIdentity: CITY_GUIDE_AGENT_IDENTITY,
        eventBus,
        admission: runtime.admission,
        task,
        messageId: message.messageId,
      });

      eventBus.publish({
        kind: "task",
        data: {
          ...task,
          status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: new Date().toISOString() },
        },
      });

      await runtime.admission.markWorking(task.id);
      try {
        const request = agentTaskRequestSchema.safeParse(dataPartOf(message));
        if (!request.success) {
          await session.publishFailure("INVALID_ARTIFACT", "the task request is not a valid city guide request");
          return;
        }
        const data = request.data;
        if (data.skillId === ITINERARY_SKILL_ID) {
          await runItinerary({ data, task, message, session, eventBus, startedAtMs: startedAt });
          return;
        }
        if (data.skillId !== CITY_GUIDE_SKILL_ID) {
          await session.publishFailure("INVALID_ARTIFACT", "the task request is not a valid city guide request");
          return;
        }
        // Preserve the EXACT requested domains (order + duplicates removed):
        // domains outside this skill become explicit `unsupported` outcomes,
        // they are never dropped from the artifact.
        const requestedDomains = [...new Set(data.requestedDomains)];
        const serviceableDomains = CITY_GUIDE_DOMAINS.filter((domain) =>
          requestedDomains.includes(domain),
        );
        if (serviceableDomains.length === 0) {
          await session.publishFailure(
            "INVALID_ARTIFACT",
            "the request names no meal, activity or event domain",
          );
          return;
        }

        let authority = await loadDelegatedAuthority(runtime.pool, {
          agentIdentity: CITY_GUIDE_AGENT_IDENTITY,
          delegationId: data.delegationId,
        });
        if (!authority.taskId) {
          await claimDelegationTask(runtime.pool, {
            delegationId: authority.delegationId,
            agentIdentity: CITY_GUIDE_AGENT_IDENTITY,
            taskId: task.id,
          });
          authority = await loadDelegatedAuthority(runtime.pool, {
            agentIdentity: CITY_GUIDE_AGENT_IDENTITY,
            delegationId: data.delegationId,
          });
        }
        // Every serviceable requested domain must be inside the delegated scope
        // before any work: querying outside it is an authority violation.
        for (const domain of serviceableDomains) {
          assertAuthorityCovers(authority, { domain });
        }
        assertAuthorityCovers(authority, {
          snapshotId: data.snapshot.snapshotId,
          taskId: task.id,
        });

        const clock = await createTaskClock({
          pool: runtime.pool,
          agentIdentity: CITY_GUIDE_AGENT_IDENTITY,
          taskId: task.id,
          skillId: CITY_GUIDE_SKILL_ID,
          startedAtMs: startedAt,
        });
        clock.assertNow({ mcpInvocation: true });
        session.publishStatus(
          TaskState.TASK_STATE_WORKING,
          `MCP discovery: travel-data ${serviceableDomains.join(", ")}`,
        );
        await countedToolCall({
          mcp: runtime.mcp,
          pool: runtime.pool,
          agentIdentity: CITY_GUIDE_AGENT_IDENTITY,
          taskId: task.id,
          clock,
          service: "odft-travel-data",
          name: "get_scenario_metadata",
          arguments: { delegationId: authority.delegationId, snapshotId: authority.snapshotId },
        });
        if (runtime.config.stepDelayMs > 0) {
          // Test-only hook: widen the observable working window.
          await new Promise((resolve) => setTimeout(resolve, runtime.config.stepDelayMs));
        }

        // Bounded parallel domain queries: a completed domain is kept even when
        // a sibling fails (no all-domains-success barrier).
        const results = await mapBounded(requestedDomains, QUERY_CONCURRENCY, (domain) =>
          CITY_GUIDE_DOMAINS.includes(domain)
            ? queryDomain(domain, authority.delegationId, authority.snapshotId, clock, task.id)
            : Promise.resolve({
                outcome: {
                  domain,
                  status: "unsupported" as const,
                  rankedOfferIds: [],
                  inputFingerprint: null,
                  reason: `the ${domain} domain is outside this service's meal/activity/event scope`,
                  simulatedFailure: false,
                },
                domainHash: null,
              }),
        );
        const okCount = results.filter((result) => result.outcome.status === "ok").length;
        if (okCount === 0) {
          await session.publishFailure(
            "MCP_UNAVAILABLE",
            "no requested domain produced a usable result on the delegated snapshot",
          );
          return;
        }
        if (await session.cancellationRequested()) {
          await session.publishCancelled();
          return;
        }

        const domainFingerprints: Record<string, string> = {};
        for (const result of results) {
          if (result.domainHash) {
            domainFingerprints[result.outcome.domain] = result.domainHash;
          }
        }
        const outcomes = results.map((result) => ({
          ...result.outcome,
          inputFingerprint: fingerprintFromQueryContext(data.queryContext, result.outcome.domain),
        }));
        const artifact: CityGuideRecommendations = cityGuideRecommendationsSchema.parse({
          correlation: {
            schemaVersion: 1,
            skillId: CITY_GUIDE_SKILL_ID,
            tripId: data.tripId,
            operationId: data.operationId,
            acceptedRevision: data.acceptedRevision,
            delegationId: authority.delegationId,
            traceId: `trace-${task.id}`,
            snapshotId: authority.snapshotId,
            scenarioKey: data.snapshot.scenarioKey,
            inputFingerprint: data.inputFingerprint,
            domainFingerprints,
          },
          outcomes,
          findings: results
            .filter((result) => result.outcome.status !== "ok")
            .map((result) => ({
              code: `CITY_GUIDE_${result.outcome.status.toUpperCase()}`,
              explanation: result.outcome.reason ?? `the ${result.outcome.domain} domain is unavailable`,
              offerIds: [],
            })),
        });
        const artifactRecord: Artifact = {
          artifactId: randomUUID(),
          name: "city-guide-recommendations",
          description: "Per-domain research outcomes of the delegated frozen snapshot",
          parts: [
            dataPart(artifact, "application/vnd.odft.city-guide-recommendations.v1+json"),
            {
              content: { $case: "text", value: `domains:${okCount}/${requestedDomains.length}` },
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
          "city guide research completed",
          { domains: requestedDomains.length, available: okCount },
        );
        eventBus.finished();
      } catch (error) {
        await session.publishFailure(
          safeFailureCode(error),
          error instanceof Error ? error.message : "city guide research failed",
        );
      } finally {
        await accrueActiveTime(runtime.pool, {
          agentIdentity: CITY_GUIDE_AGENT_IDENTITY,
          taskId: task.id,
          startedAtMs: startedAt,
        }).catch(() => undefined);
      }
    },

    async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
      const control = await getTaskControl(runtime.pool, {
        agentIdentity: CITY_GUIDE_AGENT_IDENTITY,
        taskId,
      });
      await requestTaskCancellation(runtime.pool, { agentIdentity: CITY_GUIDE_AGENT_IDENTITY, taskId });
      await setTaskState(runtime.pool, {
        agentIdentity: CITY_GUIDE_AGENT_IDENTITY,
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
