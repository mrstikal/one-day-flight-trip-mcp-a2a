import { describe, expect, it } from "vitest";
import { parseClock } from "../../packages/persistence/src/scenario/trip-services.js";

/** P2 finding: generated windows carry a suffix like "22:00 (simulated)". */
describe("parseClock (Phase 07 dinner window)", () => {
  it("parses plain and decorated HH:MM values", () => {
    expect(parseClock("19:00")).toBe(19 * 60);
    expect(parseClock("22:00 (simulated)")).toBe(22 * 60);
    expect(parseClock("07:05")).toBe(7 * 60 + 5);
  });

  it("rejects values without a leading clock", () => {
    expect(parseClock("")).toBeNull();
    expect(parseClock("evening")).toBeNull();
    expect(parseClock("99:99")).toBeNull();
  });
});
