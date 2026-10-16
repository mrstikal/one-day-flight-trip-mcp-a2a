import { InvalidUpdateError } from "@langchain/langgraph";
import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/**
 * Phase 10: fenced approval of the current draft. The port re-verifies the draft
 * status, the deterministic validation, and the current source fingerprint; a
 * stale approval throws a typed conflict instead of approving changed inputs.
 */
export async function approveItineraryNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  if (!state.itineraryId || !state.lastDecisionId) {
    throw new InvalidUpdateError("no itinerary draft or approval decision is active");
  }
  const ports = travelPorts(runtime);
  const result = await ports.approveItinerary({
    tripId: state.tripId,
    operationId: state.operationId,
    decisionId: state.lastDecisionId,
    acceptedRevision: state.acceptedRevision,
    itineraryId: state.itineraryId,
  });
  return {
    itineraryId: result.itineraryId,
    itineraryVersion: result.version,
    itineraryStatus: "approved",
    pendingStage: null,
    gate: "approved",
    lastOutcome: null,
  };
}