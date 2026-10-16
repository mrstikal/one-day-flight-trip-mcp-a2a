import { describe, expect, it } from "vitest";
import { PACE_PROFILES } from "../../../packages/domain/src/itinerary/taxonomy.js";
import { fixturePlanner, fixtureReviewer } from "../../../packages/ai/src/fixture-adapter.js";
import {
  plannerContextSchema,
  type PlannerContext,
} from "../../../packages/ai/src/context/role-contexts.js";
import { tripPreferencesSchema } from "@odft/contracts";

/** 08-frontend-ux.md section 7 pace semantics must survive both implementations. */

function context(pace: "relaxed" | "moderate" | "intensive"): PlannerContext {
  const meals = PACE_PROFILES[pace].mealMinutes;
  return plannerContextSchema.parse({
    role: "planner",
    sightseeingDate: "2026-07-10",
    destinationCityId: "rome",
    pace,
    interests: { culture: 3, relaxation: 2, entertainment: 1 },
    minimumActivityCounts: { museum: 1 },
    budgetMinor: null,
    fixedWindows: [
      { kind: "meal", refId: "m-b", startMinute: 8 * 60, endMinute: 10 * 60 },
      { kind: "meal", refId: "m-l", startMinute: 12 * 60, endMinute: 14 * 60 },
      { kind: "meal", refId: "m-d", startMinute: 19 * 60, endMinute: 22 * 60 },
      { kind: "airport", refId: "return_flight", startMinute: 23 * 60, endMinute: 23 * 60 },
    ],
    candidates: [
      {
        id: "m-b",
        kind: "meal",
        meal: "breakfast",
        tags: [],
        durationMinutes: meals.breakfast,
        openingStartMinute: 8 * 60,
        openingEndMinute: 10 * 60,
      },
      {
        id: "m-l",
        kind: "meal",
        meal: "lunch",
        tags: [],
        durationMinutes: meals.lunch,
        openingStartMinute: 12 * 60,
        openingEndMinute: 14 * 60,
      },
      {
        id: "m-d",
        kind: "meal",
        meal: "dinner",
        tags: [],
        durationMinutes: meals.dinner,
        openingStartMinute: 19 * 60,
        openingEndMinute: 22 * 60,
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `a-${String(index).padStart(2, "0")}`,
        kind: "activity" as const,
        tags: (index % 2 === 0 ? ["museum"] : ["park"]) as ("museum" | "park")[],
        durationMinutes: 60,
        openingStartMinute: 9 * 60,
        openingEndMinute: 21 * 60,
      })),
    ],
    validationFeedback: [],
  });
}

function plannerTotals(stops: { kind: string; durationMinutes: number }[]): {
  activityCount: number;
  visitMinutes: number;
} {
  const activities = stops.filter((stop) => stop.kind === "activity");
  return {
    activityCount: activities.length,
    visitMinutes: activities.reduce((sum, stop) => sum + stop.durationMinutes, 0),
  };
}

describe("pace profiles (08-frontend-ux.md section 7)", () => {
  it("matches the documented targets, caps, breaks, and buffers", () => {
    expect(PACE_PROFILES.relaxed).toMatchObject({
      targetMin: 2,
      targetMax: 3,
      visitCapMinutes: 240,
      rhythmBreakMinutes: 20,
      walkCapKm: 4,
      legWalkCapKm: 1,
      bufferMinutes: 20,
    });
    expect(PACE_PROFILES.moderate).toMatchObject({
      targetMin: 3,
      targetMax: 5,
      visitCapMinutes: 360,
      rhythmBreakMinutes: 12,
      walkCapKm: 7,
      legWalkCapKm: 1.5,
      bufferMinutes: 15,
    });
    expect(PACE_PROFILES.intensive).toMatchObject({
      targetMin: 5,
      targetMax: 7,
      visitCapMinutes: 480,
      rhythmBreakMinutes: 8,
      walkCapKm: 10,
      legWalkCapKm: 2,
      bufferMinutes: 10,
    });
  });

  it("plans only requested visits: the pinned IDs plus the tag minimums", () => {
    for (const pace of ["relaxed", "moderate", "intensive"] as const) {
      // Visits are opt-in (2026-10-14): the default context asks for one museum
      // and pins nothing, so exactly that minimum is planned — never a filler.
      const bare = fixturePlanner(context(pace));
      const bareActivities = bare.stops.filter((stop) => stop.kind === "activity");
      expect(bareActivities).toHaveLength(1);
      expect(bareActivities[0]?.refId).toMatch(/^a-0[0-9]$/);
      expect(bare.stops.some((stop) => stop.kind === "meal")).toBe(true);

      // Pinning two parks adds exactly those two on top of the museum minimum.
      const pinned = context(pace);
      pinned.preferredActivityIds = ["a-01", "a-03"];
      const output = fixturePlanner(pinned);
      const totals = plannerTotals(output.stops);
      expect(totals.activityCount).toBe(3);
      expect(output.stops.filter((stop) => stop.kind === "activity").map((stop) => stop.refId)).toEqual(
        expect.arrayContaining(["a-01", "a-03"]),
      );
      expect(totals.visitMinutes).toBeLessThanOrEqual(PACE_PROFILES[pace].visitCapMinutes);
    }
  });

  it("grows the travel allowance on repeated transfer_gap feedback", () => {
    const feedback = [
      "transfer_gap: The simulated walking transfer after Colosseum needs about 28 minutes but only 37 are left.",
    ];
    const pinned = context("moderate");
    pinned.preferredActivityIds = ["a-00", "a-02"];
    const base = fixturePlanner(pinned);
    const adapted = fixturePlanner({ ...pinned, validationFeedback: feedback });
    const maxActivityGap = (
      stops: { kind: string; startMinute: number; durationMinutes: number }[],
    ): number => {
      let max = 0;
      for (let index = 0; index + 1 < stops.length; index += 1) {
        const current = stops[index];
        const next = stops[index + 1];
        if (current?.kind === "activity" && next?.kind === "activity") {
          max = Math.max(max, next.startMinute - (current.startMinute + current.durationMinutes));
        }
      }
      return max;
    };
    expect(maxActivityGap(adapted.stops)).toBeGreaterThan(maxActivityGap(base.stops));
  });

  it("keeps a requested minimum above the pace cap instead of silently dropping it", () => {
    const dense = context("relaxed");
    dense.minimumActivityCounts = { museum: 6 };
    dense.candidates = dense.candidates.map((candidate) =>
      candidate.kind === "activity" ? { ...candidate, tags: ["museum"] as const } : candidate,
    );
    const output = fixturePlanner(dense);
    const museums = output.stops.filter((stop) => stop.kind === "activity");
    // The request stays in the plan (six chosen candidates), but a relaxed day
    // cannot physically fit them: the planner reports the cap compromise and the
    // validator will flag the unmet minimum instead of the planner dropping it.
    expect(output.compromises.join(" ")).toContain("above the 240-minute relaxed-pace cap");
    expect(museums.length).toBeGreaterThanOrEqual(PACE_PROFILES.relaxed.targetMin);
    expect(museums.length).toBeLessThan(6);
  });

  it("keeps the context's preference-first order for pinned visits instead of sorting by id", () => {
    const preferred = context("relaxed");
    preferred.minimumActivityCounts = {};
    const activities = preferred.candidates.filter((candidate) => candidate.kind === "activity");
    // The worker puts explicitly preferred activities first; deliver them in
    // reverse and pin a-06 + a-00: the context order (a-06 before a-00) must win
    // over an id sort.
    const reordered = activities.slice().reverse();
    preferred.candidates = [
      ...preferred.candidates.filter((candidate) => candidate.kind !== "activity"),
      ...reordered,
    ];
    preferred.preferredActivityIds = ["a-00", "a-06"];
    const output = fixturePlanner(preferred);
    const firstActivity = output.stops.find((stop) => stop.kind === "activity");
    expect(firstActivity?.refId).toBe("a-06");
  });

  it("does not double-count walking in the fixture review travel total", () => {
    const base = {
      role: "reviewer" as const,
      preferredActivityIds: [],
      activitiesSelfArranged: false,
      selfArrangedMeals: [],
      events: [],
      preferences: tripPreferencesSchema.parse({
        travelVariant: "one_night",
        defaultServiceLevel: "standard",
        serviceOverrides: {},
        activityPace: "relaxed",
        interests: { culture: 3, relaxation: 2, entertainment: 1 },
        preferredActivityTags: [],
        minimumActivityCounts: {},
      }),
      requirements: [],
    };
    // 110 transfer minutes already include the 100 walking minutes.
    const included = fixtureReviewer({
      ...base,
      metrics: {
        totalTransferMinutes: 110,
        totalWalkingMinutes: 100,
        activityCount: 2,
        museumCount: 1,
      },
    });
    expect(included.verdict).toBe("acceptable");
    const excessive = fixtureReviewer({
      ...base,
      metrics: {
        totalTransferMinutes: 160,
        totalWalkingMinutes: 100,
        activityCount: 2,
        museumCount: 1,
      },
    });
    expect(excessive.verdict).toBe("revise");
    expect(excessive.issues.map((issue) => issue.code)).toContain("excess_travel");
  });

  it("reports unavailable candidates instead of inventing them", () => {
    const sparse = context("relaxed");
    sparse.minimumActivityCounts = { museum: 9 };
    const output = fixturePlanner(sparse);
    const museums = output.stops.filter(
      (stop) => stop.kind === "activity",
    );
    // Only five museum candidates exist in this context; the planner includes
    // all of them and reports the shortfall as a compromise.
    expect(museums.length).toBeLessThanOrEqual(5);
    expect(output.compromises.join(" ")).toContain("cannot be met from the supplied inventory");
  });
});