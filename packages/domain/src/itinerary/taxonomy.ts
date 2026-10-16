import type { ActivityPace, ActivityTag, ServiceLevel } from "@odft/contracts";

/**
 * Deterministic pace profiles, simulated opening windows, and the error/warning
 * taxonomy metadata (08-frontend-ux.md section 7, Phase 10 section 4).
 *
 * Pace is intensity, never category. Targets are guidelines; duration templates
 * and feasibility override raw counts. Every value here is authoritative for both
 * the assembly and the validator.
 */

export interface PaceProfile {
  /** Target major activities (guideline range). */
  readonly targetMin: number;
  readonly targetMax: number;
  /** Daily activity-visit time cap in minutes (sum of visit durations). */
  readonly visitCapMinutes: number;
  /** Rhythm break seated after each activity. */
  readonly rhythmBreakMinutes: number;
  /** One long break block; 0 = optional for this pace. */
  readonly longBreakMinutes: number;
  /** Meal duration defaults for unbooked slots. */
  readonly mealMinutes: Readonly<Record<"breakfast" | "lunch" | "dinner", number>>;
  /** Estimated walking caps. */
  readonly walkCapKm: number;
  readonly legWalkCapKm: number;
  /** Minimum inter-event transfer buffer added to the route estimate. */
  readonly bufferMinutes: number;
}

export const PACE_PROFILES: Readonly<Record<ActivityPace, PaceProfile>> = {
  relaxed: {
    targetMin: 2,
    targetMax: 3,
    visitCapMinutes: 240,
    rhythmBreakMinutes: 20,
    longBreakMinutes: 60,
    mealMinutes: { breakfast: 60, lunch: 90, dinner: 120 },
    walkCapKm: 4,
    legWalkCapKm: 1,
    bufferMinutes: 20,
  },
  moderate: {
    targetMin: 3,
    targetMax: 5,
    visitCapMinutes: 360,
    rhythmBreakMinutes: 12,
    longBreakMinutes: 40,
    mealMinutes: { breakfast: 45, lunch: 60, dinner: 90 },
    walkCapKm: 7,
    legWalkCapKm: 1.5,
    bufferMinutes: 15,
  },
  intensive: {
    targetMin: 5,
    targetMax: 7,
    visitCapMinutes: 480,
    rhythmBreakMinutes: 8,
    longBreakMinutes: 0,
    mealMinutes: { breakfast: 30, lunch: 45, dinner: 60 },
    walkCapKm: 10,
    legWalkCapKm: 2,
    bufferMinutes: 10,
  },
} as const;

export const DENSER_PACE: Readonly<Record<ActivityPace, ActivityPace | null>> = {
  relaxed: "moderate",
  moderate: "intensive",
  intensive: null,
};

/**
 * Meal duration for an UNBOOKED slot (08 section 7): the pace table is the
 * authoritative default ("60 / 90 / 120 min" relaxed etc.), luxury meals use the
 * same floor plus up to +15 minutes. Confirmed reservations keep the offer's
 * fixed duration and are never extended or moved to make pace fit.
 */
export function paceMealDuration(
  pace: ActivityPace,
  meal: "breakfast" | "lunch" | "dinner",
  level: ServiceLevel,
): number {
  const floor = PACE_PROFILES[pace].mealMinutes[meal];
  return level === "luxury" ? floor + 15 : floor;
}

/** Airport departure buffer before the return flight (Stage B rule). */
export const AIRPORT_BUFFER_MINUTES = 120;

/**
 * Minimum planned-content span (first to last meal/activity event) for a
 * complete sightseeing day. The Stage B core rule reserves destination-local
 * 09:00 through at least 18:00; a plan covering less than seven hours of meals
 * and visits is treated as an insufficient sightseeing day.
 */
export const MIN_CONTENT_SPAN_MINUTES = 420;

/** Physical demand by tag (planning assumption; simulated). */
const TAG_DEMAND: Readonly<Record<ActivityTag, "low" | "moderate" | "high">> = {
  museum: "moderate",
  landmark: "low",
  gallery: "low",
  architecture: "low",
  park: "low",
  garden: "low",
  waterfront: "low",
  viewpoint: "moderate",
  performance: "low",
};

export function physicalDemandForTags(tags: readonly ActivityTag[]): "low" | "moderate" | "high" {
  let demand: "low" | "moderate" | "high" = "low";
  for (const tag of tags) {
    const value = TAG_DEMAND[tag];
    if (value === "high") {
      return "high";
    }
    if (value === "moderate") {
      demand = "moderate";
    }
  }
  return demand;
}

/**
 * Simulated opening windows per activity tag (05-synthetic-data-design.md
 * section 9: opening windows are explicitly simulated planning assumptions).
 */
const TAG_OPENING: Readonly<Record<ActivityTag, { startMinute: number; endMinute: number }>> = {
  museum: { startMinute: 9 * 60, endMinute: 19 * 60 },
  gallery: { startMinute: 9 * 60, endMinute: 19 * 60 },
  landmark: { startMinute: 8 * 60, endMinute: 21 * 60 },
  architecture: { startMinute: 8 * 60, endMinute: 20 * 60 },
  park: { startMinute: 7 * 60, endMinute: 22 * 60 },
  garden: { startMinute: 8 * 60, endMinute: 21 * 60 },
  waterfront: { startMinute: 7 * 60, endMinute: 22 * 60 },
  viewpoint: { startMinute: 8 * 60, endMinute: 21 * 60 },
  performance: { startMinute: 17 * 60, endMinute: 23 * 60 },
};

export interface OpeningWindow {
  readonly startMinute: number;
  readonly endMinute: number;
}

/** Simulated opening window for an activity with the given tags. */
export function simulatedOpeningWindow(tags: readonly ActivityTag[]): OpeningWindow {
  let start = 0;
  let end = 24 * 60;
  for (const tag of tags) {
    const window = TAG_OPENING[tag];
    start = Math.max(start, window.startMinute);
    end = Math.min(end, window.endMinute);
  }
  return { startMinute: start, endMinute: end };
}
