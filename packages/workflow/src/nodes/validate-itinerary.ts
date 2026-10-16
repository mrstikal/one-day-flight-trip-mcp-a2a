import type { TravelState, TravelUpdate } from "../travel/state.js";

/**
 * Phase 10: interpret the deterministic validation result of the last planning
 * attempt (the port already assembled, validated, and persisted the draft).
 *
 * - valid: continue to review;
 * - invalid with attempts remaining and no budget conflict: replan with feedback;
 * - invalid at the bound, or any budget conflict: open the conflict decision
 *   (clarification with feasible options, or the recovery fallback).
 */
export function validateItineraryNode(state: TravelState): TravelUpdate {
  if (state.itineraryValidationStatus === "valid") {
    return {
      itineraryBudgetConflict: false,
      recoveryOptionIds: [],
    };
  }

  const recovery =
    state.recoveryOptionIds.length > 0 && state.clarificationOptions.length === 0;
  return {
    itineraryBudgetConflict: state.itineraryBudgetConflict,
    nextDecisionKind: recovery ? "recovery" : "clarification",
    gate: recovery ? "itinerary_conflict" : "clarification",
  };
}