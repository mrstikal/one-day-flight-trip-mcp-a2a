import type { TravelState } from "../travel/state.js";

/**
 * The dedicated stage for an admitted command's own action, when it has one.
 * `set_program` applies the program payload, `propose_selection` stages a
 * proposal, `build_itinerary` plans directly, and a STAGED route change presents
 * its impact confirmation. Returns null for everything else, which then routes
 * by the invalidation matrix's work item.
 */
export function routeForCommandType(state: TravelState): string | null {
  switch (state.commandType) {
    case "set_program":
      return "apply_program";
    case "propose_selection":
      return "stage_command_proposal";
    case "build_itinerary":
      return "plan_itinerary";
    case "route_change":
      return state.routeChangePreview !== null ? "prepare_decision" : null;
    default:
      return null;
  }
}

/**
 * Phase 11: the single mapping from the invalidation matrix's work item to the
 * graph node that executes it. Used by every router that dispatches a work item
 * so the mapping can never drift between entry paths.
 */
export function routeByNextWork(state: TravelState): string | null {
  switch (state.nextWork) {
    case "research":
      // A confirmed OR selected (declined booking) flight settles the flight
      // step, so the hotel/program research can run on the extended snapshot.
      return state.hasConfirmedFlight || state.selectedServices.includes("flights")
        ? "ensure_domains"
        : "validate_route";
    case "progress":
      return "detect_progress";
    case "plan":
      return "plan_itinerary";
    case "validate":
      return "validate_selected_logistics";
    case "summary":
      return "publish_summary";
    case "route":
      return "validate_route";
    default:
      return null;
  }
}
