import { InvalidUpdateError } from "@langchain/langgraph";
import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/**
 * Commit the confirmed reservation exactly once (flights, hotel, or a meal). The
 * domain service is keyed by `(operation, proposal)` and returns the existing
 * reservation on a replay, so no duplicate `DEMO-*` reference can be created.
 *
 * The booked service determines the next decision: after flights the run
 * continues into hotel research, after the hotel it opens program choices, and an
 * optional meal reservation ends the run.
 */
export async function commitBookingNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  const proposalId = state.lastProposalId ?? state.proposalId;
  if (!proposalId || !state.lastDecisionId) {
    throw new InvalidUpdateError("commit_booking requires a proposal and a decision");
  }
  const service = state.bookingService ?? "flights";
  const ports = travelPorts(runtime);
  const confirmationKey = `confirm:${service}:${state.operationId}:${proposalId}`;
  const result = state.pendingReplacement
    ? await ports.replace({
        tripId: state.tripId,
        operationId: state.operationId,
        service,
        proposalId,
        decisionId: state.lastDecisionId,
        acceptedRevision: state.acceptedRevision,
        confirmationKey,
      })
    : await ports.confirm({
        tripId: state.tripId,
        operationId: state.operationId,
        proposalId,
        decisionId: state.lastDecisionId,
        acceptedRevision: state.acceptedRevision,
        confirmationKey,
      });
  // The booked service determines the next decision: an initial flight booking
  // continues into hotel research and, with the hotel already settled (booked or
  // kept as a declined-booking selection), straight to the program. Once the
  // program is applied the trip is already planned, so a late booking (from the
  // "Not booked" review or a late change) only republishes the plan through the
  // logistics check — mirroring a late meal reservation. An optional meal
  // reservation ends the run. An initial hotel booking still opens the program.
  const progress = await ports.loadProgress(state.tripId);
  const hotelSettled = progress.hotelConfirmed || progress.selectedServices.includes("hotel");
  const late = progress.programApplied;
  const nextDecisionKind =
    service === "flights"
      ? late
        ? null
        : hotelSettled
          ? "program_choices"
          : "hotel_choice"
      : service === "hotel"
        ? late
          ? null
          : "program_choices"
        : null;
  return {
    reservationId: result.reservationId,
    demoReference: result.demoReference,
    gate: "booked",
    bookingService: service,
    pendingReplacement: false,
    hasConfirmedFlight: progress.flightConfirmed,
    hasConfirmedHotel: progress.hotelConfirmed,
    nextDecisionKind,
  };
}
