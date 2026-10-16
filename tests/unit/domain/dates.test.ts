import { describe, expect, it } from "vitest";
import {
  checkInDate,
  checkOutDate,
  isSightseeingDateInWindow,
  nightsForVariant,
  outboundArrivalDate,
  returnDepartureDate,
} from "@odft/domain";

/** T-UT-PREF-03 subset: variant date math and the sightseeing window. */

describe("trip date math", () => {
  const D = "2026-06-15";

  it("uses D-1 for check-in and arrival", () => {
    expect(checkInDate(D)).toBe("2026-06-14");
    expect(outboundArrivalDate(D)).toBe("2026-06-14");
  });

  it("checks out on D (one night) or D+1 (two nights)", () => {
    expect(nightsForVariant("one_night")).toBe(1);
    expect(nightsForVariant("two_nights")).toBe(2);
    expect(checkOutDate(D, "one_night")).toBe("2026-06-15");
    expect(checkOutDate(D, "two_nights")).toBe("2026-06-16");
  });

  it("returns late on D or D+1", () => {
    expect(returnDepartureDate(D, "one_night")).toBe("2026-06-15");
    expect(returnDepartureDate(D, "two_nights")).toBe("2026-06-16");
  });

  it("handles month and DST boundaries without server-local arithmetic", () => {
    expect(checkInDate("2026-03-01")).toBe("2026-02-28");
    // Europe DST starts 2026-03-29; calendar math is unaffected by clock changes.
    expect(checkInDate("2026-03-29")).toBe("2026-03-28");
    expect(checkOutDate("2026-12-31", "two_nights")).toBe("2027-01-01");
  });

  it("enforces the sightseeing window relative to an injected clock", () => {
    const today = "2026-06-01";
    expect(isSightseeingDateInWindow("2026-06-02", today)).toBe(false); // +1 day
    expect(isSightseeingDateInWindow("2026-06-03", today)).toBe(true); // +2 days
    expect(isSightseeingDateInWindow("2027-06-02", today)).toBe(false); // > 365
  });
});
