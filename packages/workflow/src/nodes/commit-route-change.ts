import { InvalidUpdateError } from "@langchain/langgraph";
import { OPERATION_LOCAL_RESETS, type TravelState, type TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/**
 * Phase 11: commit a confirmed route change (03-langgraph-design.md section 10).
 *
 * The user's `confirm_route_change` names exactly the reservations the impact
 * preview listed. This node applies the deferred `set_route` batch and cancels
 * those confirmed reservations in ONE fenced transaction, then clears every
 * route/schedule/planning reference so Stage A and Stage B are re-derived from
 * scratch. A rejected route therefore produces no booking: the old reservations
 * were cancelled by the explicit confirmation, and nothing new is created.
 */
export async function commitRouteChangeNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  const preview = state.routeChangePreview;
  if (!preview) {
    throw new InvalidUpdateError("commit_route_change requires a staged preview");
  }
  if (!state.lastDecisionId) {
    throw new InvalidUpdateError("commit_route_change requires the confirmed decision id");
  }
  const ports = travelPorts(runtime);
  // No effect-ledger wrapper: the commit is idempotent by itself (a replay sees
  // the applied route and the already-cancelled reservations), and wrapping it
  // would hold a second pool connection while the commit transaction runs.
  const result = await ports.commitRouteChange({
    tripId: state.tripId,
    operationId: state.operationId,
    decisionId: state.lastDecisionId as string,
    acceptedRevision: state.acceptedRevision,
    proposalId: preview.proposalId,
    affectedReservationIds: preview.affectedReservations.map((entry) => entry.id),
    commands: preview.commands,
  });
  return {
    routeChangePreview: null,
    routeChangeProposalId: null,
    commandType: null,
    commandPayload: null,
    lastAffectedReservationIds: [],
    // Fresh feasibility: every derived reference is dropped and recomputed.
    routeStatus: "PENDING",
    routeValidationId: null,
    routeFingerprint: null,
    routeReasons: [],
    routeAlternatives: [],
    snapshotId: null,
    scenarioKey: null,
    scheduleValidationId: null,
    scheduleStatus: "PENDING",
    validCombinationIds: [],
    // A confirmed route change invalidates the previous destination's domain
    // extension: the flag must not leak into this run, or `routeAfterSchedules`
    // dispatches research BEFORE the fresh flight choice instead of presenting
    // the flight decision (the new snapshot is ensured only after the flight
    // booking via `ensure_domains`).
    domainsEnsured: false,
    // The route change is a new operation: the research status AND the
    // per-operation provider-attempt budget/run scope restart (Phase 11 review
    // fix) so successive route changes cannot exceed the task attempt ceiling.
    ...OPERATION_LOCAL_RESETS,
    programApplied: false,
    replacementStaged: false,
    logisticsStatus: "pending",
    logisticsReason: null,
    itineraryId: null,
    itineraryVersion: null,
    itineraryStatus: null,
    itineraryValidationStatus: null,
    itineraryErrorCodes: [],
    itineraryWarningCodes: [],
    itineraryFeedback: [],
    itineraryReviewVerdict: null,
    itineraryReviewSuggestions: [],
    itineraryBudgetConflict: false,
    recoveryOptionIds: [],
    hasConfirmedFlight: false,
    hasConfirmedHotel: false,
    confirmedServices: [],
    selectedServices: [],
    nextDecisionKind: "flight_choice",
    nextWork: "route",
    lastOutcome: result.cancelledReservationIds.length > 0 ? "route_changed" : state.lastOutcome,
  };
}
