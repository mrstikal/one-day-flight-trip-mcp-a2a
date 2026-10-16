import { interrupt, InvalidUpdateError } from "@langchain/langgraph";
import { graphResumeEnvelopeSchema, mealSchema, type DecisionKind } from "@odft/contracts";
import { OPERATION_LOCAL_RESETS, type TravelState, type TravelUpdate } from "../travel/state.js";

/**
 * The single interrupt node (03-langgraph-design.md section 6). It pauses for the
 * current decision, validates the trusted resume envelope against the offered
 * options/offers, and forwards the new operation identity to downstream nodes.
 * It performs no side effects.
 */
export async function awaitDecisionNode(state: TravelState): Promise<TravelUpdate> {
  const kind: DecisionKind = state.decisionKind ?? "clarification";
  const resume = interrupt(
    {
      kind,
      allowedOptionIds: state.allowedOptionIds,
      allowedOfferIds: state.allowedOfferIds,
      proposalId: state.proposalId ?? undefined,
      sourceFingerprint: state.decisionFingerprint ?? undefined,
      // Clarification option labels are persisted server-side for the projection.
      ...(kind === "clarification"
        ? {
            optionPayload: {
              question: state.clarificationQuestion,
              options: state.clarificationOptions.map((option) => ({
                id: option.id,
                label: option.label,
              })),
              // Server-side only (never rendered): the typed request the model
              // asked about, so a follow-up has the full authoritative context.
              requestedCommands: state.clarificationRequestedCommands,
              preserve: state.intentPreserve,
            },
          }
        : {}),
      // Phase 11: the route-change impact preview is persisted with the decision
      // so the projection can render it. Only the public fields are stored; the
      // deferred command batch stays in the checkpoint.
      ...(kind === "route_change_confirmation" && state.routeChangePreview
        ? {
            optionPayload: {
              proposalId: state.routeChangePreview.proposalId,
              changedFields: state.routeChangePreview.changedFields,
              from: state.routeChangePreview.from,
              to: state.routeChangePreview.to,
              affectedReservations: state.routeChangePreview.affectedReservations,
            },
          }
        : {}),
    },
    { responseSchema: graphResumeEnvelopeSchema },
  );
  const envelope = graphResumeEnvelopeSchema.parse(resume);
  const response = envelope.response;
  const base = {
    operationId: envelope.operationId,
    acceptedRevision: envelope.acceptedRevision,
    lastDecisionId: envelope.decisionId,
    decisionKind: null,
    // Phase 10: a resolved decision starts the new operation's planning budget
    // (3 total attempts per user operation) and clears stale replan feedback.
    planningAttempt: 0,
    itineraryFeedback: [],
    itineraryReviewFingerprint: null,
  } satisfies Partial<TravelUpdate>;

  // Phase 11: a free-text follow-up is admitted as a modification for EVERY
  // pending decision kind, not only clarifications. The envelope is built by the
  // worker (the browser cannot supply `modify`); the old decision is resolved
  // explicitly by the driver once the new operation succeeds.
  if (response.action === "modify") {
    return {
      ...base,
      // A modification restarts the operation-local execution state, or it would
      // keep the previous operation's `researchStatus: "ok"` and skip the
      // required refresh, reopening the decision with stale offers (Phase 11
      // review fix). Other resumes keep the status: the recovery flow relies on
      // the retained `failed` state to explain the gap and offer a retry.
      ...OPERATION_LOCAL_RESETS,
      lastAction: "modify",
      modificationOperationId: response.commandOperationId,
      // Capture what was interrupted (kind + gate). Only an unsupported
      // modification replays it; a supported one presents its own decision.
      interruptedDecision: { decisionKind: kind, gate: state.gate },
    };
  }

  if (kind === "flight_choice" || kind === "hotel_choice") {
    if (response.action !== "choose_offer" || !state.allowedOfferIds.includes(response.offerId)) {
      throw new InvalidUpdateError("the choice must select one of the offered ids");
    }
    return {
      ...base,
      lastAction: "choose_offer",
      lastOfferId: response.offerId,
      bookingService: kind === "hotel_choice" ? "hotel" : "flights",
    };
  }
  if (kind === "program_choices") {
    if (response.action !== "submit_program") {
      throw new InvalidUpdateError("program choices accept only submit_program");
    }
    const allowed = new Set(state.allowedOfferIds);
    const selfArranged = new Set(response.selfArrangedMeals);
    for (const meal of mealSchema.options) {
      const offerId = response.mealOfferIds[meal];
      if (selfArranged.has(meal)) {
        if (offerId !== null) {
          throw new InvalidUpdateError(`${meal} cannot be selected and self-arranged`);
        }
        continue;
      }
      if (offerId === null) {
        if (meal !== "dinner") {
          throw new InvalidUpdateError(`${meal} must be an offered meal id or self-arranged`);
        }
        // A null dinner without the self-arranged state is the deterministic
        // no-slot result; planProgramSelections verifies it server-side.
        continue;
      }
      if (!allowed.has(offerId)) {
        throw new InvalidUpdateError(`the selected ${meal} is not an offered meal id`);
      }
    }
    const activityIds = new Set(state.allowedOptionIds);
    for (const activityId of response.preferredActivityIds) {
      if (!activityIds.has(activityId)) {
        throw new InvalidUpdateError("the selected activity is not an offered option");
      }
    }
    return {
      ...base,
      lastAction: "submit_program",
      submittedMealSelections: response.mealOfferIds,
      submittedSelfArrangedMeals: response.selfArrangedMeals,
      submittedActivitiesSelfArranged: response.activitiesSelfArranged,
      submittedActivityIds: response.preferredActivityIds,
    };
  }
  if (kind === "booking_confirmation" || kind === "replacement_confirmation") {
    if (response.action === "confirm_booking") {
      return {
        ...base,
        lastAction: "confirm_booking",
        lastProposalId: response.proposalId,
        selectedOfferId: state.selectedOfferId,
        pendingReplacement: kind === "replacement_confirmation",
      };
    }
    if (response.action === "reject_proposal") {
      return { ...base, lastAction: "reject_proposal", lastProposalId: response.proposalId };
    }
    if (response.action === "decline_booking") {
      // "I don't want to book": only the flight and the hotel keep a selection
      // for a declined booking; a meal reservation is simply not made instead.
      const service = state.bookingService;
      if (service !== "flights" && service !== "hotel") {
        throw new InvalidUpdateError("only a flight or hotel booking can be declined");
      }
      return { ...base, lastAction: "decline_booking", lastProposalId: response.proposalId };
    }
    throw new InvalidUpdateError(
      "booking confirmation accepts confirm_booking, reject_proposal, or decline_booking",
    );
  }
  if (kind === "route_change_confirmation") {
    if (response.action !== "confirm_route_change") {
      throw new InvalidUpdateError("route change confirmation accepts only confirm_route_change");
    }
    if (
      state.routeChangeProposalId === null ||
      response.proposalId !== state.routeChangeProposalId
    ) {
      throw new InvalidUpdateError("the confirmation does not match the staged route change");
    }
    const named = [...response.affectedReservationIds].sort();
    const preview = [
      ...(state.routeChangePreview?.affectedReservations.map((entry) => entry.id) ?? []),
    ].sort();
    if (preview.length === 0 || named.join(",") !== preview.join(",")) {
      throw new InvalidUpdateError(
        "the confirmation must name exactly the reservations the preview listed",
      );
    }
    return {
      ...base,
      lastAction: "confirm_route_change",
      lastProposalId: response.proposalId,
      lastAffectedReservationIds: named,
    };
  }
  if (kind === "itinerary_approval") {
    if (response.action !== "approve_itinerary") {
      throw new InvalidUpdateError("itinerary approval accepts only approve_itinerary");
    }
    if (!state.itineraryId || response.itineraryId !== state.itineraryId) {
      throw new InvalidUpdateError("the approval must reference the current itinerary draft");
    }
    return { ...base, lastAction: "approve_itinerary" };
  }
  if (kind === "recovery") {
    if (
      response.action !== "choose_option" ||
      !state.allowedOptionIds.includes(response.optionId)
    ) {
      throw new InvalidUpdateError("recovery accepts one of the offered options");
    }
    return { ...base, lastAction: "choose_option", lastOptionId: response.optionId };
  }
  if (kind === "clarification") {
    if (response.action === "choose_option") {
      if (!state.allowedOptionIds.includes(response.optionId)) {
        throw new InvalidUpdateError("the chosen clarification option is not offered");
      }
      return { ...base, lastAction: "choose_clarification", lastOptionId: response.optionId };
    }
    throw new InvalidUpdateError("clarification accepts choose_option or a modify follow-up");
  }
  return { ...base, lastAction: response.action };
}
