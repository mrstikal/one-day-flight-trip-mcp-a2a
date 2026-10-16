import { describe, expect, it } from "vitest";
import { parseCustomSearchObjective } from "../../apps/web/src/lib/projection.js";

describe("parseCustomSearchObjective (no server calls)", () => {
  it("reads the objective recorded by an assistant search", () => {
    expect(
      parseCustomSearchObjective("Deterministic ranking (Phase 09, hotel; custom search: better_location)."),
    ).toBe("better_location");
    expect(
      parseCustomSearchObjective("Deterministic ranking (Phase 09, hotel; custom search: cheaper)."),
    ).toBe("cheaper");
    expect(
      parseCustomSearchObjective("Deterministic ranking (Phase 09, hotel; custom search: higher_rating)."),
    ).toBe("higher_rating");
  });

  it("treats plain rankings and unknown markers as not custom", () => {
    expect(parseCustomSearchObjective("Deterministic ranking (Phase 09, hotel).")).toBeNull();
    expect(parseCustomSearchObjective(null)).toBeNull();
    expect(
      parseCustomSearchObjective("Deterministic ranking (Phase 09, hotel; custom search: match_preferences)."),
    ).toBeNull();
  });
});