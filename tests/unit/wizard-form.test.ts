import { describe, expect, it } from "vitest";
import {
  buildPreferences,
  parseWizardDraft,
  serializeWizardDraft,
  validateWelcomeDraft,
  type WizardDraft,
} from "../../apps/web/src/lib/wizard-form.js";

describe("wizard form helpers (no server calls)", () => {
  it("requires a name, origin, and date before advancing", () => {
    expect(validateWelcomeDraft({ userName: "", originAirportId: "", sightseeingDate: "" })).toEqual({
      userName: "Enter your name.",
      origin: "Choose an origin airport.",
      sightseeingDate: "Choose a sightseeing date.",
    });
  });

  it("accepts a complete welcome draft", () => {
    expect(
      validateWelcomeDraft({
        userName: "Ada",
        originAirportId: "ourairports:4408",
        sightseeingDate: "2026-12-01",
      }),
    ).toEqual({});
  });

  it("rejects a malformed date", () => {
    const errors = validateWelcomeDraft({
      userName: "Ada",
      originAirportId: "ourairports:4408",
      sightseeingDate: "01/12/2026",
    });
    expect(errors.sightseeingDate).toBeDefined();
  });

  it("builds provisional preferences and converts the budget to minor units", () => {
    const preferences = buildPreferences({
      travelVariant: "one_night",
      defaultServiceLevel: "luxury",
      activityPace: "intensive",
      maxBudgetEur: "1200",
    });
    expect(preferences.travelVariant).toBe("one_night");
    expect(preferences.defaultServiceLevel).toBe("luxury");
    expect(preferences.activityPace).toBe("intensive");
    expect(preferences.maxBudgetMinor).toBe(120000);
  });

  it("omits the budget when it is empty or invalid", () => {
    const preferences = buildPreferences({
      travelVariant: "two_nights",
      defaultServiceLevel: "standard",
      activityPace: "moderate",
      maxBudgetEur: "",
    });
    expect(preferences.maxBudgetMinor).toBeUndefined();
  });
});

function createdTripDraft(): WizardDraft {
  return {
    userName: "Ada",
    adults: 2,
    originAirportId: "ourairports:4408",
    originLabel: "PRG — Václav Havel Airport Prague",
    sightseeingDate: "2026-12-01",
    travelVariant: "one_night",
    defaultServiceLevel: "standard",
    activityPace: "moderate",
    maxBudgetEur: "1200",
    countryKey: "IT",
    countryName: "Italy",
    destinationCityId: "geonames:3169070",
    destinationCityLabel: "Rome",
    creationRequestId: "66666666-7777-4888-8999-000000000000",
    tripId: "11111111-2222-4333-8444-555555555555",
  };
}

describe("wizard draft storage (no server calls)", () => {
  it("round-trips the created-trip record", () => {
    const draft = createdTripDraft();
    expect(parseWizardDraft(serializeWizardDraft(draft))).toEqual(draft);
  });

  it("returns null for missing, malformed, or incomplete records", () => {
    expect(parseWizardDraft(null)).toBeNull();
    expect(parseWizardDraft("not json")).toBeNull();
    expect(parseWizardDraft("{}")).toBeNull();
    // An in-progress draft (no trip yet) is never restored.
    expect(parseWizardDraft(JSON.stringify({ ...createdTripDraft(), tripId: "" }))).toBeNull();
    // A stale shape (unknown enum value) is rejected as a whole.
    expect(
      parseWizardDraft(JSON.stringify({ ...createdTripDraft(), travelVariant: "three_nights" })),
    ).toBeNull();
  });

  it("restores every displayed value of the record", () => {
    const restored = parseWizardDraft(serializeWizardDraft(createdTripDraft()));
    expect(restored).not.toBeNull();
    expect(restored?.tripId).toBe("11111111-2222-4333-8444-555555555555");
    expect(restored?.originLabel).toBe("PRG — Václav Havel Airport Prague");
    expect(restored?.countryName).toBe("Italy");
    expect(restored?.destinationCityLabel).toBe("Rome");
    expect(restored?.adults).toBe(2);
    expect(restored?.maxBudgetEur).toBe("1200");
  });
});
