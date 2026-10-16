import type { ItineraryEvent, ItineraryMetrics } from "@odft/contracts";
import type { PaceProfile } from "./taxonomy.js";

/**
 * Deterministic itinerary metrics (04-domain-model.md section 8, Phase 10).
 * Metrics are computed only from resolved events — never from the raw proposal.
 */

export interface ItineraryMetricsInput {
  readonly events: readonly ItineraryEvent[];
  readonly totalCostMinor: number;
  readonly budgetMinor: number | null;
  /** Walking distance accumulated by the assembly (route estimates are simulated). */
  readonly walkingKm: number;
}

function minutesToLocal(minute: number): string {
  const bounded = Math.min(1439, Math.max(0, minute));
  const hours = Math.floor(bounded / 60);
  const minutes = bounded % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function computeItineraryMetrics(input: ItineraryMetricsInput): ItineraryMetrics {
  const activityTagCounts: Record<string, number> = {};
  let activityCount = 0;
  let visitMinutes = 0;
  let mealMinutes = 0;
  let breakMinutes = 0;
  let transferMinutes = 0;
  let walkingMinutes = 0;
  let museumCount = 0;
  let firstContentStart: number | null = null;
  let lastContentEnd: number | null = null;

  for (const event of input.events) {
    switch (event.kind) {
      case "activity": {
        activityCount += 1;
        visitMinutes += event.durationMinutes;
        break;
      }
      case "meal":
        mealMinutes += event.durationMinutes;
        break;
      case "break":
      case "free_time":
        breakMinutes += event.durationMinutes;
        break;
      case "transfer":
        transferMinutes += event.durationMinutes;
        if (event.provenance.some((label) => /walking/i.test(label))) {
          walkingMinutes += event.durationMinutes;
        }
        break;
      case "airport_buffer":
        break;
    }
    if (event.kind === "activity" || event.kind === "meal") {
      firstContentStart =
        firstContentStart === null ? event.startMinute : Math.min(firstContentStart, event.startMinute);
      lastContentEnd =
        lastContentEnd === null ? event.endMinute : Math.max(lastContentEnd, event.endMinute);
    }
  }

  for (const event of input.events) {
    if (event.kind !== "activity") {
      continue;
    }
    const tags = event.activityTags;
    for (const tag of tags) {
      activityTagCounts[tag] = (activityTagCounts[tag] ?? 0) + 1;
    }
    if (tags.includes("museum")) {
      museumCount += 1;
    }
  }

  const remaining =
    input.budgetMinor === null ? null : input.budgetMinor - input.totalCostMinor;

  return {
    activityCount,
    visitMinutes,
    mealMinutes,
    breakMinutes,
    transferMinutes,
    walkingMinutes,
    walkingKm: Math.round(input.walkingKm * 1000) / 1000,
    museumCount,
    activityTagCounts,
    firstContentStartLocal: firstContentStart === null ? null : minutesToLocal(firstContentStart),
    lastContentEndLocal: lastContentEnd === null ? null : minutesToLocal(lastContentEnd),
    totalCostMinor: input.totalCostMinor,
    budgetMinor: input.budgetMinor,
    remainingBudgetMinor: remaining,
  };
}

/**
 * Pace guideline warning: a visible explanation, never a blocker.
 */
export function paceGuidelineMessage(
  profile: PaceProfile,
  activityCount: number,
): string | null {
  if (activityCount === 0) {
    return null;
  }
  if (activityCount < profile.targetMin) {
    return `This ${activityCount}-activity day is below the pace guideline of ${profile.targetMin}-${profile.targetMax} major activities; the plan stays valid.`;
  }
  if (activityCount > profile.targetMax) {
    return `This ${activityCount}-activity day is above the pace guideline of ${profile.targetMin}-${profile.targetMax} major activities; the plan stays valid.`;
  }
  return null;
}
