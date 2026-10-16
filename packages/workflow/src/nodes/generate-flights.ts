import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/**
 * Generate and persist the outbound/return flight snapshot for the approved
 * route. Returns without offers when no feasible approval exists so the caller
 * routes to the gating summary.
 */
export async function generateFlightsNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  const ports = travelPorts(runtime);
  const materialized = await ports.runEffect("generate_flights", state.routeValidationId ?? "route", () =>
    ports.materializeFlights(state.tripId),
  );
  if (!materialized) {
    return { gate: "no_schedule" };
  }
  return { scenarioKey: materialized.scenarioKey, snapshotId: materialized.snapshotId };
}
