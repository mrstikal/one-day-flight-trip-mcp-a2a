import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/**
 * Phase 07: read the confirmed flight/hotel progress so a preference change (or a
 * new command) resumes at the relevant step instead of restarting the flight
 * flow. With a confirmed flight but no hotel it re-derives hotel offers; with both
 * it re-derives program choices. With no confirmed flight it runs the normal
 * feasibility flow.
 *
 * Phase 12: a service the traveler declined to book ("I don't want to book") is
 * kept as a persisted selection, which settles its step exactly like a confirmed
 * one — the trip continues with the plan built as if it existed.
 *
 * Phase 11: a targeted routing decision (`nextWork: "research"`) keeps the
 * decision kind the invalidation matrix chose instead of overriding it with the
 * generic progress-derived kind.
 *
 * A reselection (`apply_decision` choose_option recovery or a rejected proposal)
 * keeps its explicit kind for the same reason: the user asked to reopen THAT
 * step, so a confirmed hotel must not turn `change_hotel` into `program_choices`.
 */
export async function detectProgressNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  const ports = travelPorts(runtime);
  const progress = await ports.loadProgress(state.tripId);
  const targeted =
    state.nextDecisionKind !== null &&
    (state.nextWork === "research" || state.pendingStage === "reselection");
  const flightSettled =
    progress.flightConfirmed || progress.selectedServices.includes("flights");
  const hotelSettled = progress.hotelConfirmed || progress.selectedServices.includes("hotel");
  const nextDecisionKind = targeted
    ? state.nextDecisionKind
    : flightSettled
      ? hotelSettled
        ? "program_choices"
        : "hotel_choice"
      : "flight_choice";
  return {
    hasConfirmedFlight: progress.flightConfirmed,
    hasConfirmedHotel: progress.hotelConfirmed,
    confirmedServices: [...progress.confirmedServices],
    selectedServices: [...progress.selectedServices],
    nextDecisionKind,
  };
}
