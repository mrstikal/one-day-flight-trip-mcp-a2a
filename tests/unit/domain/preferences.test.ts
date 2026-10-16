import { describe, expect, it } from "vitest";
import { DEFAULT_TRIP_PREFERENCES, type TripPreferences } from "@odft/contracts";
import { hasOverride, resolveEffectiveLevel } from "@odft/domain";

/** T-UT-PREF-02: inherited vs explicit service level. */

function prefs(patch: Partial<TripPreferences> = {}): TripPreferences {
  return { ...DEFAULT_TRIP_PREFERENCES, ...patch };
}

describe("resolveEffectiveLevel", () => {
  it("inherits the global default when there is no override", () => {
    const p = prefs({ defaultServiceLevel: "luxury", serviceOverrides: {} });
    expect(resolveEffectiveLevel(p, "hotel")).toBe("luxury");
    expect(hasOverride(p, "hotel")).toBe(false);
  });

  it("treats an explicit standard override as an override", () => {
    const p = prefs({ defaultServiceLevel: "luxury", serviceOverrides: { hotel: "standard" } });
    expect(resolveEffectiveLevel(p, "hotel")).toBe("standard");
    expect(hasOverride(p, "hotel")).toBe(true);
  });

  it("clearing an override (removing the key) restores the inherited default", () => {
    const p = prefs({ defaultServiceLevel: "budget", serviceOverrides: {} });
    expect(resolveEffectiveLevel(p, "dinner")).toBe("budget");
  });

  it("a global change touches only services that inherit it", () => {
    const before = prefs({ defaultServiceLevel: "standard", serviceOverrides: { dinner: "luxury" } });
    const after = { ...before, defaultServiceLevel: "budget" as const };
    expect(resolveEffectiveLevel(after, "hotel")).toBe("budget"); // inherited changed
    expect(resolveEffectiveLevel(after, "dinner")).toBe("luxury"); // override unchanged
  });

  it("keeps each meal independent", () => {
    const p = prefs({ serviceOverrides: { breakfast: "luxury", lunch: "budget" } });
    expect(resolveEffectiveLevel(p, "breakfast")).toBe("luxury");
    expect(resolveEffectiveLevel(p, "lunch")).toBe("budget");
    expect(resolveEffectiveLevel(p, "dinner")).toBe("standard");
  });
});
