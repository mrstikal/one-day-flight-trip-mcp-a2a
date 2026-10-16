import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/**
 * Phase 07: deterministic selected-logistics check. It validates the selected
 * hotel's airport-transfer estimate and the confirmed meal windows against the
 * flight instants. On a conflict it returns a typed outcome and never edits a
 * reservation to make the check pass.
 */
export async function validateSelectedLogisticsNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  const ports = travelPorts(runtime);
  const scope = `${state.bookingService ?? "none"}:${state.programApplied ? "program" : "hotel"}`;
  const result = await ports.runEffect("validate_selected_logistics", scope, () =>
    ports.validateSelectedLogistics({ tripId: state.tripId }),
  );
  return {
    logisticsStatus: result.status,
    logisticsReason: result.reason,
    gate: result.status === "conflict" ? "logistics_conflict" : state.gate,
    // A conflict opens a typed recovery decision (never an edit).
    ...(result.status === "conflict" ? { nextDecisionKind: "recovery" } : {}),
  };
}
