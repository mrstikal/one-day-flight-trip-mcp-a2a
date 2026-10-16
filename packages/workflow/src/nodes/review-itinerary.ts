import { clarificationOptionSchema } from "@odft/contracts";
import { fingerprint } from "@odft/domain";
import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/**
 * Phase 10: review a deterministically valid draft through the reviewer role
 * (or fixture). A `revise` verdict returns to the planner while attempts remain;
 * at the three-attempt bound the nonblocking suggestions are demoted to visible
 * warnings and the approval decision still opens. A `conflict` verdict opens the
 * blocking clarification instead.
 */
export async function reviewItineraryNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  const ports = travelPorts(runtime);
  const atBound = state.planningAttempt >= 3;
  const result = await ports.reviewItinerary({
    tripId: state.tripId,
    operationId: state.operationId,
    attempt: state.planningAttempt,
    atBound,
    previousRevisionFingerprint: state.itineraryReviewFingerprint,
  });

  if (result.verdict === "revise" && !atBound) {
    // The typed findings and the suggested order (as stable candidate refs) go
    // back to the planner as bounded feedback; they are never applied as a state
    // mutation.
    const orderFeedback =
      result.suggestedCandidateOrder.length > 0
        ? [`review: suggested order: ${result.suggestedCandidateOrder.join(" > ")}`.slice(0, 300)]
        : [];
    return {
      itineraryReviewFingerprint: result.revisionFingerprint,
      itineraryReviewVerdict: "revise",
      itineraryReviewSuggestions: [...result.suggestions],
      itineraryFeedback: [
        ...result.suggestions.map((suggestion) => `review: ${suggestion}`.slice(0, 300)),
        ...orderFeedback,
      ].slice(0, 10),
    };
  }

  if (result.verdict === "conflict") {
    const conflict = result.conflictDecision;
    return {
      itineraryReviewFingerprint: result.revisionFingerprint,
      itineraryReviewVerdict: "conflict",
      itineraryReviewSuggestions: [...result.suggestions],
      itineraryWarningCodes: [
        ...state.itineraryWarningCodes,
        ...result.warnings.map((warning) => warning.code),
      ],
      clarificationQuestion: conflict?.kind === "clarification" ? conflict.question : null,
      clarificationOptions:
        conflict?.kind === "clarification"
          ? conflict.options.map((option) => clarificationOptionSchema.parse(option))
          : [],
      clarificationRequestedCommands:
        conflict?.kind === "clarification" ? [...conflict.requestedCommands] : [],
      recoveryOptionIds: conflict?.kind === "recovery" ? [...conflict.recoveryOptionIds] : [],
      nextDecisionKind:
        conflict?.kind === "recovery" ? "recovery" : "clarification",
      decisionFingerprint: fingerprint({
        kind: "itinerary_review_conflict",
        tripId: state.tripId,
        operationId: state.operationId,
        itineraryId: state.itineraryId,
      }),
      gate: conflict?.kind === "recovery" ? "itinerary_conflict" : "clarification",
    };
  }

  // Acceptable, or revise demoted to warnings at the bound: open the approval.
  return {
    itineraryReviewFingerprint: result.revisionFingerprint,
    itineraryReviewVerdict: result.verdict,
    itineraryReviewSuggestions: [...result.suggestions],
    itineraryWarningCodes: [
      ...state.itineraryWarningCodes,
      ...result.warnings.map((warning) => warning.code),
    ],
    nextDecisionKind: "itinerary_approval",
    decisionFingerprint: fingerprint({
      kind: "itinerary_approval",
      tripId: state.tripId,
      operationId: state.operationId,
      itineraryId: state.itineraryId,
      attempt: state.planningAttempt,
    }),
    gate: "itinerary_ready",
  };
}
