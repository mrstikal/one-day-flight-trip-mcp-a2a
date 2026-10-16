import { InvalidUpdateError } from "@langchain/langgraph";
import type { TravelState, TravelUpdate } from "../travel/state.js";
import { scheduleValidationToState } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/** Stage B: independently validate generated combinations against schedule rules. */
export async function validateSchedulesNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  if (!state.snapshotId) {
    throw new InvalidUpdateError("validate_schedules requires a persisted snapshot");
  }
  const ports = travelPorts(runtime);
  const result = await ports.runEffect("validate_schedules", state.snapshotId, () =>
    ports.validateSchedules({ tripId: state.tripId, snapshotId: state.snapshotId as string }),
  );
  return {
    scheduleValidationId: result.id ?? null,
    ...scheduleValidationToState(result),
    gate: result.status === "VALID" ? "pending" : "no_schedule",
  };
}
