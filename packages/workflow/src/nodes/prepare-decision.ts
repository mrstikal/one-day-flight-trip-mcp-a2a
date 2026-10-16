import { InvalidUpdateError } from "@langchain/langgraph";
import type { TravelState, TravelUpdate } from "../travel/state.js";

/**
 * Build the next pending-decision descriptor from accumulated state (Phase 06-07).
 *
 * - `flight_choice` offers the validated combinations;
 * - `hotel_choice` offers the materialized hotel offers;
 * - `program_choices` offers the meal offers (as selectable ids) and the activity
 *   choices (as option ids);
 * - `booking_confirmation` offers the single staged proposal.
 *
 * Only ids are stored, never offer content; the projection renders the content.
 *
 * A decision kind that has no fingerprint of its own explicitly clears
 * `decisionFingerprint`: LangGraph keeps the previous operation's channel values,
 * so without it a `hotel_choice`/`program_choices`/`flight_choice` after a
 * confirmation would carry the CONFIRMED PROPOSAL's fingerprint into its
 * `await_decision` interrupt, and the driver would store it as the decision's
 * `source_fingerprint` (breaking the persistence layer's replay identity check).
 */
export function prepareDecisionNode(state: TravelState): TravelUpdate {
  if (state.restoredDecision) {
    // A `modify` resume whose intent turned out unsupported must not strand the
    // trip: replay the exact decision it interrupted (its descriptor was captured
    // before the operation-local state was reset) instead of deriving a new one.
    const restored = state.restoredDecision;
    return {
      decisionKind: restored.decisionKind,
      proposalId: restored.proposalId,
      allowedOfferIds: restored.allowedOfferIds,
      allowedOptionIds: restored.allowedOptionIds,
      gate: restored.gate,
      pendingReplacement: restored.pendingReplacement,
      restoredDecision: null,
    };
  }
  if (state.nextDecisionKind === "itinerary_approval") {
    return {
      decisionKind: "itinerary_approval",
      proposalId: null,
      allowedOfferIds: [],
      allowedOptionIds: [],
      gate: "itinerary_ready",
    };
  }
  if (state.nextDecisionKind === "booking_confirmation") {
    return {
      decisionKind: "booking_confirmation",
      proposalId: state.proposalId,
      allowedOfferIds: state.selectedOfferId ? [state.selectedOfferId] : [],
      allowedOptionIds: [],
      gate: "awaiting_booking",
    };
  }
  if (state.nextDecisionKind === "replacement_confirmation") {
    return {
      decisionKind: "replacement_confirmation",
      proposalId: state.proposalId,
      allowedOfferIds: state.selectedOfferId ? [state.selectedOfferId] : [],
      allowedOptionIds: [],
      gate: "awaiting_booking",
      // Presenting a replacement confirmation means the commit must replace the
      // active reservation, never create a second one for the same service.
      pendingReplacement: true,
    };
  }
  if (state.nextDecisionKind === "route_change_confirmation") {
    if (state.routeChangePreview === null || state.routeChangeProposalId === null) {
      // Cannot happen: the preview and its proposal id are written together by
      // `apply_commands`. Fail loudly instead of presenting an empty card.
      throw new InvalidUpdateError("a route-change confirmation requires a staged preview");
    }
    return {
      decisionKind: "route_change_confirmation",
      // No selection proposal exists for a route change: the impact preview
      // (persisted with the decision) carries the deterministic proposal id, and
      // both the graph and the commit validate the confirmation against it.
      proposalId: null,
      allowedOfferIds: [],
      allowedOptionIds: [],
      gate: "pending",
    };
  }
  if (state.nextDecisionKind === "clarification") {
    return {
      decisionKind: "clarification",
      proposalId: null,
      allowedOfferIds: [],
      allowedOptionIds: state.clarificationOptions.map((option) => option.id),
      gate: "clarification",
    };
  }
  if (state.nextDecisionKind === "recovery") {
    if (state.researchStatus === "failed") {
      // Research failure: offer only the adjustments that can help. Choosing one
      // ends the run so the page shows its empty/failed state with the active
      // preference controls and the retry action.
      const options: string[] = [];
      if (state.researchFailedDomains.includes("hotel")) {
        options.push("change_hotel");
      }
      if (state.researchFailedDomains.some((domain) => domain !== "hotel")) {
        options.push("change_program");
      }
      return {
        decisionKind: "recovery",
        proposalId: null,
        decisionFingerprint: null,
        allowedOfferIds: [],
        allowedOptionIds: options.length > 0 ? options : ["change_program"],
        gate: "research_failed",
      };
    }
    if (state.recoveryOptionIds.length > 0) {
      // Phase 10: the itinerary conflict builder chose the recovery options.
      return {
        decisionKind: "recovery",
        proposalId: null,
        decisionFingerprint: null,
        allowedOfferIds: [],
        allowedOptionIds: state.recoveryOptionIds,
        gate: "itinerary_conflict",
      };
    }
    return {
      decisionKind: "recovery",
      proposalId: null,
      decisionFingerprint: null,
      allowedOfferIds: [],
      allowedOptionIds: ["change_hotel", "change_meals"],
      gate: "logistics_conflict",
    };
  }
  if (state.nextDecisionKind === "hotel_choice") {
    return {
      decisionKind: "hotel_choice",
      proposalId: null,
      decisionFingerprint: null,
      allowedOfferIds: state.hotelOfferIds,
      allowedOptionIds: [],
      gate: "hotels_ready",
    };
  }
  if (state.nextDecisionKind === "program_choices") {
    return {
      decisionKind: "program_choices",
      proposalId: null,
      decisionFingerprint: null,
      allowedOfferIds: [
        ...state.mealOfferIds.breakfast,
        ...state.mealOfferIds.lunch,
        ...state.mealOfferIds.dinner,
      ],
      allowedOptionIds: state.activityIds,
      gate: "program_ready",
    };
  }
  return {
    decisionKind: "flight_choice",
    proposalId: null,
    decisionFingerprint: null,
    allowedOfferIds: state.validCombinationIds,
    allowedOptionIds: [],
    gate: "flights_ready",
  };
}
