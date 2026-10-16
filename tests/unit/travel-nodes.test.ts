import { describe, expect, it } from "vitest";
import type { TravelState } from "../../packages/workflow/src/travel/state.js";
import { loadContextNode } from "../../packages/workflow/src/nodes/load-context.js";
import { applyDecisionNode } from "../../packages/workflow/src/nodes/apply-decision.js";
import { detectProgressNode } from "../../packages/workflow/src/nodes/detect-progress.js";
import { publishSummaryNode } from "../../packages/workflow/src/nodes/publish-summary.js";
import { prepareDecisionNode } from "../../packages/workflow/src/nodes/prepare-decision.js";
import {
  routeAfterApplyCommands,
  routeAfterApplyDecision,
  routeAfterCommit,
  routeAfterDecline,
  routeAfterDetectProgress,
  routeAfterIntentResult,
  routeAfterLogistics,
  routeAfterReviewItinerary,
  routeAfterSchedules,
  routeAfterValidateItinerary,
  routeAfterValidation,
} from "../../packages/workflow/src/travel/graph.js";
import { isTerminalConflictCode } from "../../apps/worker/src/driver.js";

/** P1-3 / P2-6 / P2-9: travel-graph node behavior that has no DB dependency. */

function state(partial: Partial<TravelState>): TravelState {
  // Node routers read a few fields directly; mirror the schema defaults the
  // driver would have parsed before invoking the graph.
  return {
    recoveryOptionIds: [],
    clarificationOptions: [],
    itineraryBudgetConflict: false,
    planningAttempt: 0,
    itineraryValidationStatus: null,
    itineraryReviewVerdict: null,
    itineraryErrorCodes: [],
    itineraryStatus: null,
    selectedServices: [],
    ...partial,
  } as TravelState;
}

describe("load_context reset (P1-3)", () => {
  it("clears prior-run decision/booking state for a new run on the same thread", async () => {
    const runtime = {
      context: { ports: { loadTrip: async () => ({ trip: { id: "t" } }) } },
    };
    const update = await loadContextNode(
      state({
        tripId: "t",
        decisionKind: "booking_confirmation",
        proposalId: "p",
        selectedOfferId: "o",
        decisionFingerprint: "f".repeat(64),
        reservationId: "r",
        demoReference: "DEMO-FLT-X",
        scheduleStatus: "VALID",
        validCombinationIds: ["o"],
        snapshotId: "s",
        gate: "booked",
        nextDecisionKind: "booking_confirmation",
        itineraryReviewFingerprint: "a".repeat(64),
      }),
      runtime,
    );
    expect(update.decisionKind).toBeNull();
    expect(update.proposalId).toBeNull();
    expect(update.selectedOfferId).toBeNull();
    expect(update.decisionFingerprint).toBeNull();
    expect(update.reservationId).toBeNull();
    expect(update.demoReference).toBeNull();
    expect(update.nextDecisionKind).toBe("flight_choice");
    expect(update.validCombinationIds).toEqual([]);
    expect(update.scheduleStatus).toBe("PENDING");
    expect(update.snapshotId).toBeNull();
    expect(update.gate).toBe("pending");
    expect(update.tripLoaded).toBe(true);
    // Phase 07 reset
    expect(update.bookingService).toBeNull();
    expect(update.domainsEnsured).toBe(false);
    expect(update.researchStatus).toBe("pending");
    expect(update.hotelOfferIds).toEqual([]);
    expect(update.activityIds).toEqual([]);
    expect(update.programApplied).toBe(false);
    expect(update.itineraryReviewFingerprint).toBeNull();
  });
});

describe("reject_proposal -> reselection (P2-6)", () => {
  it("returns to flight selection with the same combinations", () => {
    const update = applyDecisionNode(state({ lastAction: "reject_proposal" }));
    expect(update.pendingStage).toBe("reselection");
    expect(update.nextDecisionKind).toBe("flight_choice");
    expect(update.proposalId).toBeNull();
    // Phase 10: a reselection re-derives its offers through detect_progress
    // instead of preparing a decision from state a fresh operation cleared.
    expect(routeAfterApplyDecision(state({ pendingStage: "reselection" }))).toBe("detect_progress");
  });

  it("confirm_booking commits, choose_offer stages", () => {
    expect(applyDecisionNode(state({ lastAction: "confirm_booking" })).pendingStage).toBe("commit");
    expect(applyDecisionNode(state({ lastAction: "choose_offer" })).pendingStage).toBe("stage");
  });

  it("submit_program applies the program; rejecting a hotel returns to hotel choice (Phase 07)", () => {
    expect(applyDecisionNode(state({ lastAction: "submit_program" })).pendingStage).toBe("program");
    const rejected = applyDecisionNode(
      state({ lastAction: "reject_proposal", bookingService: "hotel" }),
    );
    expect(rejected.pendingStage).toBe("reselection");
    expect(rejected.nextDecisionKind).toBe("hotel_choice");
    expect(rejected.proposalId).toBeNull();

    // An optional meal reservation is standalone: rejecting it ends the run.
    const mealRejected = applyDecisionNode(
      state({ lastAction: "reject_proposal", bookingService: "dinner" }),
    );
    expect(mealRejected.pendingStage).toBe("end");
  });
});

describe("prepare_decision phase 07 kinds", () => {
  it("offers hotel ids for hotel_choice and meal ids/activities for program_choices", () => {
    const hotel = prepareDecisionNode(
      state({ nextDecisionKind: "hotel_choice", hotelOfferIds: ["h1", "h2"] }),
    );
    expect(hotel.decisionKind).toBe("hotel_choice");
    expect(hotel.allowedOfferIds).toEqual(["h1", "h2"]);

    const program = prepareDecisionNode(
      state({
        nextDecisionKind: "program_choices",
        mealOfferIds: { breakfast: ["b1"], lunch: ["l1"], dinner: ["d1"] },
        activityIds: ["a1", "a2"],
      }),
    );
    expect(program.decisionKind).toBe("program_choices");
    expect(program.allowedOfferIds).toEqual(["b1", "l1", "d1"]);
    expect(program.allowedOptionIds).toEqual(["a1", "a2"]);

    const replacement = prepareDecisionNode(
      state({
        nextDecisionKind: "replacement_confirmation",
        proposalId: "p",
        selectedOfferId: "d2",
      }),
    );
    expect(replacement.decisionKind).toBe("replacement_confirmation");
    expect(replacement.allowedOfferIds).toEqual(["d2"]);

    const recovery = prepareDecisionNode(state({ nextDecisionKind: "recovery" }));
    expect(recovery.decisionKind).toBe("recovery");
    expect(recovery.allowedOptionIds).toEqual(["change_hotel", "change_meals"]);
  });

  it("replays the interrupted decision after an unsupported modification", () => {
    const restored = prepareDecisionNode(
      state({
        restoredDecision: {
          decisionKind: "hotel_choice",
          proposalId: null,
          allowedOfferIds: ["h1", "h2"],
          allowedOptionIds: [],
          gate: "hotels_ready",
          pendingReplacement: false,
        },
      }),
    );
    expect(restored.decisionKind).toBe("hotel_choice");
    expect(restored.allowedOfferIds).toEqual(["h1", "h2"]);
    expect(restored.gate).toBe("hotels_ready");
    expect(restored.restoredDecision).toBeNull();
  });

  it("never inherits another decision's fingerprint for derived kinds", () => {
    const stale = "f".repeat(64);
    const hotel = prepareDecisionNode(
      state({
        nextDecisionKind: "hotel_choice",
        hotelOfferIds: ["h1"],
        decisionFingerprint: stale,
      }),
    );
    expect(hotel.decisionFingerprint).toBeNull();

    const program = prepareDecisionNode(
      state({
        nextDecisionKind: "program_choices",
        mealOfferIds: { breakfast: ["b1"], lunch: [], dinner: [] },
        activityIds: [],
        decisionFingerprint: stale,
      }),
    );
    expect(program.decisionFingerprint).toBeNull();

    const flight = prepareDecisionNode(
      state({
        nextDecisionKind: "flight_choice",
        validCombinationIds: [],
        decisionFingerprint: stale,
      }),
    );
    expect(flight.decisionFingerprint).toBeNull();

    const recovery = prepareDecisionNode(
      state({ nextDecisionKind: "recovery", decisionFingerprint: stale }),
    );
    expect(recovery.decisionFingerprint).toBeNull();

    // A confirmation keeps the fingerprint its proposal was staged with (the
    // update leaves the channel untouched).
    const booking = prepareDecisionNode(
      state({
        nextDecisionKind: "booking_confirmation",
        proposalId: "p",
        selectedOfferId: "o",
        decisionFingerprint: stale,
      }),
    );
    expect(booking.decisionFingerprint).toBeUndefined();
  });

  it("choose_option recovery reopens the affected step without editing (Phase 07)", () => {
    const hotel = applyDecisionNode(
      state({ lastAction: "choose_option", lastOptionId: "change_hotel" }),
    );
    expect(hotel.pendingStage).toBe("reselection");
    expect(hotel.nextDecisionKind).toBe("hotel_choice");
    expect(hotel.logisticsStatus).toBe("pending");
    const meals = applyDecisionNode(
      state({ lastAction: "choose_option", lastOptionId: "change_meals" }),
    );
    expect(meals.nextDecisionKind).toBe("program_choices");
  });

  it("detect_progress keeps a reselection's explicit step (recovery reopen)", async () => {
    // A confirmed hotel derives program_choices; the reselection target must win
    // or "Adjust the hotel" would open the meals step.
    const runtime = {
      context: {
        ports: {
          loadProgress: async () => ({
            flightConfirmed: true,
            hotelConfirmed: true,
            confirmedServices: ["flights", "hotel"],
            selectedServices: [],
          }),
        },
      },
    };
    const hotel = await detectProgressNode(
      state({ pendingStage: "reselection", nextDecisionKind: "hotel_choice", tripId: "t" }),
      runtime,
    );
    expect(hotel.nextDecisionKind).toBe("hotel_choice");
    const program = await detectProgressNode(
      state({ pendingStage: "reselection", nextDecisionKind: "program_choices", tripId: "t" }),
      runtime,
    );
    expect(program.nextDecisionKind).toBe("program_choices");
    // Outside a reselection the progress-derived kind still wins.
    const derived = await detectProgressNode(
      state({ nextDecisionKind: "hotel_choice", tripId: "t" }),
      runtime,
    );
    expect(derived.nextDecisionKind).toBe("program_choices");
  });
});

describe("publish_summary structured outcomes (P2-9)", () => {
  it("maps a rejected route and an empty schedule to blocked outcomes", () => {
    expect(publishSummaryNode(state({ gate: "route_rejected" })).lastOutcome).toBe(
      "no_feasible_route",
    );
    expect(publishSummaryNode(state({ gate: "no_schedule" })).lastOutcome).toBe(
      "no_feasible_schedule",
    );
    expect(publishSummaryNode(state({ gate: "booked" })).lastOutcome).toBe("success");
  });

  it("maps a logistics conflict and a staged replacement (Phase 07)", () => {
    expect(publishSummaryNode(state({ gate: "logistics_conflict" })).lastOutcome).toBe(
      "logistics_conflict",
    );
    expect(
      publishSummaryNode(state({ gate: "program_ready", replacementStaged: true })).lastOutcome,
    ).toBe("replacement_pending");
  });
});

describe("routers", () => {
  it("routes non-feasible routes and empty schedules to the summary", () => {
    expect(routeAfterValidation(state({ routeStatus: "INFEASIBLE" }))).toBe("publish_summary");
    expect(routeAfterValidation(state({ routeStatus: "FEASIBLE" }))).toBe("generate_flights");
    expect(routeAfterSchedules(state({ scheduleStatus: "NO_VALID_OFFERS" }))).toBe(
      "publish_summary",
    );
  });

  it("revalidates schedules before research after a domain extension (Phase 07/09)", () => {
    expect(
      routeAfterSchedules(
        state({ scheduleStatus: "VALID", domainsEnsured: true, researchStatus: "pending" }),
      ),
    ).toBe("dispatch_research");
    expect(routeAfterSchedules(state({ scheduleStatus: "VALID" }))).toBe("prepare_decision");
  });

  it("routes a propose_selection command to a staged confirmation (Phase 07)", () => {
    expect(routeAfterApplyCommands(state({ commandType: "propose_selection" }))).toBe(
      "stage_command_proposal",
    );
    expect(routeAfterApplyCommands(state({ commandType: "set_program" }))).toBe("apply_program");
    expect(routeAfterApplyCommands(state({ commandType: "set_route" }))).toBe("detect_progress");
  });

  it("resumes a preference change at the confirmed progress (Phase 07)", () => {
    expect(routeAfterDetectProgress(state({ hasConfirmedFlight: true }))).toBe("ensure_domains");
    expect(routeAfterDetectProgress(state({ hasConfirmedFlight: false }))).toBe("validate_route");
    // Phase 12: a declined booking keeps the flight as a selection, which also
    // settles the step without re-running feasibility.
    expect(
      routeAfterDetectProgress(
        state({ hasConfirmedFlight: false, selectedServices: ["flights"] }),
      ),
    ).toBe("ensure_domains");
  });

  it("an unsupported modification re-presents the decision instead of ending", () => {
    expect(routeAfterIntentResult(state({ intentStatus: "unsupported" }))).toBe("publish_summary");
    expect(
      routeAfterIntentResult(
        state({
          intentStatus: "unsupported",
          restoredDecision: {
            decisionKind: "flight_choice",
            proposalId: null,
            allowedOfferIds: ["f1"],
            allowedOptionIds: [],
            gate: "flights_ready",
            pendingReplacement: false,
          },
        }),
      ),
    ).toBe("prepare_decision");
  });

  it("routes confirmed bookings by service and program actions to logistics (Phase 07)", () => {
    expect(routeAfterCommit(state({ bookingService: "flights" }))).toBe("ensure_domains");
    expect(routeAfterCommit(state({ bookingService: "hotel" }))).toBe(
      "validate_selected_logistics",
    );
    expect(routeAfterApplyDecision(state({ pendingStage: "program" }))).toBe("apply_program");
    expect(
      routeAfterLogistics(state({ logisticsStatus: "valid", nextDecisionKind: "program_choices" })),
    ).toBe("prepare_decision");
    expect(
      routeAfterLogistics(
        state({ logisticsStatus: "valid", nextDecisionKind: "replacement_confirmation" }),
      ),
    ).toBe("prepare_decision");
    expect(routeAfterLogistics(state({ logisticsStatus: "conflict" }))).toBe("prepare_decision");
    // Phase 10: a valid program/logistics state builds the itinerary next.
    expect(routeAfterLogistics(state({ logisticsStatus: "valid", nextDecisionKind: null }))).toBe(
      "plan_itinerary",
    );
  });

  it("routes declined bookings: a late declined change replans, an unchanged one ends", () => {
    // Initial flow: the same service-based continuation as a booking.
    expect(
      routeAfterDecline(state({ bookingService: "flights", nextDecisionKind: "hotel_choice" })),
    ).toBe("ensure_domains");
    expect(
      routeAfterDecline(state({ bookingService: "hotel", nextDecisionKind: "program_choices" })),
    ).toBe("validate_selected_logistics");
    // Late booking of the already-kept offer on a planned trip: nothing changed.
    expect(
      routeAfterDecline(state({ bookingService: "hotel", nextDecisionKind: null })),
    ).toBe("publish_summary");
    // Late declined CHANGE (a different offer than the kept selection): replan.
    expect(
      routeAfterDecline(
        state({ bookingService: "hotel", nextDecisionKind: null, declinedSelectionChanged: true }),
      ),
    ).toBe("validate_selected_logistics");
    expect(
      routeAfterDecline(
        state({
          bookingService: "flights",
          nextDecisionKind: null,
          declinedSelectionChanged: true,
        }),
      ),
    ).toBe("validate_selected_logistics");
  });

  it("routes the Phase 10 itinerary loop by validation, budget, and review", () => {
    expect(
      routeAfterValidateItinerary(
        state({ itineraryValidationStatus: "valid", planningAttempt: 1 }),
      ),
    ).toBe("review_itinerary");
    expect(
      routeAfterValidateItinerary(
        state({ itineraryValidationStatus: "invalid", planningAttempt: 1 }),
      ),
    ).toBe("plan_itinerary");
    expect(
      routeAfterValidateItinerary(
        state({ itineraryValidationStatus: "invalid", planningAttempt: 3 }),
      ),
    ).toBe("prepare_decision");
    expect(
      routeAfterValidateItinerary(
        state({
          itineraryValidationStatus: "invalid",
          itineraryBudgetConflict: true,
          planningAttempt: 1,
        }),
      ),
    ).toBe("prepare_decision");
    expect(
      routeAfterReviewItinerary(state({ itineraryReviewVerdict: "revise", planningAttempt: 2 })),
    ).toBe("plan_itinerary");
    expect(
      routeAfterReviewItinerary(state({ itineraryReviewVerdict: "revise", planningAttempt: 3 })),
    ).toBe("prepare_decision");
    expect(routeAfterReviewItinerary(state({ itineraryReviewVerdict: "acceptable" }))).toBe(
      "prepare_decision",
    );
    expect(routeAfterApplyDecision(state({ pendingStage: "approve" }))).toBe("approve_itinerary");
  });

  it("prepare_decision opens the itinerary approval decision", () => {
    const approval = prepareDecisionNode(
      state({ nextDecisionKind: "itinerary_approval", itineraryId: "i1" }),
    );
    expect(approval.decisionKind).toBe("itinerary_approval");
    expect(approval.gate).toBe("itinerary_ready");
    const itineraryRecovery = prepareDecisionNode(
      state({ nextDecisionKind: "recovery", recoveryOptionIds: ["change_meals", "change_hotel"] }),
    );
    expect(itineraryRecovery.allowedOptionIds).toEqual(["change_meals", "change_hotel"]);
    expect(itineraryRecovery.gate).toBe("itinerary_conflict");
  });

  it("prepare_decision offers the validated combinations or the staged proposal", () => {
    const flight = prepareDecisionNode(
      state({ nextDecisionKind: "flight_choice", validCombinationIds: ["a", "b"] }),
    );
    expect(flight.decisionKind).toBe("flight_choice");
    expect(flight.allowedOfferIds).toEqual(["a", "b"]);
    const booking = prepareDecisionNode(
      state({ nextDecisionKind: "booking_confirmation", proposalId: "p", selectedOfferId: "a" }),
    );
    expect(booking.decisionKind).toBe("booking_confirmation");
    expect(booking.allowedOfferIds).toEqual(["a"]);
  });
});

describe("worker failure classification (P1-4)", () => {
  it("treats deterministic domain failures as terminal conflicts, not retries", () => {
    for (const code of [
      "PROPOSAL_EXPIRED",
      "STALE_DECISION",
      "STALE_ROUTE_APPROVAL",
      "REPLACEMENT_CONFIRMATION_REQUIRED",
      "OFFER_UNAVAILABLE",
      "REDUCER_CONFLICT",
    ]) {
      expect(isTerminalConflictCode(code)).toBe(true);
    }
    for (const code of ["Error", "QueryError", "UNKNOWN", "ECONNRESET"]) {
      expect(isTerminalConflictCode(code)).toBe(false);
    }
  });
});
