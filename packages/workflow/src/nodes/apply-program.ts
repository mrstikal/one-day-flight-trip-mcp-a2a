import { InvalidUpdateError } from "@langchain/langgraph";
import { fingerprint } from "@odft/domain";
import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/**
 * Phase 07: apply a `submit_program` selection deterministically. Compatible
 * unbooked meal selections are stored; a differing confirmed meal is staged as a
 * replacement proposal (never moved, removed, or re-keyed). A meal marked
 * self-arranged is stored as that explicit state and never planned. The null
 * dinner without the self-arranged state is accepted only when research produced
 * the deterministic no-slot result.
 */
export async function applyProgramNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  const selections = state.submittedMealSelections;
  if (!selections) {
    throw new InvalidUpdateError("apply_program requires submitted meal selections");
  }
  const ports = travelPorts(runtime);
  const effectScope = fingerprint({
    mealSelections: selections,
    selfArrangedMeals: [...state.submittedSelfArrangedMeals].sort(),
    preferredActivityIds: [...state.submittedActivityIds].sort(),
    activitiesSelfArranged: state.submittedActivitiesSelfArranged,
  });
  const result = await ports.runEffect("apply_program", effectScope, () =>
    ports.applyProgram({
      tripId: state.tripId,
      operationId: state.operationId,
      mealSelections: selections,
      selfArrangedMeals: state.submittedSelfArrangedMeals,
      preferredActivityIds: state.submittedActivityIds,
      activitiesSelfArranged: state.submittedActivitiesSelfArranged,
    }),
  );
  if (result.replacementStaged && result.replacementProposalId) {
    // Open an explicit replacement confirmation for the staged proposal; the
    // confirmed reservation stays active until the user confirms the replacement.
    const service = result.replacementService;
    const replacementOfferId =
      service === "breakfast" || service === "lunch" || service === "dinner"
        ? selections[service]
        : null;
    return {
      programApplied: true,
      replacementStaged: true,
      proposalId: result.replacementProposalId,
      selectedOfferId: replacementOfferId,
      decisionFingerprint: result.replacementSourceFingerprint,
      bookingService: service,
      nextDecisionKind: "replacement_confirmation",
      gate: "awaiting_booking",
    };
  }
  return {
    programApplied: true,
    replacementStaged: false,
    nextDecisionKind: null,
    gate: "program_ready",
  };
}
