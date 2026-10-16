import { describe, expect, it } from "vitest";
import {
  assembleItinerary,
  proposedStopWindow,
  type AssembleItineraryInput,
  type ItineraryRouteLeg,
} from "../../../packages/domain/src/itinerary/assemble.js";

/** Deterministic routing stub: the assembly must not depend on the real provider. */
const ROUTING = {
  estimate(leg: ItineraryRouteLeg) {
    if (leg.mode === "walking") {
      return { distanceKm: 0.8, estimatedMinutes: 10, partyTotalMinor: 0, simulated: true as const };
    }
    if (leg.mode === "public_transport") {
      return { distanceKm: 3.2, estimatedMinutes: 15, partyTotalMinor: 600, simulated: true as const };
    }
    if (leg.mode === "airport_transfer") {
      return { distanceKm: 18, estimatedMinutes: 20, partyTotalMinor: 4000, simulated: true as const };
    }
    return { distanceKm: 5, estimatedMinutes: 12, partyTotalMinor: 1800, simulated: true as const };
  },
};

function input(overrides: Partial<AssembleItineraryInput> = {}): AssembleItineraryInput {
  return {
    proposal: {
      stops: [
        { kind: "meal", refId: "meal-breakfast", startMinute: 8 * 60, durationMinutes: 60 },
        { kind: "activity", refId: "act-museum", startMinute: 9 * 60 + 30, durationMinutes: 90 },
        { kind: "meal", refId: "meal-lunch", startMinute: 12 * 60 + 30, durationMinutes: 90 },
        { kind: "activity", refId: "act-park", startMinute: 14 * 60 + 30, durationMinutes: 60 },
        { kind: "meal", refId: "meal-dinner", startMinute: 18 * 60 + 30, durationMinutes: 120 },
      ],
    },
    seedScope: "op-1:1",
    sightseeingDate: "2026-07-10",
    zone: "Europe/Rome",
    adults: 2,
    pace: "relaxed",
    activities: [
      {
        id: "act-museum",
        name: "Capitoline Museums",
        tags: ["museum"],
        durationMinutes: 90,
        ticketMinorPerAdult: 600,
        anchor: { lat: 41.8931, lon: 12.4828 },
        reference: true,
        provenance: ["Reference landmark data"],
      },
      {
        id: "act-park",
        name: "Villa Borghese Gardens",
        tags: ["park"],
        durationMinutes: 60,
        ticketMinorPerAdult: 0,
        anchor: { lat: 41.9142, lon: 12.4922 },
        reference: true,
        provenance: ["Reference landmark data"],
      },
    ],
    meals: [
      {
        id: "meal-breakfast",
        name: "Caffe Roma",
        meal: "breakfast",
        level: "standard",
        durationMinutes: 60,
        partyTotalMinor: 1500,
        windowStartMinute: 7 * 60 + 30,
        windowEndMinute: 10 * 60 + 30,
        anchor: { lat: 41.8967, lon: 12.4822 },
        provenance: ["Caffe Roma (standard)"],
      },
      {
        id: "meal-lunch",
        name: "Trattoria Centro",
        meal: "lunch",
        level: "standard",
        durationMinutes: 90,
        partyTotalMinor: 2500,
        windowStartMinute: 12 * 60,
        windowEndMinute: 15 * 60,
        anchor: { lat: 41.8986, lon: 12.4769 },
        provenance: ["Trattoria Centro (standard)"],
      },
      {
        id: "meal-dinner",
        name: "Osteria Serena",
        meal: "dinner",
        level: "standard",
        durationMinutes: 120,
        partyTotalMinor: 4000,
        windowStartMinute: 18 * 60 + 30,
        windowEndMinute: 22 * 60 + 30,
        anchor: { lat: 41.8992, lon: 12.4716 },
        provenance: ["Osteria Serena (standard)"],
      },
    ],
    confirmedMealIds: ["meal-lunch"],
    flight: { offerId: "flight-1", partyTotalMinor: 20_000, label: "Flights flight-1" },
    hotel: {
      offerId: "hotel-1",
      name: "Hotel Centro",
      partyTotalMinor: 30_000,
      anchor: { lat: 41.9009, lon: 12.4792 },
    },
    destinationAirport: {
      id: "FCO",
      name: "Rome Fiumicino",
      anchor: { lat: 41.8003, lon: 12.2389 },
    },
    dinnerExcludedReason: null,
    selfArrangedMeals: [],
    selfArrangedActivities: false,
    returnDepartureInstant: "2026-07-10T21:00:00Z",
    routing: ROUTING,
    routingRuleVersion: "test",
    simulatedFailure: false,
    ...overrides,
  };
}

describe("itinerary assembly (Phase 10)", () => {
  it("resolves UTC instants, locks confirmed meals, and inserts transfers and breaks", () => {
    const result = assembleItinerary(input());
    expect(result.issues).toEqual([]);
    const byKind = (kind: string) => result.events.filter((event) => event.kind === kind);
    expect(byKind("meal")).toHaveLength(3);
    expect(byKind("activity")).toHaveLength(2);
    expect(byKind("transfer").length).toBeGreaterThan(0);
    expect(byKind("break").length).toBeGreaterThan(0);

    const lunch = result.events.find((event) => event.refId === "meal-lunch");
    expect(lunch?.locked).toBe(true);
    // A confirmed reservation is locked to its persisted window start.
    expect(lunch?.startLocal).toBe("12:00");
    // Europe/Rome is UTC+2 in July: 08:00 local = 06:00Z.
    const breakfast = result.events.find((event) => event.refId === "meal-breakfast");
    expect(breakfast?.startInstant).toBe("2026-07-10T06:00:00Z");
    expect(breakfast?.endInstant).toBe("2026-07-10T07:00:00Z");

    const buffer = result.events.find((event) => event.kind === "airport_buffer");
    expect(buffer?.locked).toBe(true);
    expect(buffer?.endMinute).toBe(23 * 60);
    expect(buffer?.endInstant).toBe("2026-07-10T21:00:00Z");
  });

  it("computes unique inclusion keys and never double-adds a selected and confirmed meal", () => {
    const result = assembleItinerary(input({ confirmedMealIds: ["meal-lunch", "meal-dinner"] }));
    const keys = result.costs.items.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("flight:flight-1");
    expect(keys).toContain("hotel:hotel-1");
    expect(keys).toContain("meal:meal-lunch");
    expect(keys.filter((key) => key === "meal:meal-lunch")).toHaveLength(1);
    expect(keys).toContain("activity:act-museum");
    expect(keys).toContain("airport_transfer:arrival");
    expect(keys).toContain("airport_transfer:departure");
    const total = result.costs.items.reduce((sum, item) => sum + item.amountMinor, 0);
    expect(result.costs.totalMinor).toBe(total);
    expect(total).toBeGreaterThan(20_000 + 30_000);
  });

  it("records an overlap conflict with both event ids when stops intersect", () => {
    const result = assembleItinerary(
      input({
        proposal: {
          stops: [
            { kind: "activity", refId: "act-museum", startMinute: 9 * 60, durationMinutes: 90 },
            { kind: "activity", refId: "act-park", startMinute: 9 * 60, durationMinutes: 60 },
          ],
        },
      }),
    );
    const overlap = result.issues.find((issue) => issue.code === "overlap");
    expect(overlap).toBeDefined();
    expect(overlap?.eventIds).toHaveLength(2);
    expect(overlap?.severity).toBe("error");
  });

  it("records a transfer gap instead of moving stops when the gap is too small", () => {
    const result = assembleItinerary(
      input({
        proposal: {
          stops: [
            { kind: "activity", refId: "act-museum", startMinute: 9 * 60, durationMinutes: 90 },
            { kind: "activity", refId: "act-park", startMinute: 10 * 60 + 35, durationMinutes: 60 },
          ],
        },
      }),
    );
    const gap = result.issues.find((issue) => issue.code === "transfer_gap");
    expect(gap).toBeDefined();
    const park = result.events.find((event) => event.refId === "act-park");
    expect(park?.startMinute).toBe(10 * 60 + 35);
  });

  it("flags an opening-hours mismatch without compressing the visit", () => {
    const result = assembleItinerary(
      input({
        proposal: {
          stops: [
            { kind: "activity", refId: "act-museum", startMinute: 20 * 60, durationMinutes: 90 },
          ],
        },
      }),
    );
    const mismatch = result.issues.find((issue) => issue.code === "opening_hours_mismatch");
    expect(mismatch).toBeDefined();
    const museum = result.events.find((event) => event.refId === "act-museum");
    expect(museum?.startMinute).toBe(20 * 60);
    expect(museum?.durationMinutes).toBe(90);
  });

  it("keeps the deterministic dinner exclusion in the breakdown", () => {
    const result = assembleItinerary(
      input({
        dinnerExcludedReason:
          "Not included - your return flight leaves at 20:00 local time, too early to finish dinner and reach the airport.",
        proposal: {
          stops: [
            { kind: "meal", refId: "meal-breakfast", startMinute: 8 * 60, durationMinutes: 60 },
            { kind: "meal", refId: "meal-lunch", startMinute: 12 * 60 + 30, durationMinutes: 90 },
          ],
        },
      }),
    );
    expect(result.dinnerExcluded).toBe(true);
    expect(result.costs.dinnerExcluded).toBe(true);
    expect(result.costs.dinnerExcludedReason).toContain("return flight leaves");
  });

  it("states self-arranged meals and activities in the excluded notes", () => {
    const result = assembleItinerary(
      input({
        selfArrangedMeals: ["dinner", "breakfast"],
        selfArrangedActivities: true,
      }),
    );
    expect(result.costs.excludedNotes).toContain(
      "Breakfast is self-arranged and not part of the plan.",
    );
    expect(result.costs.excludedNotes).toContain(
      "Dinner is self-arranged and not part of the plan.",
    );
    expect(result.costs.excludedNotes).toContain(
      "Activities are self-arranged and not part of the plan.",
    );
  });

  it("produces deterministic event ids per attempt scope", () => {
    const first = assembleItinerary(input());
    const second = assembleItinerary(input());
    expect(first.events.map((event) => event.id)).toEqual(second.events.map((event) => event.id));
    const otherScope = assembleItinerary(input({ seedScope: "op-1:2" }));
    expect(otherScope.events[0]?.id).not.toBe(first.events[0]?.id);
  });

  it("routes a back-to-back pair and reports the impossible transfer", () => {
    const result = assembleItinerary(
      input({
        proposal: {
          stops: [
            { kind: "activity", refId: "act-museum", startMinute: 9 * 60, durationMinutes: 90 },
            // Starts exactly when the museum ends: zero available time.
            { kind: "activity", refId: "act-park", startMinute: 10 * 60 + 30, durationMinutes: 60 },
          ],
        },
      }),
    );
    const gap = result.issues.find((issue) => issue.code === "transfer_gap");
    expect(gap).toBeDefined();
    expect(gap?.message).toContain("only 0 are left");
    // Neither a transfer nor any route cost is fabricated for an impossible leg.
    expect(result.events.some((event) => event.kind === "transfer")).toBe(false);
    expect(result.costs.items.some((item) => item.key.startsWith("transfer:"))).toBe(false);
  });

  it("reports an overlap for a planner-provided break inside a visit", () => {
    const result = assembleItinerary(
      input({
        proposal: {
          stops: [
            { kind: "activity", refId: "act-museum", startMinute: 9 * 60, durationMinutes: 90 },
            { kind: "break", startMinute: 9 * 60 + 30, durationMinutes: 20 },
          ],
        },
      }),
    );
    const overlap = result.issues.find((issue) => issue.code === "overlap");
    expect(overlap).toBeDefined();
    expect(overlap?.eventIds).toHaveLength(2);
  });

  it("never inserts a rhythm break or transfer on top of a planned break", () => {
    const result = assembleItinerary(
      input({
        proposal: {
          stops: [
            { kind: "activity", refId: "act-museum", startMinute: 9 * 60, durationMinutes: 90 },
            { kind: "break", startMinute: 10 * 60 + 35, durationMinutes: 20 },
            { kind: "activity", refId: "act-park", startMinute: 11 * 60 + 40, durationMinutes: 60 },
          ],
        },
      }),
    );
    expect(result.issues).toEqual([]);
    const breaks = result.events.filter((event) => event.kind === "break");
    expect(breaks).toHaveLength(1);
    expect(breaks[0]?.startMinute).toBe(10 * 60 + 35);
    // The transfer is placed after the planned break, never overlapping it.
    const transfers = result.events.filter((event) => event.kind === "transfer");
    expect(transfers).toHaveLength(1);
    expect(transfers[0]?.startMinute).toBe(10 * 60 + 55);
    expect(new Set(result.events.map((event) => event.id)).size).toBe(result.events.length);
  });

  it("accounts for the airport transfer plus the full departure buffer", () => {
    // Departure 22:40 local: the old 120-minute-only rule would pass (content
    // ends 20:30 <= 20:40) but the 20-minute airport transfer does not.
    const result = assembleItinerary(input({ returnDepartureInstant: "2026-07-10T20:40:00Z" }));
    const bufferIssue = result.issues.find((issue) => issue.code === "airport_buffer");
    expect(bufferIssue).toBeDefined();
    expect(bufferIssue?.message).toContain("airport transfer (~20 min)");
    expect(result.events.some((event) => event.kind === "airport_buffer")).toBe(false);
  });

  it("labels the airport buffer with the simulated transfer", () => {
    const result = assembleItinerary(input());
    const buffer = result.events.find((event) => event.kind === "airport_buffer");
    expect(buffer?.provenance.join(" ")).toContain("Airport transfer ~20 min");
  });

  it("trims a trailing planner free-time block to the departure deadline", () => {
    // Free time 18:30-21:00 runs past the 20:40 buffer start (departure 23:00
    // local - 120-minute buffer - 20-minute transfer); filler is trimmed, never
    // reported as an airport_buffer conflict.
    const result = assembleItinerary(
      input({
        proposal: {
          stops: [
            { kind: "meal", refId: "meal-lunch", startMinute: 12 * 60, durationMinutes: 90 },
            { kind: "free_time", startMinute: 18 * 60 + 30, durationMinutes: 150 },
          ],
        },
      }),
    );
    expect(result.issues).toEqual([]);
    const freeTime = result.events.find((event) => event.kind === "free_time");
    expect(freeTime?.endMinute).toBe(20 * 60 + 40);
    // The derived display fields match the trimmed end, not the planner's original.
    expect(freeTime?.endLocal).toBe("20:40");
    const buffer = result.events.find((event) => event.kind === "airport_buffer");
    expect(buffer?.startMinute).toBe(20 * 60 + 40);
  });

  it("starts the buffer after a trailing planner break instead of overlapping it", () => {
    const result = assembleItinerary(
      input({
        proposal: {
          stops: [
            { kind: "activity", refId: "act-museum", startMinute: 9 * 60, durationMinutes: 90 },
            { kind: "break", startMinute: 15 * 60, durationMinutes: 60 },
          ],
        },
      }),
    );
    expect(result.issues).toEqual([]);
    const buffer = result.events.find((event) => event.kind === "airport_buffer");
    expect(buffer?.startMinute).toBe(16 * 60);
  });

  it("drops a trailing planner filler block that starts inside the buffer window", () => {
    const result = assembleItinerary(
      input({
        proposal: {
          stops: [
            { kind: "meal", refId: "meal-lunch", startMinute: 12 * 60, durationMinutes: 90 },
            { kind: "free_time", startMinute: 20 * 60 + 50, durationMinutes: 60 },
          ],
        },
      }),
    );
    expect(result.issues).toEqual([]);
    expect(result.events.some((event) => event.kind === "free_time")).toBe(false);
    const buffer = result.events.find((event) => event.kind === "airport_buffer");
    expect(buffer).toBeDefined();
  });

  it("still reports a located visit that runs into the departure buffer", () => {
    const result = assembleItinerary(
      input({
        proposal: {
          stops: [{ kind: "activity", refId: "act-park", startMinute: 21 * 60, durationMinutes: 60 }],
        },
      }),
    );
    const bufferIssue = result.issues.find((issue) => issue.code === "airport_buffer");
    expect(bufferIssue).toBeDefined();
    expect(result.events.some((event) => event.kind === "airport_buffer")).toBe(false);
  });

  it("labels injected corruption on every recorded issue", () => {
    const result = assembleItinerary(
      input({
        simulatedFailure: true,
        proposal: {
          stops: [
            { kind: "activity", refId: "act-museum", startMinute: 9 * 60, durationMinutes: 90 },
            { kind: "activity", refId: "act-park", startMinute: 9 * 60, durationMinutes: 60 },
          ],
        },
      }),
    );
    expect(result.issues.length).toBeGreaterThan(0);
    for (const issue of result.issues) {
      expect(issue.simulatedFailure).toBe(true);
    }
  });
});

describe("proposedStopWindow (assembly/normalization geometry contract)", () => {
  const fixture = input();
  const window = (
    stop: { kind: string; refId: string | null; startMinute: number; durationMinutes: number },
    options: { confirmed?: readonly string[]; pace?: "relaxed" } = {},
  ) =>
    proposedStopWindow({
      stop: stop as never,
      meals: fixture.meals,
      activities: fixture.activities,
      confirmedMealIds: options.confirmed ?? [],
      pace: options.pace ?? "relaxed",
    });

  it("pins a confirmed meal to the offer's window start and fixed duration", () => {
    // The planner proposes 13:00 for 30 minutes; the reservation runs 12:00 + 90.
    const measured = window(
      { kind: "meal", refId: "meal-lunch", startMinute: 13 * 60, durationMinutes: 30 },
      { confirmed: ["meal-lunch"] },
    );
    expect(measured.startMinute).toBe(12 * 60);
    expect(measured.durationMinutes).toBe(90);
    expect(measured.earliestStartMinute).toBe(12 * 60);
    expect(measured.latestStartMinute).toBe(12 * 60);
  });

  it("uses the pace duration and clamps an unbooked meal into its window", () => {
    const measured = window({ kind: "meal", refId: "meal-dinner", startMinute: 10 * 60, durationMinutes: 45 });
    // Relaxed dinner is 120 minutes: 10:00 clamps to the 18:30 window start.
    expect(measured.durationMinutes).toBe(120);
    expect(measured.startMinute).toBe(18 * 60 + 30);
    expect(measured.earliestStartMinute).toBe(18 * 60 + 30);
    expect(measured.latestStartMinute).toBe(20 * 60 + 30);
  });

  it("uses the candidate's fixed duration for an activity, never the proposal", () => {
    const measured = window({ kind: "activity", refId: "act-museum", startMinute: 9 * 60, durationMinutes: 45 });
    expect(measured.durationMinutes).toBe(90);
    expect(measured.startMinute).toBe(9 * 60);
    expect(measured.anchor).not.toBeNull();
  });

  it("caps a filler block at 180 minutes and reports no window", () => {
    const measured = window({ kind: "free_time", refId: null, startMinute: 9 * 60, durationMinutes: 300 });
    expect(measured.durationMinutes).toBe(180);
    expect(measured.anchor).toBeNull();
    expect(measured.latestStartMinute).toBeNull();
  });
});

describe("activity opening-window clamping (2026-10-14)", () => {
  it("clamps a proposed visit up to its simulated opening window", () => {
    // The live planner starts the museum right after breakfast although it opens
    // at 09:00; the resolver clamps it instead of failing opening_hours_mismatch.
    const measured = proposedStopWindow({
      stop: { kind: "activity", refId: "act-museum", startMinute: 8 * 60 + 30, durationMinutes: 90 } as never,
      meals: input().meals,
      activities: input().activities,
      confirmedMealIds: [],
      pace: "relaxed",
    });
    expect(measured.startMinute).toBe(9 * 60);
    expect(measured.earliestStartMinute).toBe(9 * 60);
    expect(measured.durationMinutes).toBe(90);
  });

  it("assembles an early museum at its opening minute without issues", () => {
    const result = assembleItinerary(
      input({
        proposal: {
          stops: [
            { kind: "activity", refId: "act-museum", startMinute: 8 * 60 + 30, durationMinutes: 90 },
            { kind: "meal", refId: "meal-lunch", startMinute: 12 * 60, durationMinutes: 90 },
          ],
        },
      }),
    );
    expect(result.issues).toEqual([]);
    const museum = result.events.find((event) => event.refId === "act-museum");
    expect(museum?.startMinute).toBe(9 * 60);
  });
});
