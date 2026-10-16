import type { TravelState, TravelUpdate } from "../travel/state.js";
import { routeValidationToState } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/** Stage A: evaluate the route policy and persist its evidence. */
export async function validateRouteNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  const ports = travelPorts(runtime);
  const result = await ports.runEffect("validate_route", "v1", () => ports.evaluateRoute(state.tripId));
  return {
    routeValidationId: result.id ?? null,
    ...routeValidationToState(result),
    gate: result.status === "FEASIBLE" ? "pending" : "route_rejected",
  };
}
