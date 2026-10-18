import type { Pool } from "pg";
import {
  agentTaskRequestSchema,
  itineraryProposalSchema,
  type CoordinatorRunData,
  type TripRecord,
} from "@odft/contracts";
import { fingerprint } from "@odft/domain";
import {
  acceptDelegationArtifact,
  contentHash,
  getAgentDelegation,
  ItineraryPersistenceError,
  type ClaimedOperation,
} from "@odft/persistence";
import type { TravelPorts } from "./ports.js";
import type { CoordinatorAgentBinding } from "./dispatch.js";
import {
  acceptArtifact,
  createOutboundDelegation,
  deliverDelegation,
  loadDelegationDelivery,
  newTraceId,
  type CoordinatorDelegationTransport,
} from "./delegations.js";
import type { CoordinatorTransitionResult } from "./state.js";

/**
 * Phase 08 coordinator itinerary loop (ODTF_PLAN.md §3.11).
 *
 * One City Guide task = one application planning attempt. The agent proposes;
 * the coordinator reassembles and validates locally, then runs the EXISTING
 * reviewer decision policy. The attempt bound (3) is enforced here, never by the
 * agent, and a failed/invalid attempt becomes bounded feedback for the next one.
 */

export const MAX_ITINERARY_ATTEMPTS = 3;

const ITINERARY_DOMAINS = ["breakfast", "lunch", "dinner", "attractions"] as const;

export interface ItineraryLoopDeps {
  readonly pool: Pool;
  readonly ports: TravelPorts;
  readonly transport: CoordinatorDelegationTransport;
  readonly binding: CoordinatorAgentBinding | undefined;
  readonly logger?: (entry: {
    level: "warn" | "error";
    component: string;
    message: string;
    reason?: string | null;
    operationId?: string;
  }) => void;
  readonly delegationWaitMs?: number;
}

interface PreparedSnapshotBinding {
  readonly scenarioKey: string;
  readonly routeApprovalFingerprint: string;
  readonly scheduleApprovalFingerprint: string;
  readonly domainFingerprints: Record<string, string>;
}

async function loadSnapshotBinding(
  pool: Pool,
  snapshotId: string,
): Promise<PreparedSnapshotBinding | undefined> {
  const result = await pool.query<{
    scenario_key: string;
    content_hashes: Record<string, unknown> | null;
    route_fingerprint: string | null;
    schedule_fingerprint: string | null;
  }>(
    `SELECT s.scenario_key,
            s.content_hashes,
            rv.fingerprint AS route_fingerprint,
            sv.fingerprint AS schedule_fingerprint
       FROM odft_app.scenario_snapshots s
       LEFT JOIN odft_app.trips t ON t.id = s.trip_id
       LEFT JOIN odft_app.route_validations rv ON rv.id = t.current_route_validation_id
       LEFT JOIN odft_app.schedule_validations sv ON sv.id = t.current_schedule_validation_id
      WHERE s.id = $1`,
    [snapshotId],
  );
  const row = result.rows[0];
  if (!row?.route_fingerprint || !row.schedule_fingerprint) {
    return undefined;
  }
  // The task snapshot binding carries research-domain content hashes only;
  // flights/hotels/activities are raw snapshot sections, not delegation domains.
  const researchDomains = new Set([
    "hotel",
    "breakfast",
    "lunch",
    "dinner",
    "attractions",
    "events",
  ]);
  const domainFingerprints: Record<string, string> = {};
  for (const [domain, value] of Object.entries(row.content_hashes ?? {})) {
    if (researchDomains.has(domain) && typeof value === "string") {
      domainFingerprints[domain] = value;
    }
  }
  return {
    scenarioKey: row.scenario_key,
    routeApprovalFingerprint: row.route_fingerprint,
    scheduleApprovalFingerprint: row.schedule_fingerprint,
    domainFingerprints,
  };
}

async function loadSelectionConstraints(
  pool: Pool,
  ports: TravelPorts,
  tripId: string,
): Promise<{ selectedOfferIds: string[]; confirmedOfferIds: string[] }> {
  const progress = await ports.loadProgress(tripId);
  const selected = Object.values(progress.selectionOfferIds).filter(
    (offerId): offerId is string => typeof offerId === "string",
  );
  const confirmedResult = await pool.query<{ offer_id: string }>(
    `SELECT offer_id FROM odft_app.reservations
      WHERE trip_id = $1 AND status = 'confirmed'`,
    [tripId],
  );
  return {
    selectedOfferIds: [...new Set(selected)],
    confirmedOfferIds: confirmedResult.rows.map((row) => row.offer_id),
  };
}

/**
 * Start exactly one delegated planning attempt. The task carries the compact
 * planner context and the deterministic MCP tool context; the agent never reads
 * trip tables. A delivery failure is recoverable from the persisted outbound.
 */
export async function startItineraryAttempt(
  deps: ItineraryLoopDeps,
  claim: ClaimedOperation,
  trip: TripRecord,
  data: CoordinatorRunData,
  feedback: readonly string[],
): Promise<CoordinatorTransitionResult> {
  const binding = deps.binding;
  if (!binding) {
    return {
      kind: "fail",
      runData: { ...data },
      code: "COORDINATOR_AGENTS_MISSING",
      reason: "the trusted registry has no City Guide itinerary binding",
    };
  }
  const attempt = data.planningAttempt + 1;
  if (attempt > MAX_ITINERARY_ATTEMPTS) {
    return {
      kind: "fail",
      runData: { ...data },
      code: "ITINERARY_ATTEMPTS_EXHAUSTED",
      reason: "the itinerary attempt bound is already exhausted",
    };
  }
  const prepared = await deps.ports.prepareItineraryTask({
    tripId: claim.tripId,
    attempt,
    feedback: feedback.slice(0, 10),
  });
  const snapshot = await loadSnapshotBinding(deps.pool, prepared.snapshotId);
  if (!snapshot) {
    return {
      kind: "fail",
      runData: { ...data },
      code: "ROUTE_INVALIDATED",
      reason: "the itinerary snapshot has no persisted route/schedule approval",
    };
  }
  const constraints = await loadSelectionConstraints(deps.pool, deps.ports, claim.tripId);
  const toolContext = prepared.toolContext;
  const taskData = agentTaskRequestSchema.parse({
    schemaVersion: 1,
    skillId: binding.skillId,
    tripId: claim.tripId,
    operationId: claim.operationId,
    acceptedRevision: claim.acceptedRevision,
    // Replaced with the persisted delegation id by createOutboundDelegation.
    delegationId: "00000000-0000-0000-0000-000000000000",
    traceId: newTraceId(),
    snapshot: {
      snapshotId: prepared.snapshotId,
      scenarioKey: snapshot.scenarioKey,
      routeApprovalFingerprint: snapshot.routeApprovalFingerprint,
      scheduleApprovalFingerprint: snapshot.scheduleApprovalFingerprint,
      domainFingerprints: snapshot.domainFingerprints,
    },
    inputFingerprint: prepared.inputFingerprint,
    requestedDomains: [...ITINERARY_DOMAINS],
    travelVariant: trip.travelVariant,
    adults: trip.adults,
    sightseeingDate: trip.sightseeingDate,
    effectiveLevel: trip.preferences.defaultServiceLevel,
    selectedOfferIds: constraints.selectedOfferIds,
    confirmedOfferIds: constraints.confirmedOfferIds,
    preservationConstraints: [],
    searchObjective: "preserve_level",
    queryContext: {
      itinerary: {
        attempt,
        feedback: feedback.slice(0, 10),
        plannerContext: prepared.context,
        toolContext,
        zone: prepared.zone,
        departureMinuteRaw: prepared.departureMinuteRaw,
        selectedMealIds: toolContext.mealSelections,
        confirmedMealIds: toolContext.confirmedMealIds,
        selfArrangedMeals: toolContext.selfArrangedMeals,
        selfArrangedActivities: toolContext.selfArrangedActivities,
        preferredActivityIds: toolContext.preferredActivityIds,
        flightOfferId: toolContext.flightOfferId,
        hotelOfferId: toolContext.hotelOfferId,
        destinationAirportId: toolContext.destinationAirportId,
        dinnerExcludedReason: toolContext.dinnerExcludedReason,
      },
    },
    deadlineAt: new Date(Date.now() + 300_000).toISOString(),
    // Plan §3.9: one itinerary proposal/review attempt is 120 s, 6 MCP calls,
    // 4 LLM transport attempts and at most 0.25 USD.
    limits: {
      activeTimeMs: 120_000,
      mcpInvocations: 6,
      llmTransportAttempts: 4,
      maxTaskCostUsd: 0.25,
    },
    preferences: trip.preferences,
    continuation: null,
  });

  const created = await createOutboundDelegation(deps.pool, {
    tripId: claim.tripId,
    operationId: claim.operationId,
    acceptedRevision: claim.acceptedRevision,
    skillId: binding.skillId,
    agentIdentity: binding.agentIdentity,
    endpointUrl: binding.endpointUrl,
    snapshotId: prepared.snapshotId,
    inputFingerprint: prepared.inputFingerprint,
    domains: [...ITINERARY_DOMAINS],
    allowRouteValidation: false,
    allowItinerary: true,
    objective: null,
    levelOverride: null,
    deadlineAt: taskData.deadlineAt,
    taskData,
  });
  const delivered = await deliverDelegation(deps.pool, deps.transport, {
    delegationId: created.delegationId,
    agentIdentity: binding.agentIdentity,
    data: created.taskData,
  });
  if (!delivered.delivered) {
    deps.logger?.({
      level: "warn",
      component: "coordinator",
      message: "itinerary delegation delivery failed; the persisted intent will be retried",
      reason: delivered.reason,
      operationId: claim.operationId,
    });
  }
  return {
    kind: "continue",
    step: "planning",
    runData: {
      ...data,
      planningAttempt: attempt,
      feedback: feedback.slice(0, 10),
      itineraryDelegationId: created.delegationId,
      itineraryId: null,
      itineraryReviewFingerprint: null,
    },
  };
}

/**
 * One accepted artifact of the itinerary task (never a question artifact).
 * The FULL proposal schema is re-validated here: a malformed artifact becomes a
 * bounded attempt failure with feedback, not an operation exception.
 */
function acceptedItineraryArtifact(
  artifacts: readonly { artifactId: string; data: unknown }[],
  delegation: Awaited<ReturnType<typeof getAgentDelegation>>,
):
  | {
      ok: true;
      stops: ReturnType<typeof itineraryProposalSchema.parse>["stops"];
      attempt: number;
      payloadHash: string;
    }
  | { ok: false; reason: string }
  | undefined {
  if (!delegation) {
    return undefined;
  }
  let lastError: string | undefined;
  for (const artifact of artifacts) {
    const accepted = acceptArtifact({
      artifact: artifact.data,
      delegation,
      operationId: delegation.originatingOperationId,
      acceptedRevision: delegation.acceptedRevision,
    });
    if (!accepted) {
      continue;
    }
    const parsed = itineraryProposalSchema.safeParse(accepted.value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      lastError = issue ? `${issue.path.join(".")}: ${issue.message}` : "malformed proposal";
      continue;
    }
    return {
      ok: true,
      stops: parsed.data.stops,
      attempt: parsed.data.attempt,
      payloadHash: accepted.payloadHash,
    };
  }
  return lastError ? { ok: false, reason: lastError } : undefined;
}

function feedbackFromIssues(issues: readonly { code: string; message: string }[]): string[] {
  return [...new Set(issues.map((issue) => `${issue.code}: ${issue.message}`.slice(0, 300)))].slice(
    0,
    10,
  );
}

/**
 * The finite option ids of an itinerary conflict. A clarification carries its
 * explicit options; the recovery fallback carries only `recoveryOptionIds`,
 * which must still be answerable through the same `choose_option` admission
 * (otherwise the pending decision renders with no buttons).
 */
function conflictOptionIds(conflict: {
  readonly options: readonly { readonly id: string }[];
  readonly recoveryOptionIds: readonly string[];
}): string[] {
  return conflict.options.length > 0
    ? conflict.options.map((option) => option.id)
    : [...conflict.recoveryOptionIds];
}

/**
 * Poll the current attempt and either accept its proposal (local validation and
 * review policy) or start the next bounded attempt with feedback.
 */
export async function pollItineraryAttempt(
  deps: ItineraryLoopDeps,
  claim: ClaimedOperation,
  trip: TripRecord,
  data: CoordinatorRunData,
): Promise<CoordinatorTransitionResult> {
  const delegationId = data.itineraryDelegationId;
  if (!delegationId) {
    return {
      kind: "fail",
      runData: { ...data },
      code: "NO_DELEGATION",
      reason: "the planning step has no bound itinerary delegation",
    };
  }
  const delegation = await getAgentDelegation(deps.pool, delegationId);
  if (!delegation) {
    return {
      kind: "fail",
      runData: { ...data },
      code: "NOT_FOUND",
      reason: "the itinerary delegation is missing",
    };
  }
  if (!delegation.taskId) {
    const persisted = await loadDelegationDelivery(deps.pool, delegationId);
    if (!persisted.outbound) {
      return {
        kind: "fail",
        runData: { ...data },
        code: "STALE_AGENT_RESULT",
        reason: "the itinerary delegation has no persisted outbound intent",
      };
    }
    await deliverDelegation(deps.pool, deps.transport, {
      delegationId,
      agentIdentity: delegation.agentIdentity,
      data: persisted.outbound.payload,
    });
    return { kind: "abandon", runData: { ...data } };
  }
  const waitMs = deps.delegationWaitMs ?? 20_000;
  const startedAt = Date.now();
  let task: Awaited<ReturnType<typeof deps.transport.getTask>>;
  // Non-blocking delivery: poll the accepted task within this claim instead of
  // abandoning on the first submitted/working state (plan §3.11/§3.13).
  for (;;) {
    try {
      task = await deps.transport.getTask({
        agentIdentity: delegation.agentIdentity,
        taskId: delegation.taskId,
      });
    } catch {
      if (Date.now() - startedAt >= waitMs) {
        return { kind: "abandon", runData: { ...data } };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    if (task.state === "completed" || task.state === "failed" || task.state === "canceled") {
      break;
    }
    if (Date.now() - startedAt >= waitMs) {
      return { kind: "abandon", runData: { ...data } };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (task.state === "failed" || task.state === "canceled") {
    const failureCode = task.failureCode ?? "AGENT_FAILED";
    if (data.planningAttempt < MAX_ITINERARY_ATTEMPTS) {
      return startItineraryAttempt(deps, claim, trip, data, [
        ...data.feedback,
        `${failureCode}: the itinerary specialist ${task.state} the task`.slice(0, 300),
      ]);
    }
    return {
      kind: "wait",
      step: "awaiting_user",
      waitReason: "recovery",
      runData: { ...data },
      fingerprint: contentHash({ delegationId, failureCode }),
      allowedOptionIds: ["change_program", "retry_itinerary"],
      optionPayload: {
        question: "the itinerary specialist could not produce a proposal",
        options: [
          { id: "change_program", label: "Adjust the meals or activities", commands: [] },
          {
            id: "retry_itinerary",
            label: "Try the itinerary again",
            commands: [{ type: "build_itinerary" }],
          },
        ],
      },
    };
  }
  const accepted = acceptedItineraryArtifact(task.artifacts, delegation);
  if (!accepted) {
    return {
      kind: "fail",
      runData: { ...data },
      code: "STALE_AGENT_RESULT",
      reason: "the itinerary task completed without an acceptable proposal artifact",
    };
  }
  if (!accepted.ok || accepted.attempt !== data.planningAttempt) {
    const reason = accepted.ok
      ? `the proposal is for attempt ${accepted.attempt}, expected ${data.planningAttempt}`
      : `the proposal artifact is malformed: ${accepted.reason}`;
    if (data.planningAttempt < MAX_ITINERARY_ATTEMPTS) {
      return startItineraryAttempt(deps, claim, trip, data, [
        ...data.feedback,
        `INVALID_ARTIFACT: ${reason}`.slice(0, 300),
      ]);
    }
    return {
      kind: "wait",
      step: "awaiting_user",
      waitReason: "recovery",
      runData: { ...data },
      fingerprint: contentHash({ delegationId, reason }),
      allowedOptionIds: ["change_program", "retry_itinerary"],
      optionPayload: {
        question: "the itinerary proposal could not be accepted",
        options: [
          { id: "change_program", label: "Adjust the meals or activities", commands: [] },
          {
            id: "retry_itinerary",
            label: "Try the itinerary again",
            commands: [{ type: "build_itinerary" }],
          },
        ],
      },
    };
  }
  const artifactValue = accepted.stops;
  // Same terminal-status guard as the research path: a cancellation that
  // commits while the proposal is accepted must win, never resurrect the row.
  const acceptedNow = await acceptDelegationArtifact(deps.pool, {
    delegationId,
    artifactHash: accepted.payloadHash,
  });
  if (!acceptedNow) {
    return { kind: "abandon", runData: { ...data } };
  }

  let plan: Awaited<ReturnType<TravelPorts["acceptItineraryProposal"]>>;
  try {
    plan = await deps.ports.acceptItineraryProposal({
      tripId: claim.tripId,
      operationId: claim.operationId,
      attempt: data.planningAttempt,
      stops: artifactValue,
    });
  } catch (error) {
    // An invented/foreign candidate is a bounded attempt failure with feedback,
    // never an operation exception (the agent's artifact is untrusted).
    if (error instanceof ItineraryPersistenceError && error.code === "INVALID_ARTIFACT") {
      if (data.planningAttempt < MAX_ITINERARY_ATTEMPTS) {
        return startItineraryAttempt(deps, claim, trip, data, [
          ...data.feedback,
          `INVALID_ARTIFACT: ${error.message}`.slice(0, 300),
        ]);
      }
      return {
        kind: "wait",
        step: "awaiting_user",
        waitReason: "recovery",
        runData: { ...data },
        fingerprint: contentHash({ delegationId, reason: error.message }),
        allowedOptionIds: ["change_program", "retry_itinerary"],
        optionPayload: {
          question: "the itinerary proposal referenced a candidate outside the trip",
          options: [
            { id: "change_program", label: "Adjust the meals or activities", commands: [] },
            {
              id: "retry_itinerary",
              label: "Try the itinerary again",
              commands: [{ type: "build_itinerary" }],
            },
          ],
        },
      };
    }
    throw error;
  }

  // Phase 10 scenario E: the injected first-attempt overlap is always repaired
  // inside the bounded loop, even when the deterministic validator happens to
  // consider the corrupted draft valid. The second attempt carries the labeled
  // "repaired within the bounded loop" note.
  if (plan.simulatedFailure && data.planningAttempt === 1) {
    return startItineraryAttempt(deps, claim, trip, data, [
      ...data.feedback,
      "INJECTED_OVERLAP: the draft contains a simulated first-attempt overlap; replan once.",
    ]);
  }
  if (plan.status === "invalid" || !plan.itineraryId) {
    const feedback = feedbackFromIssues(plan.errors);
    if (data.planningAttempt < MAX_ITINERARY_ATTEMPTS) {
      return startItineraryAttempt(deps, claim, trip, data, [...data.feedback, ...feedback]);
    }
    const conflict = plan.conflictDecision;
    if (!conflict) {
      return {
        kind: "fail",
        runData: { ...data },
        code: "CONFLICT",
        reason: "the itinerary is invalid and has no conflict decision",
      };
    }
    return {
      kind: "wait",
      step: "awaiting_user",
      waitReason: conflict.kind === "clarification" ? "clarification" : "recovery",
      runData: { ...data },
      fingerprint: fingerprint({
        kind: "itinerary_conflict",
        tripId: claim.tripId,
        operationId: claim.operationId,
        attempt: data.planningAttempt,
        errors: plan.errors.map((error) => error.code).sort(),
      }),
      allowedOptionIds: conflictOptionIds(conflict),
      optionPayload: conflict,
    };
  }

  // The reviewer call is effect-fenced: a crash after review persistence but
  // before parking replays the cached review instead of paying for a second one.
  const review = await deps.ports.runEffect(
    "coordinator_review_itinerary",
    `review:${data.planningAttempt}:${data.itineraryReviewFingerprint ?? "none"}`,
    () =>
      deps.ports.reviewItinerary({
        tripId: claim.tripId,
        operationId: claim.operationId,
        attempt: data.planningAttempt,
        atBound: data.planningAttempt >= MAX_ITINERARY_ATTEMPTS,
        previousRevisionFingerprint: data.itineraryReviewFingerprint,
      }),
  );
  if (review.verdict === "revise" && data.planningAttempt < MAX_ITINERARY_ATTEMPTS) {
    return startItineraryAttempt(deps, claim, trip, data, [
      ...data.feedback,
      ...review.suggestions.slice(0, 10),
    ]);
  }
  if (review.verdict === "conflict" && review.conflictDecision) {
    const conflict = review.conflictDecision;
    return {
      kind: "wait",
      step: "awaiting_user",
      waitReason: conflict.kind === "clarification" ? "clarification" : "recovery",
      runData: { ...data, itineraryId: plan.itineraryId },
      fingerprint: review.revisionFingerprint,
      allowedOptionIds: conflictOptionIds(conflict),
      optionPayload: conflict,
    };
  }
  return {
    kind: "wait",
    step: "awaiting_user",
    waitReason: "itinerary_approval",
    runData: {
      ...data,
      itineraryId: plan.itineraryId,
      itineraryReviewFingerprint: review.revisionFingerprint,
    },
    fingerprint: fingerprint({
      kind: "itinerary_approval",
      tripId: claim.tripId,
      operationId: claim.operationId,
      itineraryId: plan.itineraryId,
      attempt: data.planningAttempt,
    }),
    allowedOptionIds: [],
    allowedOfferIds: [],
    optionPayload: { itineraryId: plan.itineraryId, attempt: data.planningAttempt },
  };
}
