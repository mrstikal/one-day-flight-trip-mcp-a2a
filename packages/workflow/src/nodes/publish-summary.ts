import type { TravelState, TravelUpdate } from "../travel/state.js";

/**
 * Terminal node: report the structured outcome; the driver reconciles the
 * projection. A rejected route or an empty schedule is a *blocked* outcome (a
 * decision card explains it), never a plain success/ready.
 */
export function publishSummaryNode(state: TravelState): TravelUpdate {
  if (state.gate === "route_rejected") {
    return { lastOutcome: "no_feasible_route" };
  }
  if (state.gate === "no_schedule") {
    return { lastOutcome: "no_feasible_schedule" };
  }
  if (state.gate === "logistics_conflict") {
    return { lastOutcome: "logistics_conflict" };
  }
  if (state.gate === "research_failed") {
    return { lastOutcome: "research_failed" };
  }
  if (state.gate === "withdrawn") {
    return { lastOutcome: "withdrawn" };
  }
  if (state.gate === "chat_done") {
    return {
      lastOutcome: state.intentStatus === "search_pending" ? "chat_search_pending" : "chat_unsupported",
    };
  }
  if (state.gate === "approved" && state.itineraryStatus === "approved") {
    return { lastOutcome: "itinerary_approved" };
  }
  if (state.replacementStaged) {
    return { lastOutcome: "replacement_pending" };
  }
  if (state.lastOutcome === "route_changed") {
    return { lastOutcome: "route_changed" };
  }
  return { lastOutcome: "success" };
}
