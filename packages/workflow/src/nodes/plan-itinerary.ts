import { clarificationOptionSchema } from "@odft/contracts";
import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";
import { fingerprint } from "@odft/domain";

/**
 * Phase 10: one bounded planning attempt (03-langgraph-design.md section 4).
 *
 * The node increments `planningAttempt` exactly once per execution and delegates
 * to the `planItinerary` port (planner role/fixture + deterministic assembly +
 * validator + immutable draft persistence). It never calls an LLM itself.
 */
export async function planItineraryNode(state: TravelState, runtime: unknown): Promise<TravelUpdate> {
  const ports = travelPorts(runtime);
  const attempt = state.planningAttempt + 1;
  const result = await ports.planItinerary({
    tripId: state.tripId,
    operationId: state.operationId,
    attempt,
    feedback: state.itineraryFeedback,
  });

  const conflict = result.conflictDecision;
  const clarificationOptions =
    conflict?.kind === "clarification"
      ? conflict.options.map((option) => clarificationOptionSchema.parse(option))
      : [];

  return {
    planningAttempt: attempt,
    itineraryId: result.itineraryId,
    itineraryVersion: result.version,
    itineraryStatus: result.itineraryId ? "draft" : null,
    itineraryValidationStatus: result.status,
    itineraryErrorCodes: result.errors.map((error) => error.code),
    itineraryWarningCodes: result.warnings.map((warning) => warning.code),
    itineraryBudgetConflict: result.budgetConflict,
    itineraryTotalCostMinor: result.metrics.totalCostMinor,
    itineraryReviewVerdict: null,
    itineraryReviewSuggestions: [],
    // Bounded feedback for the next attempt: review suggestions plus the
    // deterministic errors of this attempt (the planner adapts to the latest
    // result; the list is capped and never unbounded).
    itineraryFeedback: [
      ...state.itineraryFeedback.filter((entry) => entry.startsWith("review:")),
      ...result.errors.map((error) => `${error.code}: ${error.message}`.slice(0, 300)),
    ]
      .filter((entry, index, all) => all.indexOf(entry) === index)
      .slice(-10),
    clarificationQuestion: conflict?.kind === "clarification" ? conflict.question : null,
    clarificationOptions,
    clarificationRequestedCommands:
      conflict?.kind === "clarification" ? [...conflict.requestedCommands] : [],
    recoveryOptionIds: conflict?.kind === "recovery" ? [...conflict.recoveryOptionIds] : [],
    decisionFingerprint:
      conflict === null
        ? null
        : fingerprint({
            kind: "itinerary_conflict",
            tripId: state.tripId,
            operationId: state.operationId,
            attempt,
            errors: result.errors.map((error) => error.code),
          }),
    gate: "pending",
  };
}
