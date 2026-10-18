import type { Pool, PoolClient } from "pg";
import {
  domainCommandSchema,
  chatCommandPayloadSchema,
  researchDomainSchema,
  SCENARIO_DOMAIN_FOR_RESEARCH,
  tripPreferencesSchema,
  type CoordinatorRunData,
  type DomainCommand,
  type Meal,
  type MealSelections,
  type ResearchDomain,
  type ResearchSearchIntent,
  type TripPreferences,
  type TripRecord,
} from "@odft/contracts";
import { fingerprint } from "@odft/domain";
import {
  acceptDelegationArtifact,
  appendConversationMessage,
  contentHash,
  finalizeConflict,
  finalizeFailure,
  StaleFencingError,
  finalizeSuccess,
  finalizeWaiting,
  getActiveCoordinatorRun,
  getAgentDelegation,
  getCoordinatorRun,
  getPendingDecisionForTrip,
  getProposal,
  getReservationByConfirmationKey,
  getTrip,
  insertConversationMessage,
  insertCoordinatorRun,
  listLatestRecommendationArtifacts,
  loadDecision,
  MAX_AUTO_CLAIMS_PER_ROUND,
  updateCoordinatorRun,
  type ClaimedOperation,
  type CoordinatorRunRecord,
} from "@odft/persistence";
import type { TravelPorts } from "./ports.js";
import { orderCommandsForApplication } from "../routing/command-order.js";
import { resolveCommandRouting, routingRefs } from "../routing/invalidation-matrix.js";
import {
  acceptArtifact,
  buildFlightTaskRequest,
  createOutboundDelegation,
  deliverDelegation,
  insertContinuationOutbound,
  loadDelegationDelivery,
  newTraceId,
  type CoordinatorDelegationTransport,
} from "./delegations.js";
import {
  initialCoordinatorRunData,
  type CoordinatorRunDataInput,
  type CoordinatorTransitionResult,
} from "./state.js";
import {
  pollItineraryAttempt,
  startItineraryAttempt,
  type ItineraryLoopDeps,
} from "./itinerary.js";

function safeErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  if (error instanceof Error) {
    return error.name === "InvalidUpdateError" ? "REDUCER_CONFLICT" : error.name;
  }
  return "UNKNOWN";
}

/**
 * Deterministic failures that a retry can never fix. AI failures are terminal:
 * the adapter already owns its single repair attempt, so a second orchestration
 * retry would stack billable calls on the same message.
 */
const TERMINAL_CONFLICT_CODES: ReadonlySet<string> = new Set([
  "REDUCER_CONFLICT",
  "STALE_DECISION",
  "STALE_REVISION",
  "STALE_ROUTE_APPROVAL",
  "PROPOSAL_EXPIRED",
  "PROPOSAL_SUPERSEDED",
  "OFFER_UNAVAILABLE",
  "OFFER_MISMATCH",
  "DISCLAIMER_REQUIRED",
  "REPLACEMENT_CONFIRMATION_REQUIRED",
  "CREATION_CONFLICT",
  "VALIDATION_FAILED",
  "CONFLICT",
  "FORBIDDEN",
  "NOT_FOUND",
  "REF_GENERATION_FAILED",
  "ITINERARY_NOT_APPROVABLE",
  "STALE_ITINERARY",
  "AI_NOT_CONFIGURED",
  "AI_CAPABILITY_UNKNOWN",
  "AI_BUDGET_EXCEEDED",
  "AI_PRICING_UNKNOWN",
  "AI_AUTH_FAILED",
  "AI_UNSUPPORTED",
  "AI_INPUT_OVERFLOW",
  "AI_SCHEMA_INVALID",
  "AI_TIMEOUT",
  "AI_TRANSPORT_FAILED",
]);

export function isTerminalConflictCode(code: string): boolean {
  return TERMINAL_CONFLICT_CODES.has(code);
}

function isChatOperation(claim: ClaimedOperation): boolean {
  const payload = claim.payload as { kind?: unknown } | null;
  return claim.kind === "command" && payload?.kind === "chat";
}

/**
 * Phase 07 coordinator dispatcher: runs one claimed coordinator operation
 * through its step handlers until it parks, completes or fails. Every state
 * change is persisted in a short fenced transaction (analysis §4); network
 * calls (delegation delivery, task reads) never run inside a transaction.
 */

export interface CoordinatorAgentBinding {
  readonly agentIdentity: string;
  readonly endpointUrl: string;
  readonly skillId: string;
  readonly cardVersion: string;
}

export interface CoordinatorDispatchDeps {
  readonly pool: Pool;
  readonly transport: CoordinatorDelegationTransport;
  /** Ports bound to the claimed operation's fenced authority. */
  readonly ports: TravelPorts;
  /** Trusted specialist bindings (from the trusted registry). */
  readonly agents: {
    readonly flight: CoordinatorAgentBinding;
    readonly accommodation?: CoordinatorAgentBinding;
    readonly cityGuide?: CoordinatorAgentBinding;
    /** Phase 08: City Guide itinerary skill binding (same agent, second skill). */
    readonly itinerary?: CoordinatorAgentBinding;
  };
  /** Bounded wait for a delivered delegation task (ms). */
  readonly delegationWaitMs?: number;
  /** Aborted when the claim's lease is lost; the driver stops early. */
  readonly signal?: AbortSignal;
  /**
   * Server-controlled test configuration: hotel research objective. Production
   * default is `preserve_level` (unchanged behavior); `cheaper` exercises the
   * accommodation specialist's genuine tradeoff question.
   */
  readonly hotelObjective?: "preserve_level" | "cheaper";
  readonly logger?: (record: Record<string, unknown>) => void;
}

const DEFAULT_DELEGATION_WAIT_MS = 20_000;

/**
 * Safe application categories a specialist may report through its terminal
 * task text (plan §3.5). Anything else becomes `AGENT_FAILED`; provider stacks,
 * prompts and credentials never reach the coordinator's error envelope.
 */
const SAFE_AGENT_FAILURE_CODES: ReadonlySet<string> = new Set([
  "AGENT_UNAVAILABLE",
  "AGENT_TIMEOUT",
  "AGENT_RESTARTED",
  "AGENT_FAILED",
  "MCP_UNAVAILABLE",
  "MCP_TIMEOUT",
  "INVALID_ARTIFACT",
  "TASK_BUDGET_EXCEEDED",
  "INPUT_EXPIRED",
  "DELEGATION_REVOKED",
  "STALE_AGENT_RESULT",
]);

/** Extract a safe application code from a terminal task text or an error. */
function safeAgentFailureCode(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    const match = /^([A-Z][A-Z0-9_]{2,40}):/.exec(value.trim());
    if (match && SAFE_AGENT_FAILURE_CODES.has(match[1] as string)) {
      return match[1] as string;
    }
  }
  if (value !== null && typeof value === "object" && "code" in value) {
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string" && SAFE_AGENT_FAILURE_CODES.has(code)) {
      return code;
    }
  }
  return fallback;
}

/** Every research domain of a persisted delegation scope (failure events). */
function researchDomainsOf(delegation: { scope: unknown }): ResearchDomain[] {
  const scope = delegation.scope as { domains?: unknown } | null;
  if (!Array.isArray(scope?.domains)) {
    return [];
  }
  return scope.domains.flatMap((domain) => {
    const parsed = researchDomainSchema.safeParse(domain);
    return parsed.success ? [parsed.data] : [];
  });
}

type RunDataPatch = Partial<Omit<CoordinatorRunData, "schemaVersion">>;

function runDataWith(base: CoordinatorRunData, patch: RunDataPatch): CoordinatorRunDataInput {
  return { ...base, ...patch, schemaVersion: 1 };
}

/** Refuse cursor writes from a claim that no longer owns the operation. */
async function stillHeld(deps: CoordinatorDispatchDeps, claim: ClaimedOperation): Promise<boolean> {
  const result = await deps.pool.query<{ held: boolean }>(
    `SELECT true AS held FROM odft_app.workflow_operations
      WHERE id = $1 AND fencing_token = $2::bigint AND status = 'running'`,
    [claim.operationId, claim.fencingToken],
  );
  return result.rows[0]?.held === true;
}

interface StepContext {
  readonly deps: CoordinatorDispatchDeps;
  readonly claim: ClaimedOperation;
  readonly run: CoordinatorRunRecord;
  readonly tripId: string;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function preferencesOf(trip: { preferences: unknown }): TripPreferences {
  return tripPreferencesSchema.parse(trip.preferences);
}

/** Reuse a non-terminal research delegation of THIS operation, else create one. */
async function reuseOrCreateResearchDelegation(
  deps: CoordinatorDispatchDeps,
  claim: ClaimedOperation,
  input: {
    skillId: string;
    agentIdentity: string;
    endpointUrl: string;
    snapshotId: string;
    inputFingerprint: string;
    domains: readonly (ResearchDomain | "flights")[];
    objective: "preserve_level" | "cheaper" | null;
    levelOverride?: string | null;
    taskData: Record<string, unknown>;
  },
): Promise<{ delegationId: string; taskData: unknown }> {
  const existing = await deps.pool.query<{ id: string }>(
    `SELECT d.id FROM odft_app.agent_delegations d
      WHERE d.trip_id = $1 AND d.skill_id = $2 AND d.originating_operation_id = $3
        AND d.status IN ('pending', 'dispatched', 'working', 'input_required')
      ORDER BY d.created_at ASC LIMIT 1`,
    [claim.tripId, input.skillId, claim.operationId],
  );
  const existingId = existing.rows[0]?.id;
  if (existingId) {
    const persisted = await loadDelegationDelivery(deps.pool, existingId);
    if (persisted.outbound) {
      if (!persisted.delegation?.taskId) {
        await deliverDelegation(deps.pool, deps.transport, {
          delegationId: existingId,
          agentIdentity: persisted.delegation?.agentIdentity ?? input.agentIdentity,
          data: persisted.outbound.payload,
        });
      }
      return { delegationId: existingId, taskData: persisted.outbound.payload };
    }
    await deps.pool.query(
      `UPDATE odft_app.agent_delegations SET status = 'failed', updated_at = now()
        WHERE id = $1 AND status IN ('pending','dispatched','working','input_required')`,
      [existingId],
    );
  }
  // Owner retry: a COMPLETED, accepted sibling of the SAME operation and input
  // is durable work. Reuse it instead of starting a second paid delegation
  // (plan §3.12/§3.17); only the failed domain gets a fresh delegation.
  const completed = await deps.pool.query<{ id: string }>(
    `SELECT d.id FROM odft_app.agent_delegations d
      WHERE d.trip_id = $1 AND d.skill_id = $2 AND d.originating_operation_id = $3
        AND d.status = 'completed' AND d.accepted_artifact_hash IS NOT NULL
        AND d.input_fingerprint = $4
      ORDER BY d.created_at DESC LIMIT 1`,
    [claim.tripId, input.skillId, claim.operationId, input.inputFingerprint],
  );
  const completedId = completed.rows[0]?.id;
  if (completedId) {
    const persisted = await loadDelegationDelivery(deps.pool, completedId);
    if (persisted.outbound) {
      return { delegationId: completedId, taskData: persisted.outbound.payload };
    }
  }
  const created = await createOutboundDelegation(deps.pool, {
    tripId: claim.tripId,
    operationId: claim.operationId,
    acceptedRevision: claim.acceptedRevision,
    skillId: input.skillId,
    agentIdentity: input.agentIdentity,
    endpointUrl: input.endpointUrl,
    snapshotId: input.snapshotId,
    inputFingerprint: input.inputFingerprint,
    domains: input.domains,
    allowRouteValidation: false,
    allowItinerary: false,
    objective: input.objective,
    levelOverride: input.levelOverride ?? null,
    taskData: input.taskData,
    deadlineAt: new Date(Date.now() + 600_000).toISOString(),
  });
  return created;
}

/**
 * Phase 09/11 bounded research retry: a retryable domain failure gets exactly
 * one fresh delegation for the same scope and input fingerprint. The failed
 * delegation stays as evidence; the retry carries `attempt: 2` so the UI can
 * show the automatic retry and the simulated-failure label.
 */
async function retryResearchDelegations(
  deps: CoordinatorDispatchDeps,
  claim: ClaimedOperation,
  data: CoordinatorRunData,
  failures: readonly { delegationId: string; domains: ResearchDomain[] }[],
): Promise<CoordinatorTransitionResult | null> {
  const replaced = new Set(failures.map((failure) => failure.delegationId));
  const retriedIds: string[] = [];
  for (const failure of failures) {
    const delegation = await getAgentDelegation(deps.pool, failure.delegationId);
    if (!delegation) {
      continue;
    }
    const persisted = await loadDelegationDelivery(deps.pool, failure.delegationId);
    if (!persisted.outbound) {
      continue;
    }
    const scope = delegation.scope as {
      domains?: string[];
      objective?: "preserve_level" | "cheaper" | null;
      levelOverride?: string | null;
      allowRouteValidation?: boolean;
      allowItinerary?: boolean;
    };
    const created = await createOutboundDelegation(deps.pool, {
      tripId: claim.tripId,
      operationId: claim.operationId,
      acceptedRevision: delegation.acceptedRevision,
      skillId: delegation.skillId,
      agentIdentity: delegation.agentIdentity,
      endpointUrl: delegation.endpointUrl,
      snapshotId: delegation.snapshotId,
      inputFingerprint: delegation.inputFingerprint,
      domains: (scope.domains ?? failure.domains) as (ResearchDomain | "flights")[],
      objective: scope.objective ?? null,
      levelOverride: scope.levelOverride ?? null,
      allowRouteValidation: scope.allowRouteValidation ?? false,
      allowItinerary: scope.allowItinerary ?? false,
      taskData: persisted.outbound.payload as Record<string, unknown>,
      deadlineAt: new Date(Date.now() + 600_000).toISOString(),
      attempt: (delegation.attempt ?? 1) + 1,
    });
    const delivered = await deliverDelegation(deps.pool, deps.transport, {
      delegationId: created.delegationId,
      agentIdentity: delegation.agentIdentity,
      data: created.taskData,
    });
    if (delivered.delivered) {
      retriedIds.push(created.delegationId);
    } else {
      await deps.pool.query(
        `UPDATE odft_app.agent_delegations SET status = 'failed', updated_at = now()
          WHERE id = $1 AND status IN ('pending','dispatched','working','input_required')`,
        [created.delegationId],
      );
    }
  }
  if (retriedIds.length === 0) {
    return null;
  }
  return {
    kind: "continue",
    step: "researching",
    runData: runDataWith(data, {
      delegationIds: [
        ...data.delegationIds.filter((delegationId) => !replaced.has(delegationId)),
        ...retriedIds,
      ],
      researchRetryAttempts: data.researchRetryAttempts + 1,
    }),
  };
}

/**
 * Materialize the extended snapshot and delegate hotel + City Guide research
 * CONCURRENTLY (plan §3.11): both outbound intents persist before any delivery,
 * then both deliveries run in parallel. Returns the refreshed delegation set
 * (the settled flight one stays for recovery bookkeeping).
 */
async function dispatchSpecialistResearch(
  deps: CoordinatorDispatchDeps,
  claim: ClaimedOperation,
  trip: { travelVariant: string; adults: number; sightseeingDate: string; preferences: unknown },
  data: CoordinatorRunData,
): Promise<
  | { kind: "fail"; runData: CoordinatorRunDataInput; code: string; reason: string }
  | { kind: "continue"; delegationIds: string[] }
> {
  const accommodation = deps.agents.accommodation;
  const cityGuide = deps.agents.cityGuide;
  if (!accommodation || !cityGuide) {
    return {
      kind: "fail",
      runData: runDataWith(data, {}),
      code: "COORDINATOR_AGENTS_MISSING",
      reason: "the trusted registry has no accommodation/city-guide specialist binding",
    };
  }
  const ensured = await deps.ports.ensureDomains(claim.tripId);
  // The extended snapshot becomes active; re-run Stage B on it so later
  // bookings validate against the schedule bound to the ACTIVE snapshot.
  const extendedSchedule = await deps.ports.validateSchedules({
    tripId: claim.tripId,
    snapshotId: ensured.snapshotId,
  });
  if (extendedSchedule.status !== "VALID") {
    return {
      kind: "fail",
      runData: runDataWith(data, {}),
      code: "NO_VALID_SCHEDULE",
      reason: "the extended snapshot has no valid flight schedule",
    };
  }
  const inputs = await deps.ports.loadResearchInputs(claim.tripId, claim.operationId, null);
  const prefs = preferencesOf(trip as { preferences: unknown });
  // The task binding must carry the REAL snapshot key and the persisted Stage A/B
  // fingerprints (empty strings would fail the strict request schema).
  const binding = await deps.pool.query<{
    scenario_key: string;
    route_fingerprint: string | null;
    schedule_fingerprint: string | null;
  }>(
    `SELECT s.scenario_key,
            rv.fingerprint AS route_fingerprint,
            sv.fingerprint AS schedule_fingerprint
       FROM odft_app.scenario_snapshots s
       LEFT JOIN odft_app.trips t ON t.id = s.trip_id
       LEFT JOIN odft_app.route_validations rv ON rv.id = t.current_route_validation_id
       LEFT JOIN odft_app.schedule_validations sv ON sv.id = t.current_schedule_validation_id
      WHERE s.id = $1`,
    [ensured.snapshotId],
  );
  const bindingRow = binding.rows[0];
  if (!bindingRow?.route_fingerprint || !bindingRow.schedule_fingerprint) {
    return {
      kind: "fail",
      runData: runDataWith(data, {}),
      code: "ROUTE_INVALIDATED",
      reason: "the extended snapshot has no persisted route/schedule approval",
    };
  }
  const base = {
    schemaVersion: 1 as const,
    tripId: claim.tripId,
    operationId: claim.operationId,
    acceptedRevision: claim.acceptedRevision,
    traceId: newTraceId(),
    snapshot: {
      snapshotId: ensured.snapshotId,
      scenarioKey: bindingRow.scenario_key,
      routeApprovalFingerprint: bindingRow.route_fingerprint,
      scheduleApprovalFingerprint: bindingRow.schedule_fingerprint,
      domainFingerprints: inputs.fingerprints,
    },
    inputFingerprint: inputs.fingerprints.hotel ?? "",
    requestedDomains: [] as string[],
    travelVariant: trip.travelVariant as never,
    adults: trip.adults,
    sightseeingDate: trip.sightseeingDate,
    effectiveLevel: prefs.defaultServiceLevel,
    selectedOfferIds: [] as string[],
    confirmedOfferIds: [] as string[],
    preservationConstraints: [] as string[],
    searchObjective: "preserve_level" as const,
    queryContext: { domainInputFingerprints: inputs.fingerprints },
    deadlineAt: new Date(Date.now() + 600_000).toISOString(),
    limits: {
      activeTimeMs: 90_000,
      mcpInvocations: 8,
      llmTransportAttempts: 2,
      maxTaskCostUsd: 0.1,
    },
    preferences: prefs,
    continuation: null,
  };
  const hotelDelegation = await reuseOrCreateResearchDelegation(deps, claim, {
    skillId: accommodation.skillId,
    agentIdentity: accommodation.agentIdentity,
    endpointUrl: accommodation.endpointUrl,
    snapshotId: ensured.snapshotId,
    inputFingerprint: inputs.fingerprints.hotel ?? "",
    domains: ["hotel"],
    objective: deps.hotelObjective ?? "preserve_level",
    taskData: {
      ...base,
      skillId: accommodation.skillId,
      requestedDomains: ["hotel"],
      delegationId: "",
      searchObjective: deps.hotelObjective ?? "preserve_level",
    },
  });
  const cityDomains = ["breakfast", "lunch", "dinner", "attractions", "events"];
  const cityDelegation = await reuseOrCreateResearchDelegation(deps, claim, {
    skillId: cityGuide.skillId,
    agentIdentity: cityGuide.agentIdentity,
    endpointUrl: cityGuide.endpointUrl,
    snapshotId: ensured.snapshotId,
    inputFingerprint: inputs.fingerprints.breakfast ?? "",
    domains: cityDomains as never,
    objective: null,
    taskData: {
      ...base,
      skillId: cityGuide.skillId,
      requestedDomains: cityDomains,
      delegationId: "",
    },
  });
  // Deliver both in parallel, outside any transaction.
  const deliveries = await Promise.all([
    deliverDelegation(deps.pool, deps.transport, {
      delegationId: hotelDelegation.delegationId,
      agentIdentity: accommodation.agentIdentity,
      data: hotelDelegation.taskData,
    }),
    deliverDelegation(deps.pool, deps.transport, {
      delegationId: cityDelegation.delegationId,
      agentIdentity: cityGuide.agentIdentity,
      data: cityDelegation.taskData,
    }),
  ]);
  for (const [index, delivered] of deliveries.entries()) {
    if (!delivered.delivered) {
      deps.logger?.({
        level: "warn",
        component: "coordinator",
        message:
          index === 0
            ? "hotel delegation delivery failed"
            : "city-guide delegation delivery failed",
        reason: delivered.reason,
      });
    }
  }
  return {
    kind: "continue",
    delegationIds: [
      ...data.delegationIds,
      hotelDelegation.delegationId,
      cityDelegation.delegationId,
    ],
  };
}

/**
 * Mark a delegation terminal after a failed/canceled specialist task or a
 * transport read failure (plan §3.13/§3.17). The terminal status is what lets a
 * later owner retry create a FRESH delegation instead of re-polling a dead task
 * forever; the research event keeps the safe reason for the inspector.
 */
async function markDelegationFailed(
  deps: CoordinatorDispatchDeps,
  tripId: string,
  delegation: {
    id: string;
    skillId: string;
    scope: unknown;
    inputFingerprint: string;
    attempt: number;
    originatingOperationId: string;
  },
  code: string,
  reason: string,
): Promise<void> {
  const updated = await deps.pool.query<{ id: string }>(
    `UPDATE odft_app.agent_delegations
        SET status = 'failed', updated_at = now()
      WHERE id = $1 AND status IN ('pending','dispatched','working','input_required')
      RETURNING id`,
    [delegation.id],
  );
  if (updated.rows.length === 0) {
    return;
  }
  const domains = researchDomainsOf(delegation);
  const cleanReason = reason.startsWith(`${code}: `) ? reason.slice(code.length + 2) : reason;
  for (const domain of domains) {
    // An injected scenario fault is labeled as a simulated failure; a genuine
    // provider/task failure is not. This keeps the retry panel honest.
    const fault = await deps.pool.query(
      `SELECT 1 FROM odft_app.simulation_faults
        WHERE trip_id = $1 AND domain = $2
          AND (operation_id IS NULL OR operation_id = $3)
        LIMIT 1`,
      [tripId, SCENARIO_DOMAIN_FOR_RESEARCH[domain], delegation.originatingOperationId],
    );
    await deps.ports.recordResearchEvent({
      tripId,
      operationId: delegation.originatingOperationId,
      domain,
      phase: "finished",
      attempt: delegation.attempt,
      durationMs: null,
      status: "unavailable",
      simulatedFailure: fault.rowCount === 1,
      reason: `${code}: ${cleanReason}`.slice(0, 500),
      fingerprint: delegation.inputFingerprint,
    });
  }
  deps.logger?.({
    level: "warn",
    component: "coordinator",
    message: "specialist delegation failed",
    delegationId: delegation.id,
    skillId: delegation.skillId,
    code,
    reason,
  });
}

/** Re-read and validate the accepted artifact of a completed delegation. */
async function acceptedArtifactPayload(
  deps: CoordinatorDispatchDeps,
  delegationId: string,
): Promise<unknown | undefined> {
  const delegation = await getAgentDelegation(deps.pool, delegationId);
  if (!delegation?.taskId) {
    return undefined;
  }
  const task = await deps.transport.getTask({
    agentIdentity: delegation.agentIdentity,
    taskId: delegation.taskId,
  });
  for (const artifact of task.artifacts) {
    // The DELEGATION is the binding: a later operation (e.g. the hotel booking)
    // re-reads the artifact under the delegation's own operation/revision.
    const accepted = acceptArtifact({
      artifact: artifact.data,
      delegation,
      operationId: delegation.originatingOperationId,
      acceptedRevision: delegation.acceptedRevision,
    });
    if (accepted) {
      return accepted.value;
    }
  }
  return undefined;
}

/** Phase 08: the accommodation/city scopes a targeted refresh may dispatch. */
interface ScopedResearchSpec {
  readonly hotel: boolean;
  readonly cityDomains: readonly ResearchDomain[];
  readonly objective: "preserve_level" | "cheaper" | null;
  readonly levelOverride: string | null;
  readonly searchIntent: ResearchSearchIntent | null;
  readonly target: "program_choices" | "hotel_choice" | "plan";
}

interface ProgramCommandValues {
  readonly mealSelections: MealSelections;
  readonly selfArrangedMeals: readonly Meal[];
  readonly preferredActivityIds: readonly string[];
  readonly activitiesSelfArranged: boolean;
}

/** Map the coordinator deps onto the itinerary loop's narrow dependency set. */
function itineraryLoop(deps: CoordinatorDispatchDeps): ItineraryLoopDeps {
  return {
    pool: deps.pool,
    ports: deps.ports,
    transport: deps.transport,
    binding: deps.agents.itinerary,
    logger: deps.logger,
    delegationWaitMs: deps.delegationWaitMs,
  };
}

/** Park the meal/activity program choices from the persisted City Guide result. */
async function openProgramChoices(
  deps: CoordinatorDispatchDeps,
  claim: ClaimedOperation,
  data: CoordinatorRunData,
): Promise<CoordinatorTransitionResult> {
  // The newest artifact PER DOMAIN is the source of truth: a scoped refresh
  // replaces only its affected domain, so unaffected meal/activity rankings
  // must survive (never read only the newest City Guide task artifact).
  const artifacts = await listLatestRecommendationArtifacts(deps.pool, claim.tripId);
  const byService = new Map(
    artifacts.map((artifact) => [artifact.serviceKey, artifact.rankedOfferIds]),
  );
  const mealIds = ["breakfast", "lunch", "dinner"].flatMap((meal) => byService.get(meal) ?? []);
  // Recommendation artifacts use the activity service key (`activities`);
  // the research domain is `attractions`.
  const activityIds = byService.get("activities") ?? [];
  if (mealIds.length === 0) {
    // A completed hotel must not be lost because the City Guide task failed
    // (plan §3.11). Re-research the meal/activity domains ONCE per operation;
    // a repeated empty outcome fails explicitly instead of looping.
    const trip = await getTrip(deps.pool, claim.tripId);
    if (!trip) {
      return {
        kind: "fail",
        runData: { ...data },
        code: "NOT_FOUND",
        reason: "trip not found",
      };
    }
    if (data.researchTarget !== "program_choices") {
      return dispatchScopedResearch(deps, claim, trip, data, {
        hotel: false,
        cityDomains: ["breakfast", "lunch", "dinner", "attractions", "events"],
        objective: null,
        levelOverride: null,
        searchIntent: null,
        target: "program_choices",
      });
    }
    return {
      kind: "fail",
      runData: { ...data },
      code: "MCP_UNAVAILABLE",
      reason: "the program choices need usable City Guide meal outcomes",
    };
  }
  return {
    kind: "wait",
    step: "awaiting_user",
    waitReason: "program_choices",
    runData: { ...data, itineraryDelegationId: null },
    fingerprint: contentHash({ mealIds, activityIds }),
    allowedOptionIds: activityIds,
    allowedOfferIds: mealIds,
    optionPayload: { rankedMeals: mealIds, rankedActivities: activityIds },
  };
}

/** Park the hotel choice from the persisted accommodation result. */
async function openHotelChoice(
  deps: CoordinatorDispatchDeps,
  claim: ClaimedOperation,
  data: CoordinatorRunData,
): Promise<CoordinatorTransitionResult> {
  const artifacts = await listLatestRecommendationArtifacts(deps.pool, claim.tripId);
  const ranked =
    artifacts.find((artifact) => artifact.serviceKey === "hotel")?.rankedOfferIds ?? [];
  if (ranked.length === 0) {
    // The hotel artifact may be missing after an agent outage. Re-research the
    // hotel domain once (target `hotel_choice`), never silently invent offers.
    const trip = await getTrip(deps.pool, claim.tripId);
    if (!trip) {
      return {
        kind: "fail",
        runData: { ...data },
        code: "NOT_FOUND",
        reason: "trip not found",
      };
    }
    if (data.researchTarget !== "hotel_choice") {
      return dispatchScopedResearch(deps, claim, trip, data, {
        hotel: true,
        cityDomains: [],
        objective: "preserve_level",
        levelOverride: null,
        searchIntent: null,
        target: "hotel_choice",
      });
    }
    return {
      kind: "fail",
      runData: { ...data },
      code: "MCP_UNAVAILABLE",
      reason: "the hotel choice needs usable accommodation outcomes",
    };
  }
  return {
    kind: "wait",
    step: "awaiting_user",
    waitReason: "hotel_choice",
    runData: { ...data },
    fingerprint: contentHash(ranked),
    allowedOptionIds: [],
    allowedOfferIds: ranked,
    optionPayload: { rankedHotelOfferIds: ranked },
  };
}

/**
 * Persist the accepted City Guide outcomes as recommendation artifacts and
 * research events. Only ranked existing ids are recorded; a failed domain keeps
 * its explicit unavailable outcome.
 */
async function ingestCityArtifact(
  deps: CoordinatorDispatchDeps,
  claim: ClaimedOperation,
  data: CoordinatorRunData,
  value: {
    outcomes?: {
      domain?: string;
      status?: string;
      rankedOfferIds?: string[];
      inputFingerprint?: string | null;
      simulatedFailure?: boolean;
      reason?: string | null;
    }[];
  },
  options: { recordEvents?: boolean; attempt?: number } = {},
): Promise<void> {
  const outcomes = value.outcomes ?? [];
  const ranked = outcomes.filter(
    (outcome) =>
      outcome.status === "ok" &&
      typeof outcome.domain === "string" &&
      Array.isArray(outcome.rankedOfferIds) &&
      outcome.rankedOfferIds.length > 0 &&
      typeof outcome.inputFingerprint === "string",
  );
  if (options.recordEvents !== false) {
    for (const outcome of outcomes) {
      if (typeof outcome.domain !== "string") {
        continue;
      }
      await deps.ports.recordResearchEvent({
        tripId: claim.tripId,
        operationId: claim.operationId,
        domain: outcome.domain as ResearchDomain,
        phase: "finished",
        attempt: options.attempt ?? 1,
        durationMs: null,
        status: outcome.status as never,
        simulatedFailure: outcome.simulatedFailure ?? false,
        reason: outcome.reason ?? null,
        fingerprint: outcome.inputFingerprint ?? null,
      });
    }
  }
  if (ranked.length > 0) {
    await deps.ports.rankRecommendations({
      tripId: claim.tripId,
      operationId: claim.operationId,
      domains: ranked.map((outcome) => ({
        domain: outcome.domain as ResearchDomain,
        artifactId: `coordinator:${outcome.domain}`,
        inputFingerprint: outcome.inputFingerprint as string,
        offerIds: outcome.rankedOfferIds as string[],
      })),
      searchIntent: data.searchIntent,
    });
  }
}

/** Persist the accepted accommodation ranking as the hotel artifact. */
async function ingestHotelArtifact(
  deps: CoordinatorDispatchDeps,
  claim: ClaimedOperation,
  delegationId: string,
  rankedIds: readonly string[],
  options: {
    recordEvents?: boolean;
    attempt?: number;
    searchIntent?: CoordinatorRunData["searchIntent"];
  } = {},
): Promise<void> {
  const delegation = await getAgentDelegation(deps.pool, delegationId);
  if (!delegation) {
    return;
  }
  if (options.recordEvents !== false) {
    await deps.ports.recordResearchEvent({
      tripId: claim.tripId,
      operationId: claim.operationId,
      domain: "hotel",
      phase: "finished",
      attempt: options.attempt ?? 1,
      durationMs: null,
      status: "ok",
      simulatedFailure: false,
      reason: null,
      fingerprint: delegation.inputFingerprint,
    });
  }
  await deps.ports.rankRecommendations({
    tripId: claim.tripId,
    operationId: claim.operationId,
    domains: [
      {
        domain: "hotel",
        artifactId: "coordinator:hotel",
        inputFingerprint: delegation.inputFingerprint,
        offerIds: [...rankedIds],
      },
    ],
    searchIntent: options.searchIntent ?? null,
  });
}

/**
 * Dispatch only the domains a command invalidated. The frozen snapshot is
 * extended once (idempotent), Stage B is re-approved, and unaffected artifacts
 * stay untouched; the target tells the researching step where to resume.
 */
async function dispatchScopedResearch(
  deps: CoordinatorDispatchDeps,
  claim: ClaimedOperation,
  trip: TripRecord,
  data: CoordinatorRunData,
  spec: ScopedResearchSpec,
): Promise<CoordinatorTransitionResult> {
  const accommodation = deps.agents.accommodation;
  const cityGuide = deps.agents.cityGuide;
  if ((spec.hotel && !accommodation) || (spec.cityDomains.length > 0 && !cityGuide)) {
    return {
      kind: "fail",
      runData: { ...data },
      code: "COORDINATOR_AGENTS_MISSING",
      reason: "the trusted registry has no specialist binding for the affected domains",
    };
  }
  const ensured = await deps.ports.ensureDomains(claim.tripId);
  const schedule = await deps.ports.validateSchedules({
    tripId: claim.tripId,
    snapshotId: ensured.snapshotId,
  });
  if (schedule.status !== "VALID") {
    return {
      kind: "fail",
      runData: { ...data },
      code: "NO_VALID_SCHEDULE",
      reason: "the extended snapshot has no valid flight schedule",
    };
  }
  const inputs = await deps.ports.loadResearchInputs(
    claim.tripId,
    claim.operationId,
    spec.searchIntent,
  );
  const binding = await deps.pool.query<{
    scenario_key: string;
    route_fingerprint: string | null;
    schedule_fingerprint: string | null;
  }>(
    `SELECT s.scenario_key,
            rv.fingerprint AS route_fingerprint,
            sv.fingerprint AS schedule_fingerprint
       FROM odft_app.scenario_snapshots s
       LEFT JOIN odft_app.trips t ON t.id = s.trip_id
       LEFT JOIN odft_app.route_validations rv ON rv.id = t.current_route_validation_id
       LEFT JOIN odft_app.schedule_validations sv ON sv.id = t.current_schedule_validation_id
      WHERE s.id = $1`,
    [ensured.snapshotId],
  );
  const bindingRow = binding.rows[0];
  if (!bindingRow?.route_fingerprint || !bindingRow.schedule_fingerprint) {
    return {
      kind: "fail",
      runData: { ...data },
      code: "ROUTE_INVALIDATED",
      reason: "the extended snapshot has no persisted route/schedule approval",
    };
  }
  const progress = await deps.ports.loadProgress(claim.tripId);
  const selected = Object.values(progress.selectionOfferIds).filter(
    (offerId): offerId is string => typeof offerId === "string",
  );
  const confirmed = await deps.pool.query<{ offer_id: string }>(
    `SELECT offer_id FROM odft_app.reservations
      WHERE trip_id = $1 AND status = 'confirmed'`,
    [claim.tripId],
  );
  const hotelFingerprint = inputs.fingerprints.hotel;
  const cityFingerprint =
    spec.cityDomains.length > 0
      ? inputs.fingerprints[spec.cityDomains[0] as ResearchDomain]
      : undefined;
  if ((spec.hotel && !hotelFingerprint) || (spec.cityDomains.length > 0 && !cityFingerprint)) {
    return {
      kind: "fail",
      runData: { ...data },
      code: "STALE_SNAPSHOT",
      reason: "the affected domains have no approved snapshot fingerprint",
    };
  }
  const base = {
    schemaVersion: 1 as const,
    tripId: claim.tripId,
    operationId: claim.operationId,
    acceptedRevision: claim.acceptedRevision,
    traceId: newTraceId(),
    snapshot: {
      snapshotId: ensured.snapshotId,
      scenarioKey: bindingRow.scenario_key,
      routeApprovalFingerprint: bindingRow.route_fingerprint,
      scheduleApprovalFingerprint: bindingRow.schedule_fingerprint,
      domainFingerprints: inputs.fingerprints,
    },
    inputFingerprint: hotelFingerprint ?? cityFingerprint ?? "",
    travelVariant: trip.travelVariant,
    adults: trip.adults,
    sightseeingDate: trip.sightseeingDate,
    effectiveLevel: trip.preferences.defaultServiceLevel,
    selectedOfferIds: [...new Set(selected)],
    confirmedOfferIds: confirmed.rows.map((row) => row.offer_id),
    preservationConstraints: [],
    searchObjective: spec.objective ?? ("preserve_level" as const),
    queryContext: {
      domainInputFingerprints: inputs.fingerprints,
      ...(spec.searchIntent ? { searchIntent: spec.searchIntent } : {}),
    },
    deadlineAt: new Date(Date.now() + 600_000).toISOString(),
    limits: {
      activeTimeMs: 90_000,
      mcpInvocations: 8,
      llmTransportAttempts: 2,
      maxTaskCostUsd: 0.1,
    },
    preferences: trip.preferences,
    continuation: null,
  };
  const delegationIds: string[] = [];
  const pendingDeliveries: {
    delegationId: string;
    agentIdentity: string;
    taskData: Record<string, unknown>;
  }[] = [];
  if (spec.hotel && accommodation) {
    const delegation = await reuseOrCreateResearchDelegation(deps, claim, {
      skillId: accommodation.skillId,
      agentIdentity: accommodation.agentIdentity,
      endpointUrl: accommodation.endpointUrl,
      snapshotId: ensured.snapshotId,
      inputFingerprint: hotelFingerprint as string,
      domains: ["hotel"],
      objective: spec.objective ?? "preserve_level",
      levelOverride: spec.levelOverride,
      taskData: {
        ...base,
        skillId: accommodation.skillId,
        requestedDomains: ["hotel"],
        delegationId: "",
        inputFingerprint: hotelFingerprint as string,
        searchObjective: spec.objective ?? "preserve_level",
      },
    });
    delegationIds.push(delegation.delegationId);
    pendingDeliveries.push({
      delegationId: delegation.delegationId,
      agentIdentity: accommodation.agentIdentity,
      taskData: delegation.taskData as Record<string, unknown>,
    });
    await deps.ports.recordResearchEvent({
      tripId: claim.tripId,
      operationId: claim.operationId,
      domain: "hotel",
      phase: "started",
      attempt: 1,
      durationMs: null,
      status: null,
      simulatedFailure: false,
      reason: null,
      fingerprint: null,
    });
  }
  if (spec.cityDomains.length > 0 && cityGuide) {
    const delegation = await reuseOrCreateResearchDelegation(deps, claim, {
      skillId: cityGuide.skillId,
      agentIdentity: cityGuide.agentIdentity,
      endpointUrl: cityGuide.endpointUrl,
      snapshotId: ensured.snapshotId,
      inputFingerprint: cityFingerprint as string,
      domains: [...spec.cityDomains],
      objective: null,
      levelOverride: null,
      taskData: {
        ...base,
        skillId: cityGuide.skillId,
        requestedDomains: [...spec.cityDomains],
        delegationId: "",
        inputFingerprint: cityFingerprint as string,
      },
    });
    delegationIds.push(delegation.delegationId);
    pendingDeliveries.push({
      delegationId: delegation.delegationId,
      agentIdentity: cityGuide.agentIdentity,
      taskData: delegation.taskData as Record<string, unknown>,
    });
    for (const domain of spec.cityDomains) {
      await deps.ports.recordResearchEvent({
        tripId: claim.tripId,
        operationId: claim.operationId,
        domain,
        phase: "started",
        attempt: 1,
        durationMs: null,
        status: null,
        simulatedFailure: false,
        reason: null,
        fingerprint: null,
      });
    }
  }
  if (delegationIds.length === 0) {
    return {
      kind: "fail",
      runData: { ...data },
      code: "NO_AFFECTED_DOMAIN",
      reason: "the command resolved no researchable affected domain",
    };
  }
  const deliveries = await Promise.all(
    pendingDeliveries.map((entry) =>
      deliverDelegation(deps.pool, deps.transport, {
        delegationId: entry.delegationId,
        agentIdentity: entry.agentIdentity,
        data: entry.taskData,
      }),
    ),
  );
  for (const [index, delivered] of deliveries.entries()) {
    if (!delivered.delivered) {
      deps.logger?.({
        level: "warn",
        component: "coordinator",
        message: "scoped research delegation delivery failed",
        reason: delivered.reason,
        operationId: claim.operationId,
      });
      void index;
    }
  }
  return {
    kind: "continue",
    step: "researching",
    runData: {
      ...data,
      delegationIds,
      researchTarget: spec.target,
      searchIntent: spec.searchIntent,
      planningAttempt: 0,
      feedback: [],
      itineraryDelegationId: null,
      itineraryId: null,
      itineraryReviewFingerprint: null,
      questionQueue: [],
      drainPending: false,
    },
  };
}

/**
 * Apply a program (decision or typed command), stage a confirmed-meal
 * replacement, run the deterministic logistics check, then start the bounded
 * itinerary attempt. A logistics conflict opens a typed recovery decision and
 * never edits a reservation.
 */
async function applyProgramAndPlan(
  deps: CoordinatorDispatchDeps,
  claim: ClaimedOperation,
  trip: TripRecord,
  data: CoordinatorRunData,
  program: ProgramCommandValues,
  assistantMessage: string | null,
): Promise<CoordinatorTransitionResult> {
  const applied = await deps.ports.applyProgram({
    tripId: claim.tripId,
    operationId: claim.operationId,
    mealSelections: program.mealSelections,
    selfArrangedMeals: [...program.selfArrangedMeals],
    preferredActivityIds: [...program.preferredActivityIds],
    activitiesSelfArranged: program.activitiesSelfArranged,
  });
  if (applied.replacementStaged && applied.replacementProposalId) {
    const proposal = await getProposal(deps.pool, claim.tripId, applied.replacementProposalId);
    if (!proposal) {
      return {
        kind: "fail",
        runData: { ...data },
        code: "STALE_DECISION",
        reason: "the staged meal replacement proposal is missing",
      };
    }
    return {
      kind: "wait",
      step: "awaiting_user",
      waitReason: "replacement_confirmation",
      runData: { ...data, assistantMessage },
      fingerprint: proposal.sourceFingerprint,
      allowedOptionIds: [],
      allowedOfferIds: [proposal.offerId],
      proposalId: proposal.id,
      optionPayload: { service: proposal.serviceKey, offerId: proposal.offerId },
    };
  }
  const logistics = await deps.ports.validateSelectedLogistics({ tripId: claim.tripId });
  if (logistics.status === "conflict") {
    return {
      kind: "wait",
      step: "awaiting_user",
      waitReason: "recovery",
      runData: { ...data, assistantMessage },
      fingerprint: contentHash({
        kind: "logistics_conflict",
        tripId: claim.tripId,
        operationId: claim.operationId,
        reason: logistics.reason,
      }),
      allowedOptionIds: ["change_hotel", "change_meals"],
      optionPayload: {
        question: logistics.reason ?? "the selected hotel/meals conflict with the flight times",
        options: [
          { id: "change_hotel", label: "Choose another hotel", reopen: "hotel_choice" },
          { id: "change_meals", label: "Adjust the meals", reopen: "program_choices" },
        ],
      },
    };
  }
  const started = await startItineraryAttempt(
    itineraryLoop(deps),
    claim,
    trip,
    {
      ...data,
      planningAttempt: 0,
      feedback: [],
      itineraryId: null,
      itineraryReviewFingerprint: null,
      assistantMessage,
    },
    [],
  );
  return started;
}

/**
 * Apply one admitted command batch with route-change staging and the
 * invalidation matrix. Unaffected domains are never re-researched and no
 * preference is mutated outside the batch's own fields.
 */
async function applyCommandBatch(
  deps: CoordinatorDispatchDeps,
  claim: ClaimedOperation,
  trip: TripRecord,
  data: CoordinatorRunData,
  commands: readonly DomainCommand[],
  assistantMessage: string | null,
): Promise<CoordinatorTransitionResult> {
  if (commands.length === 0) {
    return resolveProgressAfterBatch(deps, claim, trip, data, assistantMessage);
  }
  const ordered = orderCommandsForApplication(commands);
  const routeCommands = ordered.filter((command) => command.type === "set_route");
  if (routeCommands.length > 0) {
    const preview = await deps.ports.runEffect(
      "coordinator_apply_commands",
      "route_change_preview",
      () =>
        deps.ports.previewRouteChange({
          tripId: claim.tripId,
          operationId: claim.operationId,
          commands: ordered,
        }),
    );
    if (preview.affectedReservations.length > 0) {
      return {
        kind: "wait",
        step: "awaiting_user",
        waitReason: "route_change_confirmation",
        runData: { ...data, assistantMessage, routeChangeCommands: [...ordered] },
        fingerprint: fingerprint({
          kind: "route_change_confirmation",
          tripId: claim.tripId,
          operationId: claim.operationId,
          proposalId: preview.proposalId,
          affectedReservationIds: preview.affectedReservations.map((entry) => entry.id).sort(),
        }),
        allowedOptionIds: [],
        allowedOfferIds: [],
        // Route previews are not selection proposals; the preview id lives in
        // the option payload (the decision FK must stay null).
        // The persisted decision payload must be the exact public preview:
        // commitRouteChange re-validates it against the stored preview.
        optionPayload: preview,
      };
    }
  }
  const propose = ordered.find((command) => command.type === "propose_selection");
  if (propose && propose.type === "propose_selection") {
    // Phase 07 parity: a per-meal/hotel/flight RESERVE action stages a proposal
    // and opens the shared booking confirmation. The active reservation (if any)
    // stays untouched until the user confirms the replacement.
    //
    // A chat interpretation may combine the proposal with preference/objective
    // commands. Apply those first instead of silently dropping them; the proposal
    // is staged against the updated state and is refused if the offer vanished.
    const residual = ordered.filter((command) => command !== propose);
    if (residual.length > 0) {
      await deps.ports.runEffect(
        "coordinator_apply_commands",
        `batch:${contentHash(residual)}`,
        () =>
          deps.ports.applyCommands({
            tripId: claim.tripId,
            operationId: claim.operationId,
            commands: residual,
          }),
      );
    }
    const sourceFingerprint = fingerprint({
      kind: "booking_confirmation",
      tripId: claim.tripId,
      operationId: claim.operationId,
      service: propose.service,
      offerId: propose.offerId,
      snapshotId: trip.activeScenarioSnapshotId ?? "",
    });
    const proposal = await deps.ports.propose({
      tripId: claim.tripId,
      operationId: claim.operationId,
      service: propose.service,
      offerId: propose.offerId,
      sourceFingerprint,
    });
    const progress = await deps.ports.loadProgress(claim.tripId);
    const replacing = progress.confirmedServices.includes(propose.service);
    return {
      kind: "wait",
      step: "awaiting_user",
      waitReason: replacing ? "replacement_confirmation" : "booking_confirmation",
      runData: { ...data, assistantMessage },
      fingerprint: sourceFingerprint,
      allowedOptionIds: [],
      allowedOfferIds: [propose.offerId],
      proposalId: proposal.proposalId,
      optionPayload: { offerId: propose.offerId, service: propose.service },
    };
  }

  await deps.ports.runEffect("coordinator_apply_commands", `batch:${contentHash(ordered)}`, () =>
    deps.ports.applyCommands({
      tripId: claim.tripId,
      operationId: claim.operationId,
      commands: ordered,
    }),
  );

  const program = ordered.find((command) => command.type === "set_program");
  if (program && program.type === "set_program") {
    return applyProgramAndPlan(
      deps,
      claim,
      trip,
      data,
      {
        mealSelections: program.mealOfferIds,
        selfArrangedMeals: program.selfArrangedMeals,
        preferredActivityIds: program.preferredActivityIds,
        activitiesSelfArranged: program.activitiesSelfArranged,
      },
      assistantMessage,
    );
  }
  const build = ordered.find((command) => command.type === "build_itinerary");
  if (build) {
    const progress = await deps.ports.loadProgress(claim.tripId);
    if (!progress.programApplied) {
      return openProgramChoices(deps, claim, data);
    }
    return startItineraryAttempt(
      itineraryLoop(deps),
      claim,
      trip,
      {
        ...data,
        planningAttempt: 0,
        feedback: [],
        itineraryId: null,
        itineraryReviewFingerprint: null,
        assistantMessage,
      },
      [],
    );
  }
  return routeAfterCommands(deps, claim, trip, data, ordered, assistantMessage);
}

/** Resolve the invalidation matrix for an applied batch and pick the next step. */
async function routeAfterCommands(
  deps: CoordinatorDispatchDeps,
  claim: ClaimedOperation,
  trip: TripRecord,
  data: CoordinatorRunData,
  commands: readonly DomainCommand[],
  assistantMessage: string | null,
): Promise<CoordinatorTransitionResult> {
  const progress = await deps.ports.loadProgress(claim.tripId);
  const routing = resolveCommandRouting({
    commands,
    refs: routingRefs({
      preferences: trip.preferences,
      confirmedServices: progress.confirmedServices,
      selectedServices: progress.selectedServices,
      hasConfirmedFlight: progress.flightConfirmed,
      programApplied: progress.programApplied,
    }),
  });
  const findAlternatives = commands.find((command) => command.type === "find_alternatives");
  const searchIntent =
    findAlternatives && findAlternatives.type === "find_alternatives"
      ? {
          target: findAlternatives.target,
          objective: findAlternatives.objective,
          level: findAlternatives.level ?? null,
        }
      : null;
  const resolution = routing.resolution;
  if (resolution.routeChange) {
    return {
      kind: "continue",
      step: "validating_route",
      runData: {
        ...data,
        assistantMessage,
        planningAttempt: 0,
        feedback: [],
        itineraryDelegationId: null,
        itineraryId: null,
        itineraryReviewFingerprint: null,
      },
    };
  }
  if (resolution.nextDecisionKind === "flight_choice") {
    return {
      kind: "continue",
      step: "validating_route",
      runData: { ...data, assistantMessage },
    };
  }
  const target: "program_choices" | "hotel_choice" | "plan" | null =
    resolution.nextDecisionKind === "program_choices"
      ? "program_choices"
      : resolution.nextDecisionKind === "hotel_choice"
        ? "hotel_choice"
        : resolution.itineraryAction === "propose"
          ? "plan"
          : null;
  if (resolution.affectedDomains.length > 0 && target !== null) {
    const hotel = resolution.affectedDomains.includes("hotel");
    const cityDomains = resolution.affectedDomains.filter(
      (domain): domain is ResearchDomain => domain !== "hotel",
    );
    return dispatchScopedResearch(
      deps,
      claim,
      trip,
      { ...data, assistantMessage },
      {
        hotel,
        cityDomains,
        objective:
          findAlternatives?.type === "find_alternatives" && findAlternatives.objective === "cheaper"
            ? "cheaper"
            : "preserve_level",
        levelOverride:
          findAlternatives?.type === "find_alternatives" && findAlternatives.level
            ? findAlternatives.level
            : null,
        searchIntent,
        target,
      },
    );
  }
  if (resolution.progressDecision) {
    return resolveProgressAfterBatch(
      deps,
      claim,
      trip,
      { ...data, assistantMessage },
      assistantMessage,
    );
  }
  if (resolution.itineraryAction === "propose") {
    if (!progress.programApplied) {
      return openProgramChoices(deps, claim, data);
    }
    return startItineraryAttempt(
      itineraryLoop(deps),
      claim,
      trip,
      {
        ...data,
        planningAttempt: 0,
        feedback: [],
        itineraryId: null,
        itineraryReviewFingerprint: null,
        assistantMessage,
      },
      [],
    );
  }
  if (resolution.itineraryAction === "validate") {
    const logistics = await deps.ports.validateSelectedLogistics({ tripId: claim.tripId });
    if (logistics.status === "conflict") {
      return {
        kind: "wait",
        step: "awaiting_user",
        waitReason: "recovery",
        runData: { ...data, assistantMessage },
        fingerprint: contentHash({
          kind: "logistics_conflict",
          tripId: claim.tripId,
          operationId: claim.operationId,
          reason: logistics.reason,
        }),
        allowedOptionIds: ["change_hotel", "change_meals"],
        optionPayload: {
          question: logistics.reason ?? "the selected hotel/meals conflict with the flight times",
          options: [
            { id: "change_hotel", label: "Choose another hotel", reopen: "hotel_choice" },
            { id: "change_meals", label: "Adjust the meals", reopen: "program_choices" },
          ],
        },
      };
    }
    // A budget change before the program is applied only needs the dependent
    // logistics check; the program choices are the next user step.
    if (!progress.programApplied) {
      return openProgramChoices(deps, claim, { ...data, assistantMessage });
    }
  }
  return {
    kind: "complete",
    runData: { ...data, assistantMessage },
    result: { appliedCount: commands.length },
    summary: "Your changes were applied. No confirmed reservation was changed.",
    workflowStatus: "ready",
  };
}

/** Re-open the progress-derived decision after an empty/no-op command batch. */
async function resolveProgressAfterBatch(
  deps: CoordinatorDispatchDeps,
  claim: ClaimedOperation,
  trip: TripRecord,
  data: CoordinatorRunData,
  assistantMessage: string | null,
): Promise<CoordinatorTransitionResult> {
  const progress = await deps.ports.loadProgress(claim.tripId);
  if (progress.programApplied) {
    return openProgramChoices(deps, claim, { ...data, assistantMessage });
  }
  if (progress.hotelConfirmed || progress.selectedServices.includes("hotel")) {
    return openProgramChoices(deps, claim, { ...data, assistantMessage });
  }
  if (progress.flightConfirmed || progress.selectedServices.includes("flights")) {
    const hotel = await openHotelChoice(deps, claim, { ...data, assistantMessage });
    if (hotel.kind !== "fail") {
      return hotel;
    }
    return dispatchScopedResearch(
      deps,
      claim,
      trip,
      { ...data, assistantMessage },
      {
        hotel: true,
        cityDomains: [],
        objective: "preserve_level",
        levelOverride: null,
        searchIntent: null,
        target: "hotel_choice",
      },
    );
  }
  return {
    kind: "complete",
    runData: { ...data, assistantMessage },
    result: { appliedCount: 0 },
    summary: "No change was requested. The trip inputs are unchanged.",
    workflowStatus: "ready",
  };
}

/** One step handler: pure orchestration over the injected ports/transport. */
async function runStep(context: StepContext): Promise<CoordinatorTransitionResult> {
  const { deps, claim, run } = context;
  const data = run.runData;
  switch (run.step) {
    case "initializing": {
      return { kind: "continue", step: "interpreting", runData: runDataWith(data, {}) };
    }
    case "interpreting": {
      if (claim.kind === "creation") {
        // The creation input is already applied to the trip row.
        return { kind: "continue", step: "validating_route", runData: runDataWith(data, {}) };
      }
      if (claim.kind === "decision") {
        // The accepted decision goes into the booking/program stage; the parked
        // awaiting_user cursor is replaced by the new step.
        return { kind: "continue", step: "planning", runData: runDataWith(data, {}) };
      }
      const trip = await getTrip(deps.pool, context.tripId);
      if (!trip) {
        return {
          kind: "fail",
          runData: runDataWith(data, {}),
          code: "NOT_FOUND",
          reason: "trip not found",
        };
      }
      const payload = await deps.ports.loadOperationPayload(claim.operationId);
      const typed = domainCommandSchema.safeParse(payload);
      if (typed.success) {
        return applyCommandBatch(deps, claim, trip, data, [typed.data], null);
      }
      const chat = chatCommandPayloadSchema.safeParse(payload);
      if (!chat.success) {
        return {
          kind: "fail",
          runData: runDataWith(data, {}),
          code: "COORDINATOR_UNSUPPORTED_OPERATION",
          reason: "the command operation payload is neither a typed command nor a chat message",
        };
      }
      const interpreted = await deps.ports.interpretIntent({
        tripId: claim.tripId,
        operationId: claim.operationId,
        message: chat.data.message,
      });
      if (interpreted.result.kind === "unsupported") {
        // An unsupported chat changes nothing: re-publish the interrupted
        // decision (if any) so the user can still answer it. A completed run
        // would leave that decision unanswerable.
        const pending = await getPendingDecisionForTrip(deps.pool, claim.tripId);
        const preserved = pending ? await loadDecision(deps.pool, pending.id) : undefined;
        // Only decision kinds whose answer does not depend on the superseded
        // operation's run data or delegations are safe to re-publish. A route
        // confirmation lost its deferred commands and an agent_input lost its
        // revoked continuation task on takeover; the fallback completes the
        // run, which cancels those (now unanswerable) decisions.
        const safeToPreserve = new Set([
          "flight_choice",
          "hotel_choice",
          "program_choices",
          "booking_confirmation",
          "replacement_confirmation",
          "itinerary_approval",
          "clarification",
          "recovery",
        ]);
        if (
          preserved &&
          preserved.engine === "coordinator-v1" &&
          safeToPreserve.has(preserved.kind)
        ) {
          return {
            kind: "wait",
            step: "awaiting_user",
            waitReason: preserved.kind,
            runData: runDataWith(data, {
              assistantMessage: interpreted.result.explanation.slice(0, 2000),
              assistantInterpretationKind: "unsupported",
            }),
            fingerprint: preserved.sourceFingerprint,
            allowedOptionIds: preserved.allowedOptionIds ?? [],
            allowedOfferIds: preserved.allowedOfferIds ?? [],
            ...(preserved.proposalId ? { proposalId: preserved.proposalId } : {}),
            ...(preserved.optionPayload !== undefined
              ? { optionPayload: preserved.optionPayload as Record<string, unknown> }
              : {}),
          };
        }
        return {
          kind: "complete",
          runData: runDataWith(data, {
            assistantMessage: interpreted.result.explanation.slice(0, 2000),
            assistantInterpretationKind: "unsupported",
          }),
          result: { intentStatus: "unsupported" },
          summary: "I could not interpret that request; the graphical controls remain available.",
          workflowStatus: "ready",
        };
      }
      if (interpreted.result.kind === "clarification") {
        return {
          kind: "wait",
          step: "awaiting_user",
          waitReason: "clarification",
          runData: runDataWith(data, { assistantInterpretationKind: "clarification" }),
          fingerprint: fingerprint({
            kind: "clarification",
            tripId: claim.tripId,
            operationId: claim.operationId,
            question: interpreted.result.question,
            options: interpreted.result.options.map((option) => option.id),
          }),
          allowedOptionIds: interpreted.result.options.map((option) => option.id),
          allowedOfferIds: [],
          optionPayload: {
            question: interpreted.result.question,
            options: interpreted.result.options.map((option) => ({
              id: option.id,
              label: option.label,
            })),
            optionCommands: Object.fromEntries(
              interpreted.result.options.map((option) => [option.id, option.commands]),
            ),
            requestedCommands: interpreted.result.requestedCommands,
            preserve: interpreted.result.preserve,
          },
        };
      }
      // More than one command that continues in its own stage cannot all run in
      // one pass: ask which one to do first instead of silently dropping the
      // others (graph parity).
      const routingCommands = interpreted.result.commands.filter(
        (command) => command.type === "set_program" || command.type === "propose_selection",
      );
      if (routingCommands.length > 1) {
        const others = interpreted.result.commands.filter(
          (command) => command.type !== "set_program" && command.type !== "propose_selection",
        );
        const options = routingCommands.slice(0, 4).map((command, index) => ({
          id: `opt_${index + 1}`,
          label:
            command.type === "set_program"
              ? "Apply the selected meals and activities first"
              : `Start the ${command.type === "propose_selection" ? command.service : "service"} selection first`,
          commands: [...others, command],
        }));
        if (options.length >= 2) {
          return {
            kind: "wait",
            step: "awaiting_user",
            waitReason: "clarification",
            runData: runDataWith(data, {}),
            fingerprint: fingerprint({
              kind: "clarification",
              tripId: claim.tripId,
              operationId: claim.operationId,
              question: "multiple_steps",
              options: options.map((option) => option.id),
            }),
            allowedOptionIds: options.map((option) => option.id),
            allowedOfferIds: [],
            optionPayload: {
              question: "This request contains several steps. Which one should I start with?",
              options: options.map((option) => ({ id: option.id, label: option.label })),
              optionCommands: Object.fromEntries(
                options.map((option) => [option.id, option.commands]),
              ),
              requestedCommands: interpreted.result.commands,
              preserve: interpreted.result.preserve,
            },
          };
        }
      }
      return applyCommandBatch(
        deps,
        claim,
        trip,
        data,
        interpreted.result.commands,
        `Applied: ${interpreted.result.interpretation}. No confirmed reservation was changed.`,
      );
    }
    case "validating_route": {
      const route = await deps.ports.evaluateRoute(context.tripId);
      if (route.status !== "FEASIBLE") {
        const reasons =
          "reasons" in route && Array.isArray(route.reasons)
            ? route.reasons.map((entry) => entry.explanation ?? entry.code)
            : [];
        return {
          kind: "wait",
          step: "awaiting_user",
          waitReason: "clarification",
          runData: runDataWith(data, {}),
          fingerprint: route.fingerprint,
          allowedOptionIds: [],
          optionPayload: {
            question:
              route.status === "INFEASIBLE"
                ? "this destination cannot be reached acceptably; adjust the trip inputs"
                : "the route could not be validated; adjust the trip inputs",
            reasons,
          },
        };
      }
      return { kind: "continue", step: "requesting_flights", runData: runDataWith(data, {}) };
    }
    case "requesting_flights": {
      const trip = await getTrip(deps.pool, context.tripId);
      if (!trip) {
        return {
          kind: "fail",
          runData: runDataWith(data, {}),
          code: "NOT_FOUND",
          reason: "trip not found",
        };
      }
      // Re-read the persisted FEASIBLE approval so the delegation carries the
      // exact route fingerprint (never a graph boolean).
      const route = await deps.ports.evaluateRoute(context.tripId);
      if (route.status !== "FEASIBLE") {
        return {
          kind: "fail",
          runData: runDataWith(data, {}),
          code: "ROUTE_INVALIDATED",
          reason: "the route approval disappeared between steps",
        };
      }
      const materialized = await deps.ports.materializeFlights(context.tripId);
      if (!materialized) {
        return {
          kind: "fail",
          runData: runDataWith(data, {}),
          code: "NO_SNAPSHOT",
          reason: "the scenario could not be materialized",
        };
      }
      const schedule = await deps.ports.validateSchedules({
        tripId: context.tripId,
        snapshotId: materialized.snapshotId,
      });
      if (schedule.status !== "VALID") {
        return {
          kind: "wait",
          step: "awaiting_user",
          waitReason: "clarification",
          runData: runDataWith(data, {}),
          fingerprint: schedule.fingerprint,
          allowedOptionIds: [],
          optionPayload: {
            question: "no valid flight schedule exists for this trip; adjust the inputs",
            reasons: [schedule.explanation],
          },
        };
      }
      // Recovery guard: an earlier claim of THIS operation may already have
      // persisted (and possibly delivered) the flight delegation; reusing it
      // prevents duplicate paid work (same messaged id, same task).
      const existing = await deps.pool.query<{ id: string }>(
        `SELECT d.id FROM odft_app.agent_delegations d
          WHERE d.trip_id = $1 AND d.skill_id = 'flight.recommend.v1'
            AND d.originating_operation_id = $2
            AND d.status IN ('pending', 'dispatched', 'working', 'input_required')
          ORDER BY d.created_at ASC LIMIT 1`,
        [context.tripId, claim.operationId],
      );
      const existingId = existing.rows[0]?.id;
      if (existingId) {
        const persisted = await loadDelegationDelivery(deps.pool, existingId);
        if (persisted.outbound) {
          if (!persisted.delegation?.taskId) {
            await deliverDelegation(deps.pool, deps.transport, {
              delegationId: existingId,
              agentIdentity:
                persisted.delegation?.agentIdentity ?? deps.agents.flight.agentIdentity,
              data: persisted.outbound.payload,
            });
          }
          return {
            kind: "continue",
            step: "researching",
            runData: runDataWith(data, {
              delegationIds: data.delegationIds.includes(existingId)
                ? data.delegationIds
                : [...data.delegationIds, existingId],
            }),
          };
        }
        // An orphan without a persisted outbound intent can never be delivered:
        // retire it and fall through to a fresh delegation.
        await deps.pool.query(
          `UPDATE odft_app.agent_delegations SET status = 'failed', updated_at = now()
            WHERE id = $1 AND status IN ('pending','dispatched','working','input_required')`,
          [existingId],
        );
      }
      // Owner retry: reuse an accepted completed flight delegation of the same
      // operation and schedule fingerprint (no duplicate flight MCP work).
      const completedFlight = await deps.pool.query<{ id: string }>(
        `SELECT d.id FROM odft_app.agent_delegations d
          WHERE d.trip_id = $1 AND d.skill_id = 'flight.recommend.v1'
            AND d.originating_operation_id = $2
            AND d.status = 'completed' AND d.accepted_artifact_hash IS NOT NULL
            AND d.input_fingerprint = $3
          ORDER BY d.created_at DESC LIMIT 1`,
        [context.tripId, claim.operationId, schedule.fingerprint],
      );
      const completedFlightId = completedFlight.rows[0]?.id;
      if (completedFlightId) {
        const persisted = await loadDelegationDelivery(deps.pool, completedFlightId);
        if (persisted.outbound) {
          return {
            kind: "continue",
            step: "researching",
            runData: runDataWith(data, {
              delegationIds: data.delegationIds.includes(completedFlightId)
                ? data.delegationIds
                : [...data.delegationIds, completedFlightId],
            }),
          };
        }
      }
      // Persist the delegation + outbound intent BEFORE any delivery attempt.
      const taskData = buildFlightTaskRequest({
        tripId: context.tripId,
        operationId: claim.operationId,
        acceptedRevision: claim.acceptedRevision,
        snapshotId: materialized.snapshotId,
        scenarioKey: materialized.scenarioKey,
        routeApprovalFingerprint: route.fingerprint,
        scheduleApprovalFingerprint: schedule.fingerprint,
        inputFingerprint: schedule.fingerprint,
        travelVariant: trip.travelVariant,
        adults: trip.adults,
        sightseeingDate: trip.sightseeingDate,
        effectiveLevel: preferencesOf(trip).defaultServiceLevel,
        traceId: newTraceId(),
        preferences: preferencesOf(trip),
      });
      const created = await createOutboundDelegation(deps.pool, {
        tripId: context.tripId,
        operationId: claim.operationId,
        acceptedRevision: claim.acceptedRevision,
        skillId: deps.agents.flight.skillId,
        agentIdentity: deps.agents.flight.agentIdentity,
        endpointUrl: deps.agents.flight.endpointUrl,
        snapshotId: materialized.snapshotId,
        inputFingerprint: schedule.fingerprint,
        domains: ["flights"],
        allowRouteValidation: true,
        allowItinerary: false,
        taskData,
        deadlineAt: new Date(Date.now() + 600_000).toISOString(),
      });
      const delegationIds = [
        ...data.delegationIds.filter((id) => id !== created.delegationId),
        created.delegationId,
      ];
      const next = runDataWith(data, {
        delegationIds,
        acceptedArtifacts: data.acceptedArtifacts,
      });
      // Delivery happens outside the persistence step (no tx spans HTTP) and is
      // idempotent: the persisted outbound payload is re-delivered on recovery.
      const delivered = await deliverDelegation(deps.pool, deps.transport, {
        delegationId: created.delegationId,
        agentIdentity: deps.agents.flight.agentIdentity,
        data: created.taskData,
      });
      if (!delivered.delivered) {
        deps.logger?.({
          level: "warn",
          component: "coordinator",
          message: "flight delegation delivery failed",
          delegationId: created.delegationId,
          reason: delivered.reason,
        });
      }
      return { kind: "continue", step: "researching", runData: next };
    }
    case "planning": {
      // Phase 08: a started itinerary delegation is polled until it settles.
      // The approval/conflict wait clears the binding, so a later decision
      // operation falls through to the decision handler below.
      if (data.itineraryDelegationId) {
        const trip = await getTrip(deps.pool, context.tripId);
        if (!trip) {
          return {
            kind: "fail",
            runData: runDataWith(data, {}),
            code: "NOT_FOUND",
            reason: "trip not found",
          };
        }
        return pollItineraryAttempt(itineraryLoop(deps), claim, trip, data);
      }
      if (claim.kind !== "decision") {
        return {
          kind: "fail",
          runData: runDataWith(data, {}),
          code: "COORDINATOR_STEP_UNSUPPORTED",
          reason: "the planning step needs a decision operation",
        };
      }
      // Booking/program stage of a decision operation: the accepted response is
      // re-validated against the engine-bound pending decision, then staged.
      const payload = (await deps.ports.loadOperationPayload(claim.operationId)) as {
        decisionId?: string;
        response?: { action?: string; offerId?: string };
      } | null;
      if (!payload?.decisionId || !payload.response?.action) {
        return {
          kind: "fail",
          runData: runDataWith(data, {}),
          code: "INVALID_ARTIFACT",
          reason: "the decision operation payload is not a valid response envelope",
        };
      }
      const decision = await loadDecision(deps.pool, payload.decisionId);
      // Commit-before-cursor replay (plan §3.14): the booking effect may have
      // committed and resolved the decision before the coordinator cursor was
      // advanced. A confirmed reservation keyed by THIS operation is durable
      // proof of that committed effect, so the same operation may replay it.
      let replayCommittedBooking = false;
      if (
        decision?.status === "resolved" &&
        decision.coordinatorRunId === run.id &&
        (decision.kind === "booking_confirmation" ||
          decision.kind === "replacement_confirmation") &&
        decision.proposalId
      ) {
        const proposal = await getProposal(deps.pool, context.tripId, decision.proposalId);
        if (proposal) {
          const reservation = await getReservationByConfirmationKey(
            deps.pool,
            context.tripId,
            `confirm:${proposal.serviceKey}:${claim.operationId}:${decision.proposalId}`,
          );
          replayCommittedBooking = reservation !== undefined;
          if (!replayCommittedBooking) {
            // `decline_booking` commits a stored effect and a selection, not a
            // reservation. The effect ledger is the durable proof of that
            // committed decision (plan §3.14).
            const declineEffect = await deps.pool.query(
              `SELECT 1 FROM odft_app.workflow_effects
                WHERE operation_id = $1 AND node_name = 'decline_booking'
                  AND effect_scope = $2`,
              [claim.operationId, decision.proposalId],
            );
            replayCommittedBooking = (declineEffect.rowCount ?? 0) > 0;
          }
        }
      }
      if (
        !decision ||
        (decision.status !== "pending" && !replayCommittedBooking) ||
        decision.coordinatorRunId !== run.id
      ) {
        return {
          kind: "fail",
          runData: runDataWith(data, {}),
          code: "STALE_DECISION",
          reason: "the decision is missing, resolved, or owned by another run",
        };
      }
      const trip = await getTrip(deps.pool, context.tripId);
      if (!trip) {
        return {
          kind: "fail",
          runData: runDataWith(data, {}),
          code: "NOT_FOUND",
          reason: "trip not found",
        };
      }
      const progressBefore = await deps.ports.loadProgress(context.tripId);
      let declineResult: Awaited<ReturnType<typeof deps.ports.declineBooking>> | undefined;
      if (decision.kind === "flight_choice" || decision.kind === "hotel_choice") {
        const offerId = payload.response.offerId;
        if (payload.response.action !== "choose_offer" || !offerId) {
          return {
            kind: "fail",
            runData: runDataWith(data, {}),
            code: "STALE_DECISION",
            reason: "the choice must select an offered id",
          };
        }
        if (!decision.allowedOfferIds.includes(offerId)) {
          return {
            kind: "fail",
            runData: runDataWith(data, {}),
            code: "STALE_DECISION",
            reason: "the chosen offer is not among the offered ids",
          };
        }
        const service = decision.kind === "hotel_choice" ? "hotel" : "flights";
        const sourceFingerprint = fingerprint({
          kind: "booking_confirmation",
          tripId: context.tripId,
          operationId: claim.operationId,
          service,
          offerId,
          snapshotId: trip.activeScenarioSnapshotId ?? "",
        });
        const proposal = await deps.ports.propose({
          tripId: context.tripId,
          operationId: claim.operationId,
          service,
          offerId,
          sourceFingerprint,
        });
        const progress = await deps.ports.loadProgress(context.tripId);
        const replacing = progress.confirmedServices.includes(service);
        return {
          kind: "wait",
          step: "awaiting_user",
          waitReason: replacing ? "replacement_confirmation" : "booking_confirmation",
          runData: runDataWith(data, {}),
          fingerprint: sourceFingerprint,
          allowedOptionIds: [],
          // The confirmation decision carries the offered set, so the booking
          // service can re-validate the selected offer (graph parity).
          allowedOfferIds: decision.allowedOfferIds,
          proposalId: proposal.proposalId,
          optionPayload: { offerId, service },
        };
      }
      if (decision.kind === "agent_input") {
        // The accepted answer is sent as a continuation of the ANSWERING task
        // only; unrelated working siblings are never touched (plan §3.10).
        if (payload.response.action !== "choose_option") {
          return {
            kind: "fail",
            runData: runDataWith(data, {}),
            code: "STALE_DECISION",
            reason: "a specialist question accepts choose_option",
          };
        }
        const binding = decision.optionPayload as {
          requestId?: string;
          delegationId?: string;
          taskId?: string;
          contextId?: string;
          inputGeneration?: number;
          options?: { id: string }[];
        };
        const optionId = (payload.response as { optionId?: string }).optionId;
        if (
          !binding?.delegationId ||
          !binding.taskId ||
          !optionId ||
          !(binding.options ?? []).some((option) => option.id === optionId)
        ) {
          return {
            kind: "fail",
            runData: runDataWith(data, {}),
            code: "STALE_DECISION",
            reason: "the answer does not match the persisted question binding",
          };
        }
        const answering = await getAgentDelegation(deps.pool, binding.delegationId);
        if (!answering?.taskId) {
          return {
            kind: "fail",
            runData: runDataWith(data, {}),
            code: "STALE_AGENT_RESULT",
            reason: "the answering delegation has no saved task",
          };
        }
        const persisted = await loadDelegationDelivery(deps.pool, binding.delegationId);
        if (!persisted.outbound) {
          return {
            kind: "fail",
            runData: runDataWith(data, {}),
            code: "STALE_AGENT_RESULT",
            reason: "the answering delegation has no persisted request",
          };
        }
        // The agent's admission increments the input generation when the
        // continuation arrives: the message carries the question's + 1.
        const continuationRequest = {
          ...(persisted.outbound.payload as Record<string, unknown>),
          continuation: {
            inputGeneration: (binding.inputGeneration ?? 1) + 1,
            answerRequestId: binding.requestId,
            selectedOptionId: optionId,
          },
        };
        await insertContinuationOutbound(deps.pool, {
          delegationId: binding.delegationId,
          payload: continuationRequest,
          continuationGeneration: (binding.inputGeneration ?? 1) + 1,
        });
        const delivered = await deliverDelegation(deps.pool, deps.transport, {
          delegationId: binding.delegationId,
          agentIdentity: answering.agentIdentity,
          data: continuationRequest,
          taskId: answering.taskId,
          contextId: binding.contextId ?? answering.contextId ?? "",
        });
        if (!delivered.delivered) {
          return {
            kind: "fail",
            runData: runDataWith(data, {}),
            code: "MCP_UNAVAILABLE",
            reason: `the continuation could not be delivered: ${delivered.reason ?? "unknown"}`,
          };
        }
        return {
          kind: "continue",
          step: "researching",
          runData: runDataWith(data, {
            delegationIds: data.delegationIds.includes(binding.delegationId)
              ? data.delegationIds
              : [...data.delegationIds, binding.delegationId],
          }),
        };
      }
      if (
        decision.kind === "booking_confirmation" ||
        decision.kind === "replacement_confirmation"
      ) {
        const action = payload.response.action;
        if (!decision.proposalId) {
          return {
            kind: "fail",
            runData: runDataWith(data, {}),
            code: "STALE_DECISION",
            reason: "the booking decision carries no proposal binding",
          };
        }
        const proposal = await getProposal(deps.pool, context.tripId, decision.proposalId);
        // `accepted`/`rejected` are the commit-before-cursor replay: the effect
        // is idempotent by confirmationKey/decision, so the same call replays.
        if (
          !proposal ||
          proposal.tripId !== context.tripId ||
          (proposal.status !== "proposed" &&
            proposal.status !== "accepted" &&
            proposal.status !== "rejected")
        ) {
          return {
            kind: "fail",
            runData: runDataWith(data, {}),
            code: "STALE_DECISION",
            reason: "the staged proposal is missing or no longer proposed",
          };
        }
        const service = proposal.serviceKey;
        const confirmationKey = `confirm:${service}:${claim.operationId}:${decision.proposalId}`;
        if (action === "confirm_booking") {
          const result =
            decision.kind === "replacement_confirmation"
              ? await deps.ports.replace({
                  tripId: context.tripId,
                  operationId: claim.operationId,
                  service,
                  proposalId: decision.proposalId,
                  decisionId: decision.id,
                  acceptedRevision: claim.acceptedRevision,
                  confirmationKey,
                })
              : await deps.ports.confirm({
                  tripId: context.tripId,
                  operationId: claim.operationId,
                  proposalId: decision.proposalId,
                  decisionId: decision.id,
                  acceptedRevision: claim.acceptedRevision,
                  confirmationKey,
                });
          if (result.status !== "confirmed") {
            return {
              kind: "fail",
              runData: runDataWith(data, {}),
              code: "CONFLICT",
              reason: "the booking was not confirmed",
            };
          }
        } else if (action === "decline_booking") {
          declineResult = await deps.ports.declineBooking({
            tripId: context.tripId,
            operationId: claim.operationId,
            proposalId: decision.proposalId,
            decisionId: decision.id,
          });
        } else {
          return {
            kind: "fail",
            runData: runDataWith(data, {}),
            code: "COORDINATOR_STEP_UNSUPPORTED",
            reason: `booking response ${String(action)} is not implemented by this coordinator version`,
          };
        }
        // The confirmed/declined service determines the next stage, exactly like
        // the graph: an initial flight booking continues into hotel research.
        const progress = await deps.ports.loadProgress(context.tripId);
        if (progress.programApplied) {
          // A late replacement that changes the kept offer invalidates the plan
          // and replans it (graph `declinedSelectionChanged`). Booking the same
          // kept offer again changes no inputs and ends the run.
          const stagedProposal = decision.proposalId
            ? await getProposal(deps.pool, context.tripId, decision.proposalId)
            : undefined;
          const selectedOfferId = declineResult?.offerId ?? stagedProposal?.offerId;
          const previousSelection = progressBefore.selectionOfferIds[service];
          const selectionChanged =
            previousSelection !== undefined &&
            selectedOfferId !== undefined &&
            previousSelection !== selectedOfferId;
          // A replacement always changes the plan inputs; a new selection after
          // the program was saved changes them too (graph parity).
          const replacementChanged =
            decision.kind === "replacement_confirmation" || selectionChanged;
          if (replacementChanged) {
            return startItineraryAttempt(
              itineraryLoop(deps),
              claim,
              trip,
              {
                ...data,
                planningAttempt: 0,
                feedback: [],
                itineraryId: null,
                itineraryReviewFingerprint: null,
              },
              [],
            );
          }
          return {
            kind: "complete",
            runData: runDataWith(data, {}),
            result: { service, action },
            summary: "booking recorded after the trip was already planned",
            workflowStatus: "ready",
          };
        }
        if (
          service === "flights" &&
          !progress.hotelConfirmed &&
          !progress.selectedServices.includes("hotel")
        ) {
          const research = await dispatchSpecialistResearch(deps, claim, trip, data);
          if (research.kind === "fail") {
            return research;
          }
          return {
            kind: "continue",
            step: "researching",
            runData: runDataWith(data, { delegationIds: research.delegationIds }),
          };
        }
        // The hotel side is settled (booked or kept as a selection): open the
        // program choices from the City Guide specialist's ranked domains. The
        // helper re-researches only the failed City Guide domains when the
        // earlier task failed, preserving the confirmed hotel (plan §3.11).
        return openProgramChoices(deps, claim, data);
      }
      if (decision.kind === "program_choices") {
        if (payload.response.action !== "submit_program") {
          return {
            kind: "fail",
            runData: runDataWith(data, {}),
            code: "STALE_DECISION",
            reason: "the program decision only accepts submit_program",
          };
        }
        const response = payload.response as {
          mealOfferIds: MealSelections;
          selfArrangedMeals: Meal[];
          preferredActivityIds: string[];
          activitiesSelfArranged?: boolean;
        };
        const allowedMeals = new Set(decision.allowedOfferIds);
        if (allowedMeals.size > 0) {
          for (const meal of ["breakfast", "lunch", "dinner"] as const) {
            const offerId = response.mealOfferIds[meal];
            if (offerId !== null && !allowedMeals.has(offerId)) {
              return {
                kind: "fail",
                runData: runDataWith(data, {}),
                code: "STALE_DECISION",
                reason: `the ${meal} offer is no longer among the offered choices`,
              };
            }
          }
        }
        const allowedActivities = new Set(decision.allowedOptionIds);
        if (allowedActivities.size > 0) {
          for (const activityId of response.preferredActivityIds) {
            if (!allowedActivities.has(activityId)) {
              return {
                kind: "fail",
                runData: runDataWith(data, {}),
                code: "STALE_DECISION",
                reason: "an activity is no longer among the offered choices",
              };
            }
          }
        }
        const trip = await getTrip(deps.pool, context.tripId);
        if (!trip) {
          return {
            kind: "fail",
            runData: runDataWith(data, {}),
            code: "NOT_FOUND",
            reason: "trip not found",
          };
        }
        return applyProgramAndPlan(
          deps,
          claim,
          trip,
          data,
          {
            mealSelections: response.mealOfferIds,
            selfArrangedMeals: response.selfArrangedMeals,
            preferredActivityIds: response.preferredActivityIds,
            activitiesSelfArranged: response.activitiesSelfArranged ?? false,
          },
          null,
        );
      }
      if (decision.kind === "itinerary_approval") {
        if (payload.response.action !== "approve_itinerary") {
          return {
            kind: "fail",
            runData: runDataWith(data, {}),
            code: "STALE_DECISION",
            reason: "the itinerary decision only accepts approve_itinerary",
          };
        }
        const itineraryId = (payload.response as { itineraryId?: string }).itineraryId;
        const bound = (decision.optionPayload as { itineraryId?: string } | null)?.itineraryId;
        if (!itineraryId || (bound && bound !== itineraryId)) {
          return {
            kind: "fail",
            runData: runDataWith(data, {}),
            code: "STALE_DECISION",
            reason: "the approved itinerary is not the version this decision was opened for",
          };
        }
        const approved = await deps.ports.approveItinerary({
          tripId: context.tripId,
          operationId: claim.operationId,
          decisionId: decision.id,
          acceptedRevision: claim.acceptedRevision,
          itineraryId,
        });
        return {
          kind: "complete",
          runData: runDataWith(data, { itineraryId: approved.itineraryId }),
          result: { itineraryId: approved.itineraryId, version: approved.version },
          summary: "Your itinerary is approved and saved.",
          workflowStatus: "ready",
        };
      }
      if (decision.kind === "route_change_confirmation") {
        if (payload.response.action !== "confirm_route_change") {
          return {
            kind: "fail",
            runData: runDataWith(data, {}),
            code: "STALE_DECISION",
            reason: "the route change decision only accepts confirm_route_change",
          };
        }
        const response = payload.response as {
          proposalId?: string;
          affectedReservationIds?: string[];
        };
        const optionPayload = decision.optionPayload as {
          proposalId?: string;
          affectedReservations?: { id: string }[];
        } | null;
        const expected = [
          ...(optionPayload?.affectedReservations ?? []).map((entry) => entry.id),
        ].sort();
        const given = [...(response.affectedReservationIds ?? [])].sort();
        if (
          !optionPayload?.proposalId ||
          response.proposalId !== optionPayload.proposalId ||
          expected.length !== given.length ||
          expected.some((id, index) => id !== given[index])
        ) {
          return {
            kind: "fail",
            runData: runDataWith(data, {}),
            code: "STALE_DECISION",
            reason: "the confirmed route change no longer matches its impact preview",
          };
        }
        await deps.ports.commitRouteChange({
          tripId: context.tripId,
          operationId: claim.operationId,
          decisionId: decision.id,
          acceptedRevision: claim.acceptedRevision,
          proposalId: optionPayload.proposalId,
          affectedReservationIds: expected,
          commands: data.routeChangeCommands,
        });
        return {
          kind: "continue",
          step: "validating_route",
          runData: runDataWith(data, {
            planningAttempt: 0,
            feedback: [],
            itineraryDelegationId: null,
            itineraryId: null,
            itineraryReviewFingerprint: null,
          }),
        };
      }
      if (decision.kind === "clarification" || decision.kind === "recovery") {
        if (payload.response.action !== "choose_option") {
          return {
            kind: "fail",
            runData: runDataWith(data, {}),
            code: "STALE_DECISION",
            reason: "a clarification/recovery decision only accepts choose_option",
          };
        }
        const optionId = (payload.response as { optionId?: string }).optionId;
        if (!optionId || !(decision.allowedOptionIds ?? []).includes(optionId)) {
          return {
            kind: "fail",
            runData: runDataWith(data, {}),
            code: "STALE_DECISION",
            reason: "the chosen option is no longer offered",
          };
        }
        const optionPayload = decision.optionPayload as {
          options?: {
            id: string;
            label?: string;
            reopen?: string;
            commands?: DomainCommand[];
          }[];
          optionCommands?: Record<string, DomainCommand[]>;
          researchFailed?: boolean;
        } | null;
        const option = optionPayload?.options?.find((entry) => entry.id === optionId);
        if (!option) {
          return {
            kind: "fail",
            runData: runDataWith(data, {}),
            code: "STALE_DECISION",
            reason: "the chosen option has no stored commands",
          };
        }
        if (optionPayload?.researchFailed) {
          // End the run on the failed step so the empty/failed panel and its
          // retry action are visible. The unavailable research events are
          // already persisted; no reservation changed.
          return {
            kind: "complete",
            workflowStatus: "ready",
            summary: `Adjust: ${option.label ?? option.id}.`,
            result: { recovered: optionId },
            runData: runDataWith(data, { researchTarget: null }),
          };
        }
        if (option.reopen === "hotel_choice") {
          return openHotelChoice(deps, claim, data);
        }
        if (option.reopen === "program_choices") {
          return openProgramChoices(deps, claim, data);
        }
        const optionCommands = optionPayload?.optionCommands?.[optionId] ?? option.commands ?? [];
        if (optionCommands.length > 0) {
          const trip = await getTrip(deps.pool, context.tripId);
          if (!trip) {
            return {
              kind: "fail",
              runData: runDataWith(data, {}),
              code: "NOT_FOUND",
              reason: "trip not found",
            };
          }
          return applyCommandBatch(
            deps,
            claim,
            trip,
            data,
            optionCommands,
            `Applied: ${option.label ?? option.id}.`,
          );
        }
        const trip = await getTrip(deps.pool, context.tripId);
        if (!trip) {
          return {
            kind: "fail",
            runData: runDataWith(data, {}),
            code: "NOT_FOUND",
            reason: "trip not found",
          };
        }
        return resolveProgressAfterBatch(deps, claim, trip, data, null);
      }
      return {
        kind: "fail",
        runData: runDataWith(data, {}),
        code: "COORDINATOR_STEP_UNSUPPORTED",
        reason: `decision kind ${decision.kind} is not implemented by this coordinator version`,
      };
    }
    case "researching": {
      if (data.delegationIds.length === 0) {
        return {
          kind: "fail",
          runData: runDataWith(data, {}),
          code: "NO_DELEGATION",
          reason: "no delegation is bound to the research step",
        };
      }
      const waitMs = deps.delegationWaitMs ?? DEFAULT_DELEGATION_WAIT_MS;
      const startedAt = Date.now();
      let hotel: { payloadHash: string; rankedIds: string[] } | null = null;
      let city: {
        outcomes?: {
          domain?: string;
          status?: string;
          rankedOfferIds?: string[];
          inputFingerprint?: string | null;
          simulatedFailure?: boolean;
          reason?: string | null;
        }[];
      } | null = null;
      const queue = [...(data.questionQueue ?? [])];
      // Terminal specialist failures are collected instead of failing the whole
      // pass immediately: a completed hotel must not be discarded because an
      // unrelated City Guide query failed (plan §3.11), and a failed delegation
      // must be marked terminal so an owner retry creates a FRESH scoped
      // delegation instead of polling the same failed task forever.
      const failedDelegations: {
        delegationId: string;
        skillId: string;
        code: string;
        reason: string;
        domains: ResearchDomain[];
        retryable: boolean;
      }[] = [];
      // Consecutive read failures per delegation. A transient network blip must
      // not terminalize a possibly-live paid computation (plan §3.12).
      const pollFailures = new Map<string, number>();
      for (;;) {
        // `drained` is true while every submitted sibling is terminal OR
        // awaiting an answer; a WORKING sibling blocks the question promotion.
        let drained = true;
        // A delegation whose outbound intent exists but whose acknowledgement
        // was lost (agent crash after admission) must be re-delivered before a
        // choice parks: the same message id replays the canonical task and
        // binds it, so no duplicate paid work starts.
        let unacknowledged = false;
        // A delivery acknowledged in THIS pass must be polled once before a
        // choice parks: a replayed canonical task may already be terminal
        // (AGENT_RESTARTED), and that terminal state must be reconciled first.
        let newlyBound = false;
        if (deps.signal?.aborted) {
          return {
            kind: "abandon",
            runData: runDataWith(data, { questionQueue: queue, drainPending: queue.length > 0 }),
          };
        }
        for (const delegationId of data.delegationIds) {
          const delegation = await getAgentDelegation(deps.pool, delegationId);
          if (!delegation) {
            return {
              kind: "fail",
              runData: runDataWith(data, {}),
              code: "NOT_FOUND",
              reason: "a persisted delegation is missing",
            };
          }
          // Phase 08: a later user operation revoked the superseded delegation;
          // its eventual artifact must never be applied to this revision.
          if (delegation.status === "revoked") {
            continue;
          }
          // A previous pass already proved this delegation terminal. It stays
          // in the run data for audit but never blocks the drain.
          if (delegation.status === "failed" || delegation.status === "cancelled") {
            continue;
          }
          if (delegation.status === "completed") {
            // Accepted earlier (hash on the delegation row). Re-derive the
            // outcome so a later pass can still park the SAME choice after an
            // intervening question/restart. The flight artifact must be
            // re-derived too: a crash between acceptance and the flight_choice
            // park would otherwise fall through to STALE_AGENT_RESULT.
            if (delegation.skillId === "flight.recommend.v1") {
              const progress = await deps.ports.loadProgress(claim.tripId);
              const flightSettled =
                progress.flightConfirmed || progress.selectedServices.includes("flights");
              if (!flightSettled) {
                let payload: { rankedCombinationIds?: unknown } | undefined;
                try {
                  payload = (await acceptedArtifactPayload(deps, delegationId)) as
                    { rankedCombinationIds?: unknown } | undefined;
                } catch {
                  return {
                    kind: "abandon",
                    runData: runDataWith(data, { questionQueue: queue }),
                  };
                }
                const ranked = payload?.rankedCombinationIds;
                if (Array.isArray(ranked) && ranked.length > 0) {
                  return {
                    kind: "wait",
                    step: "awaiting_user",
                    waitReason: "flight_choice",
                    runData: runDataWith(data, { questionQueue: queue, drainPending: false }),
                    fingerprint: delegation.acceptedArtifactHash ?? contentHash(payload ?? {}),
                    allowedOptionIds: [],
                    allowedOfferIds: ranked as string[],
                    optionPayload: { rankedCombinationIds: ranked },
                  };
                }
              }
            }
            // Accepted earlier (hash on the delegation row). Re-derive the
            // accommodation outcome so a later pass can still park the hotel
            // choice after an intervening question was answered.
            if (delegation.skillId === "accommodation.recommend.v1" && !hotel) {
              let payload: { rankedHotelOfferIds?: unknown } | undefined;
              try {
                payload = (await acceptedArtifactPayload(deps, delegationId)) as
                  { rankedHotelOfferIds?: unknown } | undefined;
              } catch {
                return {
                  kind: "abandon",
                  runData: runDataWith(data, { questionQueue: queue }),
                };
              }
              if (
                Array.isArray(payload?.rankedHotelOfferIds) &&
                payload.rankedHotelOfferIds.length > 0
              ) {
                hotel = {
                  payloadHash: delegation.acceptedArtifactHash ?? contentHash(payload),
                  rankedIds: payload.rankedHotelOfferIds as string[],
                };
                await ingestHotelArtifact(deps, claim, delegationId, hotel.rankedIds, {
                  recordEvents: false,
                  attempt: delegation.attempt,
                  searchIntent: data.searchIntent,
                });
              }
            }
            if (delegation.skillId === "city-guide.research.v1" && !city) {
              let payload:
                | {
                    outcomes?: {
                      domain?: string;
                      status?: string;
                      rankedOfferIds?: string[];
                      inputFingerprint?: string | null;
                      simulatedFailure?: boolean;
                      reason?: string | null;
                    }[];
                  }
                | undefined;
              try {
                payload = (await acceptedArtifactPayload(deps, delegationId)) as
                  | {
                      outcomes?: {
                        domain?: string;
                        status?: string;
                        rankedOfferIds?: string[];
                        inputFingerprint?: string | null;
                        simulatedFailure?: boolean;
                        reason?: string | null;
                      }[];
                    }
                  | undefined;
              } catch {
                return {
                  kind: "abandon",
                  runData: runDataWith(data, { questionQueue: queue }),
                };
              }
              if (payload?.outcomes) {
                city = payload;
                await ingestCityArtifact(deps, claim, data, payload, {
                  recordEvents: false,
                  attempt: delegation.attempt,
                });
              }
            }
            continue;
          }
          if (!delegation.taskId) {
            drained = false;
            const persisted = await loadDelegationDelivery(deps.pool, delegationId);
            if (persisted.outbound) {
              const delivered = await deliverDelegation(deps.pool, deps.transport, {
                delegationId,
                agentIdentity: delegation.agentIdentity,
                data: persisted.outbound.payload,
              });
              if (!delivered.delivered) {
                unacknowledged = true;
              } else {
                newlyBound = true;
              }
            } else {
              unacknowledged = true;
            }
            continue;
          }
          const task = await deps.transport
            .getTask({
              agentIdentity: delegation.agentIdentity,
              taskId: delegation.taskId,
            })
            .catch(async (error: unknown) => {
              const failures = (pollFailures.get(delegationId) ?? 0) + 1;
              pollFailures.set(delegationId, failures);
              if (failures <= 5) {
                return "retry" as const;
              }
              const code = safeAgentFailureCode(error, "AGENT_UNAVAILABLE");
              const reason =
                error instanceof Error ? error.message : "the specialist task read failed";
              await markDelegationFailed(deps, claim.tripId, delegation, code, reason);
              failedDelegations.push({
                delegationId,
                skillId: delegation.skillId,
                code,
                reason,
                domains: researchDomainsOf(delegation),
                retryable: true,
              });
              return null;
            });
          if (task === "retry") {
            drained = false;
            continue;
          }
          if (!task) {
            continue;
          }
          pollFailures.delete(delegationId);
          if (task.state === "failed" || task.state === "canceled") {
            const code = safeAgentFailureCode(task.failureCode, "AGENT_FAILED");
            const reason =
              task.failureCode ?? `the ${delegation.skillId} specialist ${task.state} the task`;
            await markDelegationFailed(deps, claim.tripId, delegation, code, reason);
            failedDelegations.push({
              delegationId,
              skillId: delegation.skillId,
              code,
              reason,
              domains: researchDomainsOf(delegation),
              retryable: /retryable_error/i.test(reason),
            });
            continue;
          }
          if (task.state === "rejected" || task.state === "auth_required") {
            const code = "AGENT_FAILED";
            const reason = `the ${delegation.skillId} specialist ${task.state} the task`;
            await markDelegationFailed(deps, claim.tripId, delegation, code, reason);
            failedDelegations.push({
              delegationId,
              skillId: delegation.skillId,
              code,
              reason,
              domains: researchDomainsOf(delegation),
              retryable: /retryable_error/i.test(reason),
            });
            continue;
          }
          if (task.state === "input_required") {
            // A genuine specialist question is persisted in the FIFO queue and
            // NO answerable decision is exposed until every submitted sibling
            // reached a terminal state (drain-before-decision, plan §3.10).
            const question = task.question as
              | {
                  correlation?: { delegationId?: string };
                  requestId?: string;
                  question?: string;
                  options?: { id: string; label?: string }[];
                  inputGeneration?: number;
                  requestHash?: string;
                  expiresAt?: string;
                }
              | undefined;
            const alreadyQueued =
              question?.requestId !== undefined &&
              queue.some((entry) => entry.requestId === question.requestId);
            if (question?.requestId && question.inputGeneration !== undefined && !alreadyQueued) {
              // The queue stores the binding only (contract shape); the question
              // text and options are re-read from the saved task at promotion.
              queue.push({
                requestId: question.requestId,
                delegationId,
                taskId: delegation.taskId,
                contextId: delegation.contextId ?? "",
                inputGeneration: question.inputGeneration,
                requestHash: question.requestHash ?? contentHash(question),
                expiresAt: question.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
                observedAt: new Date().toISOString(),
              });
            }
            continue;
          }
          if (task.state !== "completed") {
            // Still working: a queued INPUT REQUIRED task does not block the
            // drain, but a working sibling does (plan §3.10).
            drained = false;
            continue;
          }
          let accepted: ReturnType<typeof acceptArtifact>;
          let acceptedArtifactId = "";
          const rankingField =
            delegation.skillId === "flight.recommend.v1"
              ? "rankedCombinationIds"
              : delegation.skillId === "accommodation.recommend.v1"
                ? "rankedHotelOfferIds"
                : "outcomes";
          for (const artifact of task.artifacts) {
            // The DELEGATION is the binding (a continuation artifact carries the
            // delegation's originating operation, not the current claim), and
            // the target artifact is the one carrying this skill's ranking
            // payload (never the question artifact of the same task).
            const candidate = acceptArtifact({
              artifact: artifact.data,
              delegation,
              operationId: delegation.originatingOperationId,
              acceptedRevision: delegation.acceptedRevision,
            });
            if (
              candidate &&
              (candidate.value as Record<string, unknown>)[rankingField] !== undefined
            ) {
              accepted = candidate;
              acceptedArtifactId = artifact.artifactId;
              break;
            }
          }
          if (!accepted) {
            return {
              kind: "fail",
              runData: runDataWith(data, {}),
              code: "STALE_AGENT_RESULT",
              reason: `the ${delegation.skillId} task completed without an acceptable artifact`,
            };
          }
          const value = accepted.value as {
            rankedCombinationIds?: unknown;
            rankedHotelOfferIds?: unknown;
            outcomes?: {
              domain?: string;
              status?: string;
              rankedOfferIds?: string[];
              inputFingerprint?: string | null;
              simulatedFailure?: boolean;
              reason?: string | null;
            }[];
          };
          // Terminal-status guard: a cancellation that commits while this task
          // completes must win. A revoked delegation is never resurrected and
          // its late artifact is not ingested (plan §3.8/§3.14).
          const acceptedNow = await acceptDelegationArtifact(deps.pool, {
            delegationId,
            artifactHash: accepted.payloadHash,
          });
          if (!acceptedNow) {
            return {
              kind: "abandon",
              runData: runDataWith(data, { questionQueue: queue }),
            };
          }
          if (delegation.skillId === "flight.recommend.v1") {
            const ranked = value.rankedCombinationIds;
            if (!Array.isArray(ranked) || ranked.length === 0) {
              return {
                kind: "fail",
                runData: runDataWith(data, {}),
                code: "STALE_AGENT_RESULT",
                reason: "the flight artifact carries no ranked combinations",
              };
            }
            return {
              kind: "wait",
              step: "awaiting_user",
              waitReason: "flight_choice",
              runData: runDataWith(data, { questionQueue: queue, drainPending: false }),
              fingerprint: accepted.payloadHash,
              allowedOptionIds: [],
              allowedOfferIds: ranked as string[],
              optionPayload: { rankedCombinationIds: ranked },
            };
          }
          if (delegation.skillId === "accommodation.recommend.v1") {
            const ranked = value.rankedHotelOfferIds;
            if (!Array.isArray(ranked) || ranked.length === 0) {
              return {
                kind: "fail",
                runData: runDataWith(data, {}),
                code: "STALE_AGENT_RESULT",
                reason: "the accommodation artifact carries no ranked hotels",
              };
            }
            hotel = { payloadHash: accepted.payloadHash, rankedIds: ranked as string[] };
            await ingestHotelArtifact(deps, claim, delegationId, hotel.rankedIds, {
              attempt: delegation.attempt,
              searchIntent: data.searchIntent,
            });
          }
          if (delegation.skillId === "city-guide.research.v1") {
            if (!value.outcomes) {
              return {
                kind: "fail",
                runData: runDataWith(data, {}),
                code: "STALE_AGENT_RESULT",
                reason: "the city-guide artifact carries no domain outcomes",
              };
            }
            city = value;
            await ingestCityArtifact(deps, claim, data, value, {
              attempt: delegation.attempt,
            });
          }
          void acceptedArtifactId;
        }
        // Decide whether a terminal specialist failure blocks THIS pass. A
        // flight failure always blocks; a hotel failure blocks the hotel choice;
        // a City Guide failure only blocks the meal/program step. A completed
        // sibling artifact is never discarded (plan §3.11/§3.17).
        if (failedDelegations.length > 0) {
          const flightFailure = failedDelegations.find(
            (failure) => failure.skillId === "flight.recommend.v1",
          );
          const hotelFailure = failedDelegations.find(
            (failure) => failure.skillId === "accommodation.recommend.v1",
          );
          const cityFailure = failedDelegations.find(
            (failure) => failure.skillId === "city-guide.research.v1",
          );
          const needsHotel = data.researchTarget === null || data.researchTarget === "hotel_choice";
          const needsCity =
            data.researchTarget === "program_choices" || data.researchTarget === "plan";
          const blocking =
            flightFailure ??
            (needsHotel ? hotelFailure : undefined) ??
            (needsCity ? cityFailure : undefined);
          if (blocking) {
            // An infrastructure restart is not research unavailability: fail the
            // run so the owner can explicitly retry it (and only the failed
            // domain is re-dispatched). The research gate below handles genuine
            // unavailable domains.
            if (blocking.code === "AGENT_RESTARTED") {
              return {
                kind: "fail",
                runData: runDataWith(data, {
                  questionQueue: queue,
                  drainPending: queue.length > 0,
                }),
                code: blocking.code,
                reason: blocking.reason,
              };
            }
            // Phase 09 bounded retry: a transient provider failure gets one
            // fresh delegation before the gate opens a recovery decision.
            const retryable = failedDelegations.filter((failure) => failure.retryable);
            if (retryable.length > 0 && data.researchRetryAttempts < 1) {
              const retried = await retryResearchDelegations(deps, claim, data, retryable);
              if (retried) {
                return retried;
              }
            }
            // Phase 09 necessary-domain gate: a failed necessary research domain
            // opens a typed recovery decision instead of killing the operation.
            // The user re-opens the affected step; the persisted unavailable
            // research events then drive the retry panel. A flight failure still
            // blocks because no flight choice can be offered.
            const options: { id: string; label: string; reopen: string }[] = [];
            if (blocking.domains.includes("hotel")) {
              options.push({
                id: "change_hotel",
                label: "Adjust the hotel",
                reopen: "hotel_choice",
              });
            }
            if (blocking.domains.some((domain) => domain !== "hotel")) {
              options.push({
                id: "change_program",
                label: "Adjust the program",
                reopen: "program_choices",
              });
            }
            if (options.length === 0) {
              return {
                kind: "fail",
                runData: runDataWith(data, {
                  questionQueue: queue,
                  drainPending: queue.length > 0,
                }),
                code: blocking.code,
                reason: blocking.reason,
              };
            }
            return {
              kind: "wait",
              step: "awaiting_user",
              waitReason: "recovery",
              runData: runDataWith(data, {
                questionQueue: queue,
                drainPending: queue.length > 0,
              }),
              fingerprint: contentHash({
                researchFailed: blocking.domains,
                code: blocking.code,
              }),
              allowedOptionIds: options.map((option) => option.id),
              allowedOfferIds: [],
              optionPayload: {
                question: blocking.reason.slice(0, 400),
                options,
                researchFailed: true,
                failedDomains: blocking.domains,
              },
            };
          }
        }
        // A queued question outranks a parked choice: promote exactly one FIFO
        // head AFTER the drain, before any choice park.
        if (queue.length > 0 && drained) {
          const queued = queue[0];
          if (queued && new Date(queued.expiresAt).getTime() <= Date.now()) {
            queue.shift();
            continue;
          }
          if (queued) {
            const answering = await getAgentDelegation(deps.pool, queued.delegationId);
            let questionTask: Awaited<ReturnType<typeof deps.transport.getTask>> | undefined;
            if (answering?.taskId) {
              try {
                questionTask = await deps.transport.getTask({
                  agentIdentity: answering.agentIdentity,
                  taskId: answering.taskId,
                });
              } catch {
                // Transient read error at promotion: preserve the queue and let
                // the next claim retry instead of failing the run.
                return {
                  kind: "abandon",
                  runData: runDataWith(data, { questionQueue: queue }),
                };
              }
            }
            const question = questionTask?.question as
              { question?: string; options?: { id: string; label?: string }[] } | undefined;
            const options = (question?.options ?? []).map((option) => ({
              id: option.id,
              label: option.label ?? option.id,
            }));
            if (options.length < 2) {
              queue.shift();
              continue;
            }
            queue.shift();
            return {
              kind: "wait",
              step: "awaiting_user",
              waitReason: "agent_input",
              runData: runDataWith(data, { questionQueue: queue, drainPending: false }),
              fingerprint: queued.requestHash,
              allowedOptionIds: options.map((option) => option.id),
              allowedOfferIds: [],
              optionPayload: {
                requestId: queued.requestId,
                delegationId: queued.delegationId,
                taskId: queued.taskId,
                contextId: queued.contextId,
                inputGeneration: queued.inputGeneration,
                question: (question?.question ?? "the specialist needs a missing preference").slice(
                  0,
                  400,
                ),
                options,
                requestHash: queued.requestHash,
                expiresAt: queued.expiresAt,
              },
            };
          }
        }
        if (data.researchTarget === "plan" && drained && queue.length === 0) {
          const trip = await getTrip(deps.pool, context.tripId);
          if (!trip) {
            return {
              kind: "fail",
              runData: runDataWith(data, {}),
              code: "NOT_FOUND",
              reason: "trip not found",
            };
          }
          return startItineraryAttempt(itineraryLoop(deps), claim, trip, data, []);
        }
        if (data.researchTarget === "program_choices" && drained && queue.length === 0) {
          return openProgramChoices(deps, claim, data);
        }
        if (hotel && !unacknowledged && !newlyBound) {
          return {
            kind: "wait",
            step: "awaiting_user",
            waitReason: "hotel_choice",
            // The (now empty) queue travels with the parked cursor.
            runData: runDataWith(data, { questionQueue: queue, drainPending: false }),
            fingerprint: hotel.payloadHash,
            allowedOptionIds: [],
            allowedOfferIds: hotel.rankedIds,
            optionPayload: { rankedHotelOfferIds: hotel.rankedIds },
          };
        }
        if (drained && queue.length === 0 && !unacknowledged && !newlyBound) {
          return {
            kind: "fail",
            runData: runDataWith(data, { questionQueue: queue, drainPending: false }),
            code: "STALE_AGENT_RESULT",
            reason: "the research delegations settled without a usable outcome",
          };
        }
        if (Date.now() - startedAt >= waitMs && !newlyBound) {
          // The operation stays running; its lease expires and the next claim
          // resumes this step from the persisted cursor (saved-task recovery).
          return {
            kind: "abandon",
            runData: runDataWith(data, { questionQueue: queue, drainPending: queue.length > 0 }),
          };
        }
        // An unacknowledged delivery is retried with a slower cadence: the
        // same message id is safe, but a down agent should not be hammered.
        await delay(unacknowledged ? 1_000 : 250);
      }
    }
    default:
      return {
        kind: "fail",
        runData: runDataWith(data, {}),
        code: "COORDINATOR_STEP_UNSUPPORTED",
        reason: `step ${run.step} is not implemented by this coordinator version`,
      };
  }
}

/**
 * Phase 08: a command that completes without publishing a new decision retires
 * the interrupted decision (graph parity). The unsupported-chat path either
 * re-publishes a still-answerable decision as a wait or lets this cancellation
 * retire the kinds whose answer state did not survive the takeover.
 */
async function cancelPendingCoordinatorDecisions(
  client: Pick<PoolClient, "query">,
  claim: ClaimedOperation,
  runId: string,
): Promise<void> {
  await client.query(
    `UPDATE odft_app.pending_decisions
        SET status = 'cancelled', resolved_at = now()
      WHERE trip_id = $1 AND status = 'pending' AND engine = 'coordinator-v1'
        AND coordinator_run_id = $2`,
    [claim.tripId, runId],
  );
}

/**
 * Phase 08: commit assistant wording with the SAME fenced transaction that
 * parks/completes the operation, keyed by the operation id so a crash replay
 * cannot append a second bubble. A failed operation never reaches this helper.
 */
async function appendAssistantMessage(
  client: Pick<PoolClient, "query">,
  claim: ClaimedOperation,
  runData: CoordinatorRunDataInput,
): Promise<void> {
  const content = runData.assistantMessage;
  if (!content) {
    return;
  }
  await insertConversationMessage(client as PoolClient, {
    tripId: claim.tripId,
    role: "assistant",
    content: content.slice(0, 2000),
    interpretation: {
      kind: runData.assistantInterpretationKind ?? "commands",
      ...(runData.assistantMessage
        ? { interpretation: runData.assistantMessage.slice(0, 2000) }
        : {}),
    },
    operationId: claim.operationId,
    requestId: claim.operationId,
    fence: {
      operationId: claim.operationId,
      tripId: claim.tripId,
      fencingToken: claim.fencingToken,
    },
  });
}

/**
 * Phase 08: retire a superseded operation's outstanding delegations and pending
 * decision before a later operation takes over the cursor. Both writes are
 * idempotent; a late artifact is refused by the delegation binding anyway, but
 * revoking makes the staleness explicit in the audit trail.
 */
async function revokeSupersededCoordinatorWork(
  pool: Pool,
  run: CoordinatorRunRecord,
): Promise<void> {
  await pool.query(
    `UPDATE odft_app.agent_delegations
        SET status = 'revoked', revoked_at = now(),
            revoke_reason = 'superseded by a later operation', updated_at = now()
      WHERE trip_id = $1 AND originating_operation_id = $2
        AND status IN ('pending', 'dispatched', 'working', 'input_required')`,
    [run.tripId, run.operationId],
  );
}

/** Run one claimed coordinator operation to its next resting point. */
export async function runCoordinatorOperation(
  deps: CoordinatorDispatchDeps,
  claim: ClaimedOperation,
): Promise<void> {
  const trip = await getTrip(deps.pool, claim.tripId);
  if (!trip) {
    throw new Error(`claimed operation ${claim.operationId} has no trip`);
  }
  if (trip.engine !== "coordinator-v1") {
    // Defense in depth: engine-filtered claims should make this unreachable.
    throw new Error(`operation ${claim.operationId} belongs to a ${trip.engine} trip`);
  }
  let run = await getActiveCoordinatorRun(deps.pool, claim.tripId);
  if (!run) {
    // Owner retry (plan §3.12): a terminally failed run bound to THIS operation
    // is reopened at `interpreting`. The durable run data (accepted siblings,
    // queue, fingerprints) is preserved; completed accepted delegations are
    // reused and only the failed scope is re-dispatched.
    const failed = await deps.pool.query<{ id: string }>(
      `SELECT id FROM odft_app.coordinator_runs
        WHERE trip_id = $1 AND operation_id = $2 AND status = 'failed'
        ORDER BY created_at DESC LIMIT 1`,
      [claim.tripId, claim.operationId],
    );
    const failedRunId = failed.rows[0]?.id;
    const failedRun = failedRunId ? await getCoordinatorRun(deps.pool, failedRunId) : undefined;
    if (failedRun) {
      run = await updateCoordinatorRun(deps.pool, {
        runId: failedRun.id,
        step: "interpreting",
        waitReason: null,
        status: "running",
        runData: failedRun.runData,
      });
    }
  }
  if (!run) {
    if (claim.kind === "decision") {
      // A decision always answers a decision owned by an active run.
      throw new Error(`no active coordinator run for operation ${claim.operationId}`);
    }
    // A new command/creation operation starts a fresh run (e.g. a modification
    // after the previous run completed).
    run = await insertCoordinatorRun(deps.pool, {
      tripId: claim.tripId,
      operationId: claim.operationId,
      acceptedRevision: claim.acceptedRevision,
      step: "initializing",
      runData: initialCoordinatorRunData(claim.tripId),
    });
  } else if (run.operationId !== claim.operationId) {
    // A later operation takes over a parked cursor. Supersede the old
    // operation's outstanding work FIRST: its late artifacts must never apply to
    // this revision (Phase 08 selective replanning).
    if (claim.kind !== "decision") {
      // A decision is a continuation (e.g. an answer to a specialist question),
      // not a new user revision: its delegations and decision must survive.
      await revokeSupersededCoordinatorWork(deps.pool, run);
    }
    // The run was parked; the decision operation takes over the cursor and
    // re-enters at `interpreting` (a decision op routes into the planning
    // stage). `running` rows must not carry a wait reason (schema constraint).
    run = await updateCoordinatorRun(deps.pool, {
      runId: run.id,
      operationId: claim.operationId,
      step: "interpreting",
      waitReason: null,
      status: "running",
      runData: {
        ...run.runData,
        itineraryDelegationId: null,
        researchTarget: null,
        assistantMessage: null,
        // A command is a new user revision: no delegation/queue/fingerprint of
        // the previous revision may leak into the new pass. A decision is a
        // continuation and keeps its specialist bindings.
        ...(claim.kind !== "decision"
          ? {
              delegationIds: [],
              questionQueue: [],
              searchIntent: null,
              acceptedArtifacts: {},
              expectedFingerprints: {},
              drainPending: false,
              routeChangeCommands: [],
              planningAttempt: 0,
              feedback: [],
              itineraryId: null,
              itineraryReviewFingerprint: null,
            }
          : {}),
      },
    });
  }

  const fence = {
    operationId: claim.operationId,
    tripId: claim.tripId,
    fencingToken: claim.fencingToken,
  };
  const answeringDecisionId =
    claim.kind === "decision"
      ? (claim.payload as { decisionId?: string } | null)?.decisionId
      : undefined;
  try {
    for (let transitions = 0; transitions < 12; transitions += 1) {
      const current = run;
      const result = await runStep({ deps, claim, run: current, tripId: claim.tripId });
      deps.logger?.({
        level: "info",
        component: "coordinator",
        message: "coordinator transition",
        operationId: claim.operationId,
        step: current.step,
        outcome: result.kind,
      });
      if (result.kind === "continue") {
        if (!(await stillHeld(deps, claim))) {
          deps.logger?.({
            level: "warn",
            component: "coordinator",
            message: "stale claim refused its cursor write",
            operationId: claim.operationId,
          });
          return;
        }
        run = await updateCoordinatorRun(deps.pool, {
          runId: current.id,
          step: result.step,
          waitReason: null,
          status: "running",
          runData: result.runData,
        });
        continue;
      }
      if (result.kind === "abandon") {
        // Persist the queue/cursor of the abandoned pass so a re-claim resumes it.
        if (await stillHeld(deps, claim)) {
          await updateCoordinatorRun(deps.pool, {
            runId: current.id,
            operationId: claim.operationId,
            step: current.step,
            waitReason: null,
            status: "running",
            runData: result.runData,
          });
        }
        return;
      }
      if (result.kind === "wait") {
        const committed = await finalizeWaiting(deps.pool, fence, {
          kind: result.waitReason,
          fingerprint: result.fingerprint,
          allowedOptionIds: result.allowedOptionIds,
          allowedOfferIds: result.allowedOfferIds,
          ...(result.proposalId ? { proposalId: result.proposalId } : {}),
          graphVersion: "coordinator-v1",
          createdRevision: claim.acceptedRevision,
          engine: "coordinator-v1",
          coordinatorRunId: run.id,
          optionPayload: result.optionPayload,
          extraWrites: async (client) => {
            await updateCoordinatorRun(client, {
              runId: current.id,
              step: result.step,
              waitReason: result.waitReason,
              status: "waiting",
              runData: result.runData,
            });
            await appendAssistantMessage(client, claim, result.runData);
          },
        });
        if (!committed) {
          deps.logger?.({
            level: "warn",
            component: "coordinator",
            message: "stale coordinator finalization refused",
            operationId: claim.operationId,
          });
        }
        return;
      }
      if (result.kind === "complete") {
        await finalizeSuccess(deps.pool, fence, {
          result: result.result,
          summary: result.summary,
          workflowStatus: result.workflowStatus,
          ...(answeringDecisionId ? { resolveDecisionId: answeringDecisionId } : {}),
          extraWrites: async (client) => {
            await appendAssistantMessage(client, claim, result.runData);
            if (claim.kind !== "decision") {
              // A command that completes without a new decision retires the
              // interrupted one; a decision operation is answering it instead.
              await cancelPendingCoordinatorDecisions(client, claim, current.id);
            }
            await updateCoordinatorRun(client, {
              runId: current.id,
              step: "completed",
              waitReason: null,
              status: "completed",
              runData: result.runData,
            });
          },
        });
        return;
      }
      if (result.kind === "fail") {
        await finalizeFailure(deps.pool, fence, {
          code: result.code,
          message: result.reason,
          exhausted: true,
          extraWrites: async (client) => {
            // A failed run cannot answer a pending decision; retire it so the UI
            // never offers a dead decision.
            await cancelPendingCoordinatorDecisions(client, claim, current.id);
            await updateCoordinatorRun(client, {
              runId: current.id,
              step: "failed",
              waitReason: null,
              status: "failed",
              runData: result.runData,
              failureCode: result.code,
            });
          },
        });
        return;
      }
      return;
    }
    throw new Error(`coordinator operation ${claim.operationId} exceeded its transition budget`);
  } catch (error) {
    if (error instanceof StaleFencingError) {
      // A rotated fence means another claim owns the operation; never write.
      return;
    }
    const code = safeErrorCode(error);
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const failedRun = run;
    const failedRunWrite = failedRun
      ? async (client: Pick<PoolClient, "query">): Promise<void> => {
          await updateCoordinatorRun(client, {
            runId: failedRun.id,
            step: "failed",
            waitReason: null,
            status: "failed",
            runData: failedRun.runData,
            failureCode: code,
          });
        }
      : undefined;
    const terminal = isTerminalConflictCode(code);
    if (terminal && claim.kind === "decision") {
      // The resume consumed its decision before this failure, so expose the
      // unfinished failed run for explicit owner recovery.
      await finalizeFailure(deps.pool, fence, {
        code,
        message,
        exhausted: true,
        ...(failedRunWrite ? { extraWrites: failedRunWrite } : {}),
      });
    } else if (terminal) {
      const committed = await finalizeConflict(deps.pool, fence, {
        code,
        message,
        ...(failedRunWrite ? { extraWrites: failedRunWrite } : {}),
      });
      if (committed && isChatOperation(claim)) {
        // A failed chat request must not stay silent in the conversation.
        await appendConversationMessage(deps.pool, {
          tripId: claim.tripId,
          role: "assistant",
          content: `I could not complete that request (${code}). No confirmed reservation was changed.`,
          interpretation: { kind: "unsupported" },
          operationId: claim.operationId,
          requestId: claim.operationId,
        });
      }
    } else {
      const exhausted = claim.autoClaims >= MAX_AUTO_CLAIMS_PER_ROUND;
      await finalizeFailure(deps.pool, fence, {
        code,
        message,
        exhausted,
        ...(exhausted ? { extraWrites: failedRunWrite } : {}),
      });
    }
    deps.logger?.({
      level: "error",
      component: "coordinator",
      message: "operation failed",
      operationId: claim.operationId,
      code,
    });
  }
}
