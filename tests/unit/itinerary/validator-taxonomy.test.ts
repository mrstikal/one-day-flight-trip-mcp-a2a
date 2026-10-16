import { describe, expect, it } from "vitest";
import type { ItineraryEvent, ItineraryIssue, ItineraryReview } from "@odft/contracts";
import {
  computeItineraryFingerprint,
  computeItinerarySourceFingerprint,
  validateItinerary,
  type ValidateItineraryInput,
} from "../../../packages/domain/src/itinerary/validate.js";
import type { ItineraryCosts } from "@odft/contracts";

let sequence = 0;
function event(partial: Partial<ItineraryEvent> & Pick<ItineraryEvent, "kind">): ItineraryEvent {
  sequence += 1;
  const startMinute = partial.startMinute ?? 8 * 60;
  const durationMinutes = partial.durationMinutes ?? 60;
  const id = `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
  return {
    ...partial,
    id: partial.id ?? id,
    kind: partial.kind,
    title: partial.title ?? `Event ${sequence}`,
    localDate: partial.localDate ?? "2026-07-10",
    startMinute,
    endMinute: partial.endMinute ?? startMinute + durationMinutes,
    startLocal: partial.startLocal ?? "08:00",
    endLocal: partial.endLocal ?? "09:00",
    startInstant: partial.startInstant ?? "2026-07-10T06:00:00Z",
    endInstant: partial.endInstant ?? "2026-07-10T07:00:00Z",
    zone: partial.zone ?? "Europe/Rome",
    durationMinutes,
    refId: partial.refId ?? null,
    activityTags: partial.activityTags ?? [],
    provenance: partial.provenance ?? ["Test provenance"],
    physicalDemand: partial.physicalDemand ?? "low",
    costInclusionKey: partial.costInclusionKey ?? null,
    costMinor: partial.costMinor ?? 0,
    location: partial.location ?? null,
    locked: partial.locked ?? false,
    lockReason: partial.lockReason ?? null,
    simulated: partial.simulated ?? false,
  } as ItineraryEvent;
}

function costs(totalMinor: number): ItineraryCosts {
  return {
    items:
      totalMinor > 0
        ? [
            {
              key: "flight:1",
              label: "Flights",
              category: "flights",
              amountMinor: totalMinor,
              provenance: ["Confirmed"],
            },
          ]
        : [],
    totalMinor,
    dinnerExcluded: false,
    dinnerExcludedReason: null,
    excludedNotes: ["Nothing else"],
  };
}

/** A complete, valid relaxed day: breakfast, two visits, lunch, breaks, dinner. */
function validDay(): ItineraryEvent[] {
  return [
    event({ kind: "meal", refId: "m-b", title: "Breakfast", startMinute: 8 * 60, durationMinutes: 60 }),
    event({ kind: "activity", refId: "a-1", title: "Museum", activityTags: ["museum"], startMinute: 9 * 60 + 30, durationMinutes: 90 }),
    event({ kind: "break", title: "Break", startMinute: 11 * 60, durationMinutes: 20 }),
    event({ kind: "transfer", title: "Transfer", startMinute: 11 * 60 + 20, durationMinutes: 10 }),
    event({ kind: "meal", refId: "m-l", title: "Lunch", startMinute: 12 * 60 + 30, durationMinutes: 90 }),
    event({ kind: "activity", refId: "a-2", title: "Park", activityTags: ["park"], startMinute: 14 * 60 + 30, durationMinutes: 60 }),
    event({ kind: "break", title: "Long break", startMinute: 15 * 60 + 40, durationMinutes: 60 }),
    event({ kind: "meal", refId: "m-d", title: "Dinner", startMinute: 19 * 60, durationMinutes: 120 }),
    event({ kind: "airport_buffer", title: "Airport buffer", startMinute: 21 * 60, durationMinutes: 120, locked: true }),
  ];
}

function baseInput(overrides: Partial<ValidateItineraryInput> = {}): ValidateItineraryInput {
  return {
    events: validDay(),
    assemblyIssues: [],
    costs: costs(60_000),
    walkingKm: 2.4,
    pace: "relaxed",
    minimumActivityCounts: { museum: 1 },
    preferredActivityIds: [],
    budgetMinor: null,
    dinnerExcludedReason: null,
    dinnerSelected: true,
    simulatedFailure: false,
    source: {
      snapshotId: "snap-1",
      sightseeingDate: "2026-07-10",
      travelVariant: "one_night",
      adults: 2,
      destinationCityId: "rome",
      pace: "relaxed",
      minimumActivityCounts: { museum: 1 },
      preferredActivityIds: [],
      budgetMinor: null,
      mealSelectionIds: { breakfast: "m-b", lunch: "m-l", dinner: "m-d" },
      confirmedMealIds: ["m-l"],
      flightOfferId: "flight-1",
      flightBooked: true,
      hotelOfferId: "hotel-1",
      hotelBooked: true,
      selfArrangedMeals: [],
      selfArrangedActivities: false,
    },
    ...overrides,
  };
}

function codes(input: ValidateItineraryInput): string[] {
  return validateItinerary(input).errors.map((error) => error.code);
}

function issue(code: string, eventIds: string[] = []): ItineraryIssue {
  return { severity: "error", code: code as ItineraryIssue["code"], message: `${code}`, eventIds, simulatedFailure: false };
}

describe("itinerary validator taxonomy (Phase 10 section 4)", () => {
  it("accepts a complete relaxed day with no errors", () => {
    const result = validateItinerary(baseInput());
    expect(result.errors).toEqual([]);
    expect(result.status).toBe("valid");
    expect(result.metrics.activityCount).toBe(2);
    expect(result.metrics.visitMinutes).toBe(150);
    expect(result.metrics.museumCount).toBe(1);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("blocks overlap with the anchored event ids", () => {
    const events = validDay();
    const museum = events[1] as ItineraryEvent;
    const result = validateItinerary(
      baseInput({ assemblyIssues: [issue("overlap", [museum.id])] }),
    );
    expect(result.status).toBe("invalid");
    expect(result.errors[0]?.eventIds).toEqual([museum.id]);
  });

  it("blocks transfer gaps, opening hours, airport buffer, and incompatible reservations", () => {
    for (const code of ["transfer_gap", "opening_hours_mismatch", "airport_buffer", "incompatible_reservation"]) {
      expect(codes(baseInput({ assemblyIssues: [issue(code)] }))).toContain(code);
    }
  });

  it("warns, never blocks, when meal/visit content spans less than seven hours", () => {
    const events = [
      event({ kind: "meal", refId: "m-b", title: "Breakfast", startMinute: 8 * 60, durationMinutes: 60 }),
      event({ kind: "activity", refId: "a-1", title: "Museum", activityTags: ["museum"], startMinute: 9 * 60, durationMinutes: 60 }),
      event({ kind: "break", title: "Break", startMinute: 10 * 60, durationMinutes: 20 }),
      event({ kind: "meal", refId: "m-l", title: "Lunch", startMinute: 11 * 60, durationMinutes: 60 }),
      event({ kind: "meal", refId: "m-d", title: "Dinner", startMinute: 18 * 60, durationMinutes: 60 }),
    ];
    // 08:00-12:00 content only; dinner at 18:00 pushes the span over seven
    // hours, so remove dinner to prove the threshold. The span is a GUIDELINE
    // since visits became opt-in (2026-10-14): warning, never an error.
    const withoutDinner = events.slice(0, 4);
    const short = validateItinerary(
      baseInput({
        events: withoutDinner,
        dinnerSelected: false,
        dinnerExcludedReason: "Not included - return flight too early.",
      }),
    );
    expect(short.status).toBe("valid");
    expect(short.warnings.map((entry) => entry.code)).toContain("insufficient_sightseeing");
    expect(short.errors.map((entry) => entry.code)).not.toContain("insufficient_sightseeing");
    const long = validateItinerary(baseInput({ events, dinnerSelected: true }));
    expect(long.warnings.map((entry) => entry.code)).not.toContain("insufficient_sightseeing");
  });

  it("accepts a plan with no visits at all (visits are opt-in)", () => {
    const mealsOnly = validDay().filter((entry) => entry.kind !== "activity");
    const result = validateItinerary(baseInput({ events: mealsOnly, minimumActivityCounts: {} }));
    expect(result.errors.map((entry) => entry.code)).not.toContain("insufficient_sightseeing");
    expect(result.status).toBe("valid");
  });

  it("blocks missing required meals and missing breaks", () => {
    const noBreakfast = validDay().filter((entry) => entry.refId !== "m-b");
    expect(codes(baseInput({ events: noBreakfast }))).toContain("missing_required_meal");

    const noBreaks = validDay().filter((entry) => entry.kind !== "break");
    expect(codes(baseInput({ events: noBreaks }))).toContain("missing_break");

    const noDinner = validDay().filter((entry) => entry.refId !== "m-d");
    expect(codes(baseInput({ events: noDinner, dinnerSelected: true }))).toContain(
      "missing_required_meal",
    );
    // A deterministic no-slot result explains the missing dinner.
    expect(
      codes(
        baseInput({
          events: noDinner,
          dinnerSelected: false,
          dinnerExcludedReason: "Not included - return flight too early.",
        }),
      ),
    ).not.toContain("missing_required_meal");
  });

  it("blocks excessive walking above the pace cap", () => {
    expect(codes(baseInput({ walkingKm: 4.5 }))).toContain("excessive_walking");
    expect(codes(baseInput({ walkingKm: 4 }))).not.toContain("excessive_walking");
  });

  it("accepts a day whose breakfast and activities are self-arranged", () => {
    const selfArranged = validDay().filter(
      (entry) => entry.refId !== "m-b" && entry.kind !== "activity",
    );
    // Without the explicit state the missing breakfast is still an error, while
    // the missing visits are fine by default (visits are opt-in since
    // 2026-10-14): only the breakfast blocks.
    const asErrors = codes(baseInput({ events: selfArranged }));
    expect(asErrors).toContain("missing_required_meal");
    expect(asErrors).not.toContain("insufficient_sightseeing");

    const result = validateItinerary(
      baseInput({
        events: selfArranged,
        source: {
          ...baseInput().source,
          selfArrangedMeals: ["breakfast"],
          selfArrangedActivities: true,
        },
      }),
    );
    const errorCodes = result.errors.map((error) => error.code);
    expect(errorCodes).not.toContain("missing_required_meal");
    expect(errorCodes).not.toContain("insufficient_sightseeing");
    // The numeric minimum does not apply to visits the traveler arranges.
    expect(errorCodes).not.toContain("unmet_minimum_activity_count");
    expect(result.status).toBe("valid");
  });

  it("only requires a self-arranged meal when it is not marked", () => {
    const noLunch = validDay().filter((entry) => entry.refId !== "m-l");
    expect(codes(baseInput({ events: noLunch }))).toContain("missing_required_meal");
    const result = validateItinerary(
      baseInput({
        events: noLunch,
        source: { ...baseInput().source, selfArrangedMeals: ["lunch"] },
      }),
    );
    expect(result.errors.map((error) => error.code)).not.toContain("missing_required_meal");
  });

  it("drops the preferred-activity warning when the traveler arranges the activities", () => {
    const result = validateItinerary(
      baseInput({
        events: validDay().filter((entry) => entry.kind !== "activity"),
        preferredActivities: [{ id: "a-1", name: "Museum" }],
        source: { ...baseInput().source, selfArrangedActivities: true },
      }),
    );
    expect(result.warnings.some((entry) => entry.code === "preferred_activity_missing")).toBe(
      false,
    );
    expect(result.status).toBe("valid");
  });

  it("blocks a visit-time preference conflict and keeps the numeric requirement", () => {
    const dense = [
      ...validDay().filter((entry) => entry.kind !== "airport_buffer"),
      ...Array.from({ length: 4 }, (_, index) =>
        event({
          kind: "activity",
          refId: `a-extra-${index}`,
          title: `Museum ${index}`,
          activityTags: ["museum"],
          startMinute: 9 * 60 + 30,
          durationMinutes: 60,
        }),
      ),
    ];
    const result = validateItinerary(
      baseInput({
        events: dense,
        minimumActivityCounts: { museum: 6 },
      }),
    );
    const errorCodes = result.errors.map((error) => error.code);
    expect(errorCodes).toContain("unmet_minimum_activity_count");
    expect(result.errors.find((error) => error.code === "unmet_minimum_activity_count")?.message).toContain(
      "at least 6 were requested",
    );

    const tooLong = validDay().map((entry) =>
      entry.kind === "activity" ? { ...entry, durationMinutes: 200, endMinute: entry.startMinute + 200 } : entry,
    );
    expect(codes(baseInput({ events: tooLong }))).toContain("preference_conflict");
  });

  it("blocks a budget overrun without changing prices", () => {
    const result = validateItinerary(baseInput({ costs: costs(60_000), budgetMinor: 50_000 }));
    expect(result.status).toBe("invalid");
    expect(result.errors.map((error) => error.code)).toContain("budget_exceeded");
    expect(result.metrics.totalCostMinor).toBe(60_000);
    expect(result.metrics.remainingBudgetMinor).toBe(-10_000);
  });

  it("blocks a rejected proposal through the same taxonomy", () => {
    const result = validateItinerary(
      baseInput({ events: [], assemblyIssues: [issue("invalid_proposal")] }),
    );
    expect(result.status).toBe("invalid");
    expect(result.errors.map((error) => error.code)).toContain("invalid_proposal");
  });

  it("emits pace guideline and review suggestions as visible warnings", () => {
    const single = [
      event({ kind: "meal", refId: "m-b", title: "Breakfast", startMinute: 8 * 60, durationMinutes: 60 }),
      event({ kind: "activity", refId: "a-1", title: "Museum", activityTags: ["museum"], startMinute: 9 * 60, durationMinutes: 90 }),
      event({ kind: "break", title: "Break", startMinute: 10 * 60 + 30, durationMinutes: 20 }),
      event({ kind: "meal", refId: "m-l", title: "Lunch", startMinute: 12 * 60, durationMinutes: 90 }),
      event({ kind: "meal", refId: "m-d", title: "Dinner", startMinute: 18 * 60, durationMinutes: 60 }),
    ];
    const review: ItineraryReview = {
      verdict: "revise",
      issues: [
        { code: "pace_mismatch", eventIds: [], explanation: "Consider fewer optional visits." },
      ],
      suggestedOrder: [],
      explanation: "Stylistic",
      suggestionsAsWarnings: true,
    };
    const result = validateItinerary(
      baseInput({ events: single, minimumActivityCounts: {}, review }),
    );
    expect(result.status).toBe("valid");
    const warningCodes = result.warnings.map((warning) => warning.code);
    expect(warningCodes).toContain("pace_guideline_deviation");
    expect(warningCodes).toContain("review_suggestion");
  });

  it("warns when a preferred activity could not be included", () => {
    const result = validateItinerary(
      baseInput({
        preferredActivities: [{ id: "a-missing", name: "Borghese Gallery" }],
      }),
    );
    expect(result.status).toBe("valid");
    const warning = result.warnings.find((entry) => entry.code === "preferred_activity_missing");
    expect(warning?.message).toContain("Borghese Gallery");
    // An included preferred activity produces no warning.
    const included = validateItinerary(
      baseInput({ preferredActivities: [{ id: "a-1", name: "Museum" }] }),
    );
    expect(included.warnings.some((entry) => entry.code === "preferred_activity_missing")).toBe(
      false,
    );
  });

  it("warns when no long break block fits the paced day", () => {
    const withoutLongBreak = validDay().filter((entry) => entry.durationMinutes !== 60 || entry.kind !== "break");
    const result = validateItinerary(baseInput({ events: withoutLongBreak }));
    expect(result.status).toBe("valid");
    expect(
      result.warnings.some(
        (entry) =>
          entry.code === "pace_guideline_deviation" && entry.message.includes("long break"),
      ),
    ).toBe(true);
    // The complete relaxed day has its 60-minute block, so no such warning.
    const complete = validateItinerary(baseInput());
    expect(
      complete.warnings.some(
        (entry) =>
          entry.code === "pace_guideline_deviation" && entry.message.includes("long break"),
      ),
    ).toBe(false);
  });

  it("keeps fingerprints stable per input and sensitive to changes", () => {
    const first = validateItinerary(baseInput());
    const second = validateItinerary(baseInput());
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.sourceFingerprint).toBe(second.sourceFingerprint);
    const changed = validateItinerary(
      baseInput({
        pace: "moderate",
        source: { ...baseInput().source, pace: "moderate" },
      }),
    );
    expect(changed.sourceFingerprint).not.toBe(first.sourceFingerprint);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
    const source = baseInput().source;
    expect(computeItineraryFingerprint(source, validDay())).toBe(first.fingerprint);
    expect(computeItinerarySourceFingerprint(source)).toBe(first.sourceFingerprint);
  });

  it("marks every issue as simulated when the injected overlay was active", () => {
    const result = validateItinerary(
      baseInput({ simulatedFailure: true, assemblyIssues: [issue("overlap")] }),
    );
    expect(result.errors[0]?.simulatedFailure).toBe(true);
  });
});
