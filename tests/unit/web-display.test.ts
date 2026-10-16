import { describe, expect, it } from "vitest";
import { CONFIRMATION_DISCLAIMER, DEMO_DISCLAIMER } from "../../apps/web/src/lib/disclaimers.js";
import { formatDuration, formatLocalDate, formatStops, formatTime } from "../../apps/web/src/lib/format/datetime.js";
import { formatEuroMinor } from "../../apps/web/src/lib/format/money.js";
import { routeReasonText, scheduleReasonText } from "../../apps/web/src/lib/reasons.js";

describe("permanent disclaimers (T-UT-PRD-01)", () => {
  it("keeps the exact demo disclaimer text", () => {
    expect(DEMO_DISCLAIMER).toBe(
      "DEMO APPLICATION - No real reservations are made and no payments are processed.",
    );
  });

  it("keeps the exact confirmation disclaimer text", () => {
    expect(CONFIRMATION_DISCLAIMER).toBe(
      "Simulated booking - not valid for travel, accommodation, or restaurant admission.",
    );
  });
});

describe("display formatting", () => {
  it("formats EUR minor units as a currency amount", () => {
    expect(formatEuroMinor(123456)).toContain("1,234.56");
    expect(formatEuroMinor(0)).toContain("0.00");
  });

  it("formats durations and stops", () => {
    expect(formatDuration(185)).toBe("3h 05m");
    expect(formatDuration(120)).toBe("2h");
    expect(formatDuration(45)).toBe("45m");
    expect(formatStops(0)).toBe("Direct");
    expect(formatStops(1)).toBe("1 stop");
    expect(formatStops(2)).toBe("2 stops");
  });

  it("formats an instant in the destination zone", () => {
    // 09:00 UTC in Europe/Rome (CET, +1 in winter) is 10:00.
    expect(formatTime("2026-12-01T09:00:00.000Z", "Europe/Rome")).toBe("10:00");
    expect(formatTime("2026-12-01T09:00:00.000Z", "UTC")).toBe("09:00");
  });

  it("formats a local date without shifting the day", () => {
    expect(formatLocalDate("2026-12-01")).toContain("1 December 2026");
  });

  it("maps reason codes to human copy", () => {
    expect(routeReasonText("GROUND_TRAVEL_PREFERRED")).toContain("Ground travel");
    expect(scheduleReasonText("INSUFFICIENT_SIGHTSEEING")).toContain("sightseeing");
  });
});
