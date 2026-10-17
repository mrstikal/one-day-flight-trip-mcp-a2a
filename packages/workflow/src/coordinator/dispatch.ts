import type { Pool } from "pg";
import {
  tripPreferencesSchema,
  type CoordinatorRunData,
  type ResearchDomain,
  type TripPreferences,
} from "@odft/contracts";
import { fingerprint } from "@odft/domain";
import {
  contentHash,
  finalizeFailure,
  finalizeSuccess,
  finalizeWaiting,
  getActiveCoordinatorRun,
  getAgentDelegation,
  getProposal,
  getTrip,
  insertCoordinatorRun,
  loadDecision,
  updateCoordinatorRun,
  type ClaimedOperation,
  type CoordinatorRunRecord,
} from "@odft/persistence";
import type { TravelPorts } from "../travel/ports.js";
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

type RunDataPatch = Partial<Omit<CoordinatorRunData, "schemaVersion">>;

function runDataWith(base: CoordinatorRunData, patch: RunDataPatch): CoordinatorRunDataInput {
  return { ...base, ...patch, schemaVersion: 1 };
}

/** Refuse cursor writes from a claim that no longer owns the operation. */
async function stillHeld(
  deps: CoordinatorDispatchDeps,
  claim: ClaimedOperation,
): Promise<boolean> {
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
    taskData: input.taskData,
    deadlineAt: new Date(Date.now() + 600_000).toISOString(),
  });
  return created;
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
    limits: { activeTimeMs: 90_000, mcpInvocations: 8, llmTransportAttempts: 2, maxTaskCostUsd: 0.1 },
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
    taskData: { ...base, skillId: cityGuide.skillId, requestedDomains: cityDomains, delegationId: "" },
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
        message: index === 0 ? "hotel delegation delivery failed" : "city-guide delegation delivery failed",
        reason: delivered.reason,
      });
    }
  }
  return {
    kind: "continue",
    delegationIds: [...data.delegationIds, hotelDelegation.delegationId, cityDelegation.delegationId],
  };
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
      // Free-text/command operations (chat) are Phase 08 parity work; the
      // coordinator fails them safely instead of guessing.
      return {
        kind: "fail",
        runData: runDataWith(data, {}),
        code: "COORDINATOR_UNSUPPORTED_OPERATION",
        reason: "this coordinator version does not accept free-text operations yet",
      };
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
        return { kind: "fail", runData: runDataWith(data, {}), code: "NOT_FOUND", reason: "trip not found" };
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
              agentIdentity: persisted.delegation?.agentIdentity ?? deps.agents.flight.agentIdentity,
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
      const delegationIds = [...data.delegationIds.filter((id) => id !== created.delegationId), created.delegationId];
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
      if (!decision || decision.status !== "pending" || decision.coordinatorRunId !== run.id) {
        return {
          kind: "fail",
          runData: runDataWith(data, {}),
          code: "STALE_DECISION",
          reason: "the decision is missing, resolved, or owned by another run",
        };
      }
      const trip = await getTrip(deps.pool, context.tripId);
      if (!trip) {
        return { kind: "fail", runData: runDataWith(data, {}), code: "NOT_FOUND", reason: "trip not found" };
      }
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
          await deps.ports.declineBooking({
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
          return {
            kind: "complete",
            runData: runDataWith(data, {}),
            result: { service, action },
            summary: "booking recorded after the trip was already planned",
            workflowStatus: "ready",
          };
        }
        if (service === "flights" && !progress.hotelConfirmed && !progress.selectedServices.includes("hotel")) {
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
        // program choices from the City Guide specialist's ranked domains.
        const cityDelegation = await deps.pool.query<{ id: string }>(
          `SELECT id FROM odft_app.agent_delegations
            WHERE trip_id = $1 AND skill_id = 'city-guide.research.v1' AND status = 'completed'
            ORDER BY created_at DESC LIMIT 1`,
          [context.tripId],
        );
        const cityId = cityDelegation.rows[0]?.id;
        const cityArtifact = cityId
          ? ((await acceptedArtifactPayload(deps, cityId)) as
              | { outcomes?: { domain?: string; status?: string; rankedOfferIds?: string[] }[] }
              | undefined)
          : undefined;
        const meals = new Set(["breakfast", "lunch", "dinner"]);
        const mealIds =
          cityArtifact?.outcomes
            ?.filter((outcome) => outcome.status === "ok" && meals.has(outcome.domain ?? ""))
            .flatMap((outcome) => outcome.rankedOfferIds ?? []) ?? [];
        const activityIds =
          cityArtifact?.outcomes
            ?.filter((outcome) => outcome.status === "ok" && outcome.domain === "attractions")
            .flatMap((outcome) => outcome.rankedOfferIds ?? []) ?? [];
        if (!cityId || mealIds.length === 0) {
          return {
            kind: "fail",
            runData: runDataWith(data, {}),
            code: "MCP_UNAVAILABLE",
            reason: "the program choices need usable City Guide meal outcomes",
          };
        }
        return {
          kind: "wait",
          step: "awaiting_user",
          waitReason: "program_choices",
          runData: runDataWith(data, {}),
          fingerprint: contentHash(cityArtifact ?? {}),
          allowedOptionIds: activityIds,
          allowedOfferIds: mealIds,
          optionPayload: { rankedMeals: mealIds, rankedActivities: activityIds },
        };
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
      const queue = [...(data.questionQueue ?? [])];
      for (;;) {
        // `drained` is true while every submitted sibling is terminal OR
        // awaiting an answer; a WORKING sibling blocks the question promotion.
        let drained = true;
        if (deps.signal?.aborted) {
          return { kind: "abandon", runData: runDataWith(data, { questionQueue: queue, drainPending: queue.length > 0 }) };
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
          if (delegation.status === "completed") {
            // Accepted earlier (hash on the delegation row). Re-derive the
            // accommodation outcome so a later pass can still park the hotel
            // choice after an intervening question was answered.
            if (delegation.skillId === "accommodation.recommend.v1" && !hotel) {
              const payload = (await acceptedArtifactPayload(deps, delegationId)) as
                | { rankedHotelOfferIds?: unknown }
                | undefined;
              if (Array.isArray(payload?.rankedHotelOfferIds) && payload.rankedHotelOfferIds.length > 0) {
                hotel = {
                  payloadHash: delegation.acceptedArtifactHash ?? contentHash(payload),
                  rankedIds: payload.rankedHotelOfferIds as string[],
                };
              }
            }
            continue;
          }
          if (!delegation.taskId) {
            drained = false;
            const persisted = await loadDelegationDelivery(deps.pool, delegationId);
            if (persisted.outbound) {
              await deliverDelegation(deps.pool, deps.transport, {
                delegationId,
                agentIdentity: delegation.agentIdentity,
                data: persisted.outbound.payload,
              });
            }
            continue;
          }
          const task = await deps.transport.getTask({
            agentIdentity: delegation.agentIdentity,
            taskId: delegation.taskId,
          });
          if (task.state === "failed" || task.state === "canceled") {
            return {
              kind: "fail",
              runData: runDataWith(data, {}),
              code: "AGENT_FAILED",
              reason: `the ${delegation.skillId} specialist ${task.state} the task`,
            };
          }
          if (task.state === "input_required") {
            // A genuine specialist question is persisted in the FIFO queue and
            // NO answerable decision is exposed until every submitted sibling
            // reached a terminal state (drain-before-decision, plan §3.10).
            const question = task.question as {
              correlation?: { delegationId?: string };
              requestId?: string;
              question?: string;
              options?: { id: string; label?: string }[];
              inputGeneration?: number;
              requestHash?: string;
              expiresAt?: string;
            } | undefined;
            const alreadyQueued =
              question?.requestId !== undefined &&
              queue.some((entry) => entry.requestId === question.requestId);
            if (
              question?.requestId &&
              question.inputGeneration !== undefined &&
              !alreadyQueued
            ) {
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
          };
          await deps.pool.query(
            `UPDATE odft_app.agent_delegations
                SET status = 'completed', accepted_artifact_hash = $2, updated_at = now()
              WHERE id = $1`,
            [delegationId, accepted.payloadHash],
          );
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
          }
          void acceptedArtifactId;
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
            const questionTask = answering?.taskId
              ? await deps.transport.getTask({
                  agentIdentity: answering.agentIdentity,
                  taskId: answering.taskId,
                })
              : undefined;
            const question = questionTask?.question as
              | { question?: string; options?: { id: string; label?: string }[] }
              | undefined;
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
                question: (question?.question ?? "the specialist needs a missing preference").slice(0, 400),
                options,
                requestHash: queued.requestHash,
                expiresAt: queued.expiresAt,
              },
            };
          }
        }
        if (hotel) {
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
        if (drained && queue.length === 0) {
          return {
            kind: "fail",
            runData: runDataWith(data, { questionQueue: queue, drainPending: false }),
            code: "STALE_AGENT_RESULT",
            reason: "the research delegations settled without a usable outcome",
          };
        }
        if (Date.now() - startedAt >= waitMs && !hotel) {
          // The operation stays running; its lease expires and the next claim
          // resumes this step from the persisted cursor (saved-task recovery).
          return {
            kind: "abandon",
            runData: runDataWith(data, { questionQueue: queue, drainPending: queue.length > 0 }),
          };
        }
        await delay(250);
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
    if (claim.kind !== "creation") {
      throw new Error(`no active coordinator run for operation ${claim.operationId}`);
    }
    run = await insertCoordinatorRun(deps.pool, {
      tripId: claim.tripId,
      operationId: claim.operationId,
      acceptedRevision: claim.acceptedRevision,
      step: "initializing",
      runData: initialCoordinatorRunData(claim.tripId),
    });
  } else if (run.operationId !== claim.operationId) {
    // The run was parked; the decision operation takes over the cursor and
    // re-enters at `interpreting` (a decision op routes into the planning
    // stage). `running` rows must not carry a wait reason (schema constraint).
    run = await updateCoordinatorRun(deps.pool, {
      runId: run.id,
      operationId: claim.operationId,
      step: "interpreting",
      waitReason: null,
      status: "running",
      runData: run.runData,
    });
  }

  const fence = {
    operationId: claim.operationId,
    tripId: claim.tripId,
    fencingToken: claim.fencingToken,
  };
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
        extraWrites: async (client) => {
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
}
