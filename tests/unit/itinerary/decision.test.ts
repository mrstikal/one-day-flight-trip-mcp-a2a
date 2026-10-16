import { describe, expect, it } from "vitest";
import type { ItineraryIssue, ItineraryMetrics } from "@odft/contracts";
import { buildItineraryConflictDecision } from "../../../packages/domain/src/itinerary/decision.js";

/** Phase 10 conflict decision: only supported, genuinely feasible options. */

function metrics(overrides: Partial<ItineraryMetrics> = {}): ItineraryMetrics {
  return {
    activityCount: 2,
    visitMinutes: 180,
    mealMinutes: 180,
    breakMinutes: 60,
    transferMinutes: 30,
    walkingMinutes: 20,
    walkingKm: 2,
    museumCount: 2,
    activityTagCounts: { museum: 2 },
    firstContentStartLocal: "08:00",
    lastContentEndLocal: "21:00",
    totalCostMinor: 10_000,
    budgetMinor: null,
    remainingBudgetMinor: null,
    ...overrides,
  };
}

function error(code: string): ItineraryIssue {
  return { severity: "error", code: code as ItineraryIssue["code"], message: code, eventIds: [], simulatedFailure: false };
}

describe("itinerary conflict decision (Phase 10)", () => {
  it("clears an impossible requirement instead of promising an unreachable count", () => {
    const decision = buildItineraryConflictDecision({
      errors: [error("unmet_minimum_activity_count")],
      metrics: metrics({ activityTagCounts: { museum: 0 }, museumCount: 0 }),
      pace: "relaxed",
      minimumActivityCounts: { museum: 3 },
      review: null,
    });
    expect(decision.kind).toBe("clarification");
    expect(decision.options.map((option) => option.id)).toEqual(["clear_museum", "review_program"]);
    const clear = decision.options[0];
    expect(clear?.commands[0]).toEqual({
      type: "set_activity_requirement",
      tag: "museum",
      minimumCount: null,
    });
    expect(clear?.label).toContain("no museum visits are available");
    // The typed request is preserved for evidence, and no denser pace is promised.
    expect(decision.requestedCommands).toEqual([
      { type: "set_activity_requirement", tag: "museum", minimumCount: 3 },
    ]);
    expect(decision.options.some((option) => option.id.startsWith("denser_pace"))).toBe(false);
  });

  it("caps the reduction at what the plan already achieved", () => {
    const decision = buildItineraryConflictDecision({
      errors: [error("unmet_minimum_activity_count")],
      metrics: metrics({
        activityCount: 4,
        visitMinutes: 320,
        activityTagCounts: { museum: 4 },
        museumCount: 4,
      }),
      pace: "relaxed",
      minimumActivityCounts: { museum: 6 },
      review: null,
    });
    const reduce = decision.options.find((option) => option.id === "reduce_museum");
    // floor(240 / 80) = 3, capped by the four actually placed.
    expect(reduce?.commands[0]).toEqual({
      type: "set_activity_requirement",
      tag: "museum",
      minimumCount: 3,
    });
    // Six 80-minute visits need 480 minutes: even the moderate cap (360) cannot
    // hold them, so no denser pace is promised.
    expect(decision.options.map((option) => option.id)).toEqual([
      "reduce_museum",
      "review_program",
    ]);
  });

  it("offers a denser pace only when it can genuinely fit", () => {
    const decision = buildItineraryConflictDecision({
      errors: [error("unmet_minimum_activity_count")],
      metrics: metrics({
        activityCount: 2,
        visitMinutes: 160,
        activityTagCounts: { museum: 2 },
        museumCount: 2,
      }),
      pace: "relaxed",
      minimumActivityCounts: { museum: 4 },
      review: null,
    });
    // floor(240 / 80) = 3 and 4 * 80 = 320 <= moderate cap 360.
    expect(decision.options.map((option) => option.id)).toEqual([
      "reduce_museum",
      "denser_pace_moderate",
      "review_program",
    ]);
  });

  it("offers the raise-budget clarification without falsifying prices", () => {
    const decision = buildItineraryConflictDecision({
      errors: [error("budget_exceeded")],
      metrics: metrics({ totalCostMinor: 41_797, budgetMinor: 100 }),
      pace: "moderate",
      minimumActivityCounts: {},
      review: null,
    });
    expect(decision.kind).toBe("clarification");
    expect(decision.options.map((option) => option.id)).toEqual(["raise_budget", "keep_budget"]);
    expect(decision.options[0]?.commands[0]).toEqual({
      type: "set_budget",
      maxBudgetMinor: 41_797,
    });
    expect(decision.question).toContain("EUR 417.97");
    expect(decision.question).toContain("No price was changed");
  });

  it("falls back to recovery when no supported adjustment exists", () => {
    const decision = buildItineraryConflictDecision({
      errors: [error("missing_required_meal")],
      metrics: metrics(),
      pace: "intensive",
      minimumActivityCounts: {},
      review: null,
    });
    expect(decision.kind).toBe("recovery");
    expect(decision.recoveryOptionIds).toEqual(["change_meals", "change_hotel"]);
    expect(decision.options).toEqual([]);
  });
});

describe("packing-conflict options (2026-10-14)", () => {
  it("offers a denser pace, a bounded tag reduction, and the review path", () => {
    const decision = buildItineraryConflictDecision({
      errors: [error("transfer_gap"), error("overlap")],
      metrics: metrics({ activityTagCounts: { museum: 2 }, activityCount: 2, visitMinutes: 212 }),
      pace: "moderate",
      minimumActivityCounts: { museum: 2 },
      review: null,
    });
    expect(decision.kind).toBe("clarification");
    expect(decision.options.map((option) => option.id)).toEqual([
      "denser_pace_intensive",
      "reduce_museum",
      "review_program",
    ]);
    expect(decision.options[1]?.commands[0]).toEqual({
      type: "set_activity_requirement",
      tag: "museum",
      minimumCount: 1,
    });
    expect(decision.question).toContain("cannot fit these visits");
  });

  it("still falls back to recovery when no supported packing change exists", () => {
    const decision = buildItineraryConflictDecision({
      errors: [error("transfer_gap")],
      metrics: metrics(),
      pace: "intensive",
      minimumActivityCounts: {},
      review: null,
    });
    expect(decision.kind).toBe("recovery");
    expect(decision.recoveryOptionIds).toEqual(["change_meals", "change_hotel"]);
  });
});
