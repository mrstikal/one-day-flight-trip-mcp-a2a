import type { TravelState, TravelUpdate } from "../travel/state.js";

/** Interpret the resume action and select the next stage of the graph. */
export function applyDecisionNode(state: TravelState): TravelUpdate {
  switch (state.lastAction) {
    case "choose_offer":
      return { pendingStage: "stage" };
    case "confirm_booking":
      return { pendingStage: "commit" };
    case "decline_booking":
      return { pendingStage: "decline" };
    case "submit_program":
      return { pendingStage: "program" };
    case "approve_itinerary":
      return { pendingStage: "approve" };
    case "choose_clarification":
      return { pendingStage: "clarification_apply" };
    case "modify":
      return { pendingStage: "clarification_modify" };
    case "confirm_route_change":
      return { pendingStage: "commit_route" };
    case "choose_option": {
      // Recovery decision: re-open the affected choice step without editing data.
      // A research-failure recovery ends the run instead: the affected page shows
      // its empty/failed state with active controls and the retry action.
      if (state.researchStatus === "failed") {
        return {
          pendingStage: "end",
          proposalId: null,
          selectedOfferId: null,
          decisionFingerprint: null,
          bookingService: null,
          logisticsStatus: "pending",
          logisticsReason: null,
        };
      }
      const kind = state.lastOptionId === "change_meals" ? "program_choices" : "hotel_choice";
      return {
        pendingStage: "reselection",
        nextDecisionKind: kind,
        proposalId: null,
        selectedOfferId: null,
        decisionFingerprint: null,
        bookingService: null,
        logisticsStatus: "pending",
        logisticsReason: null,
      };
    }
    case "reject_proposal": {
      // An optional meal reservation is a standalone review: rejecting it ends the
      // run. Flight/hotel rejections return to that service's choice step.
      const service = state.bookingService;
      if (service === "breakfast" || service === "lunch" || service === "dinner") {
        return {
          pendingStage: "end",
          bookingService: null,
          proposalId: null,
          selectedOfferId: null,
          decisionFingerprint: null,
        };
      }
      const kind = service === "hotel" ? "hotel_choice" : "flight_choice";
      return {
        pendingStage: "reselection",
        nextDecisionKind: kind,
        proposalId: null,
        selectedOfferId: null,
        decisionFingerprint: null,
        bookingService: null,
      };
    }
    default:
      return { pendingStage: "end" };
  }
}
