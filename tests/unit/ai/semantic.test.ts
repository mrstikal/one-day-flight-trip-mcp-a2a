import { describe, expect, it } from "vitest";
import type { IntentResult } from "@odft/contracts";
import { validateIntentSemantics, type AuthorizedIntentContext } from "@odft/ai";

/**
 * Deterministic semantic validation: membership, duplicate writes, and preserve
 * conflicts convert a command result into a clarification before execution.
 */

const context: AuthorizedIntentContext = {
  knownCityIds: ["geonames:3169070"],
  knownAirportIds: ["ourairports:1", "ourairports:2"],
  knownOfferIds: ["offer-1", "offer-2"],
  knownActivityIds: ["activity-1", "activity-2"],
  knownRestaurantIds: ["restaurant-1", "restaurant-2"],
  todayIsoDate: "2026-10-11",
  currentActivityCounts: { museum: 1 },
};

function commands(result: IntentResult) {
  if (result.kind !== "commands") {
    throw new Error(`expected commands, got ${result.kind}`);
  }
  return result.commands;
}

describe("intent semantic validation", () => {
  it("passes through a supported preference command", () => {
    const result = validateIntentSemantics(
      {
        kind: "commands",
        commands: [{ type: "set_activity_pace", pace: "relaxed" }],
        preserve: ["flights", "hotel"],
        interpretation: "Use a relaxed pace.",
      },
      context,
    );
    expect(result.kind).toBe("commands");
    expect(commands(result)).toHaveLength(1);
  });

  it("turns a preserve conflict into a clarification with two options", () => {
    const result = validateIntentSemantics(
      {
        kind: "commands",
        commands: [{ type: "set_service_override", service: "dinner", level: "luxury" }],
        preserve: ["dinner"],
        interpretation: "Luxury dinner, keep dinner as-is.",
      },
      context,
    );
    expect(result.kind).toBe("clarification");
    if (result.kind === "clarification") {
      expect(result.options).toHaveLength(2);
      expect(result.options.map((option) => option.id)).toEqual(["keep_preserved", "apply_change"]);
      expect(result.requestedCommands).toHaveLength(1);
    }
  });

  it("turns duplicate writes to the same field into a clarification", () => {
    const result = validateIntentSemantics(
      {
        kind: "commands",
        commands: [
          { type: "set_activity_requirement", tag: "museum", minimumCount: 2 },
          { type: "set_activity_requirement", tag: "museum", minimumCount: 4 },
        ],
        preserve: [],
        interpretation: "Conflicting museum counts.",
      },
      context,
    );
    expect(result.kind).toBe("clarification");
    if (result.kind === "clarification") {
      expect(result.options[0]?.commands).toEqual([
        { type: "set_activity_requirement", tag: "museum", minimumCount: 2 },
      ]);
    }
  });

  it("rejects a foreign reference (unknown city) with a clarification", () => {
    const result = validateIntentSemantics(
      {
        kind: "commands",
        commands: [{ type: "set_route", destinationCityId: "geonames:999999" }],
        preserve: [],
        interpretation: "Go to an invented city.",
      },
      context,
    );
    expect(result.kind).toBe("clarification");
  });

  it("rejects a foreign offer for propose_selection with a real alternative search", () => {
    const result = validateIntentSemantics(
      {
        kind: "commands",
        commands: [{ type: "propose_selection", service: "hotel", offerId: "offer-999" }],
        preserve: [],
        interpretation: "Book an invented offer.",
      },
      context,
    );
    expect(result.kind).toBe("clarification");
    if (result.kind === "clarification") {
      expect(result.options[1]?.label).toBe("Review supported alternatives");
      expect(result.options[1]?.commands).toContainEqual({
        type: "find_alternatives",
        target: "hotel",
        objective: "match_preferences",
      });
    }
  });

  it("regenerates opaque option ids and drops options with foreign refs", () => {
    const result = validateIntentSemantics(
      {
        kind: "clarification",
        question: "Which?",
        requestedCommands: [],
        preserve: [],
        options: [
          {
            id: "model-supplied",
            label: "Foreign",
            commands: [{ type: "propose_selection", service: "hotel", offerId: "offer-999" }],
          },
          { id: "b", label: "Pace", commands: [{ type: "set_activity_pace", pace: "relaxed" }] },
          { id: "c", label: "Intensive", commands: [{ type: "set_activity_pace", pace: "intensive" }] },
        ],
      },
      context,
    );
    expect(result.kind).toBe("clarification");
    if (result.kind === "clarification") {
      expect(result.options.map((option) => option.id)).toEqual(["opt_1", "opt_2"]);
      expect(result.options.every((option) => !option.id.includes("model-supplied"))).toBe(true);
    }
  });

  it("rejects a set_program with a foreign meal/activity reference (P1-7)", () => {
    const result = validateIntentSemantics(
      {
        kind: "commands",
        commands: [
          {
            type: "set_program",
            mealOfferIds: { breakfast: "restaurant-1", lunch: "restaurant-2", dinner: "invented" },
            selfArrangedMeals: [],
            preferredActivityIds: ["activity-1"],
            activitiesSelfArranged: false,
          },
        ],
        preserve: [],
        interpretation: "program with a foreign restaurant",
      },
      context,
    );
    expect(result.kind).toBe("clarification");

    const foreignActivity = validateIntentSemantics(
      {
        kind: "commands",
        commands: [
          {
            type: "set_program",
            mealOfferIds: { breakfast: "restaurant-1", lunch: "restaurant-2", dinner: null },
            selfArrangedMeals: [],
            preferredActivityIds: ["invented-activity"],
            activitiesSelfArranged: false,
          },
        ],
        preserve: [],
        interpretation: "program with a foreign activity",
      },
      context,
    );
    expect(foreignActivity.kind).toBe("clarification");

    // A program that changes a preserved meal is a conflict, not a silent write.
    const preservedMeal = validateIntentSemantics(
      {
        kind: "commands",
        commands: [
          {
            type: "set_program",
            mealOfferIds: { breakfast: "restaurant-1", lunch: "restaurant-2", dinner: "restaurant-1" },
            selfArrangedMeals: [],
            preferredActivityIds: [],
            activitiesSelfArranged: false,
          },
        ],
        preserve: ["dinner"],
        interpretation: "program changes dinner",
      },
      context,
    );
    expect(preservedMeal.kind).toBe("clarification");
  });

  it("rejects a set_route outside the sightseeing-date window (P2-12)", () => {
    const past = validateIntentSemantics(
      {
        kind: "commands",
        commands: [{ type: "set_route", sightseeingDate: "2026-10-01" }],
        preserve: [],
        interpretation: "past date",
      },
      context,
    );
    expect(past.kind).toBe("clarification");
    const far = validateIntentSemantics(
      {
        kind: "commands",
        commands: [{ type: "set_route", sightseeingDate: "2030-01-01" }],
        preserve: [],
        interpretation: "too far",
      },
      context,
    );
    expect(far.kind).toBe("clarification");
    const valid = validateIntentSemantics(
      {
        kind: "commands",
        commands: [{ type: "set_route", sightseeingDate: "2026-12-01" }],
        preserve: [],
        interpretation: "valid",
      },
      context,
    );
    expect(valid.kind).toBe("commands");
  });

  it("drops clarification options with conflicting writes (P1-8)", () => {
    const result = validateIntentSemantics(
      {
        kind: "clarification",
        question: "Which?",
        requestedCommands: [],
        preserve: [],
        options: [
          {
            id: "conflicting",
            label: "Two budgets",
            commands: [
              { type: "set_budget", maxBudgetMinor: 100000 },
              { type: "set_budget", maxBudgetMinor: 200000 },
            ],
          },
          { id: "a", label: "Pace", commands: [{ type: "set_activity_pace", pace: "relaxed" }] },
          { id: "b", label: "Intensive", commands: [{ type: "set_activity_pace", pace: "intensive" }] },
        ],
      },
      context,
    );
    expect(result.kind).toBe("clarification");
    if (result.kind === "clarification") {
      expect(result.options).toHaveLength(2);
      expect(result.options.map((option) => option.label)).toEqual(["Pace", "Intensive"]);
    }
  });

  it("converts an empty command list into an unsupported result", () => {
    const result = validateIntentSemantics(
      { kind: "commands", commands: [], preserve: [], interpretation: "nothing" },
      context,
    );
    expect(result.kind).toBe("unsupported");
  });
});
