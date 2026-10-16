import type {
  ActivityPace,
  ActivityTag,
  ItineraryCosts,
  ItineraryEvent,
  ItineraryIssue,
  ItineraryReview,
  ItineraryValidation,
  Meal,
} from "@odft/contracts";
import { fingerprint } from "../fingerprints.js";
import { computeItineraryMetrics, paceGuidelineMessage } from "./metrics.js";
import {
  MIN_CONTENT_SPAN_MINUTES,
  PACE_PROFILES,
  type PaceProfile,
} from "./taxonomy.js";

/**
 * Deterministic itinerary validator (04-domain-model.md section 8, Phase 10
 * section 4). Errors block approval; warnings carry a visible explanation; the
 * result includes metrics and fingerprints. An invalid result is normal routing,
 * never an exception retry.
 */

export interface ItinerarySourceFingerprintInput {
  readonly snapshotId: string;
  readonly sightseeingDate: string;
  readonly travelVariant: string;
  readonly adults: number;
  readonly destinationCityId: string;
  readonly pace: ActivityPace;
  readonly minimumActivityCounts: Readonly<Partial<Record<ActivityTag, number>>>;
  /** Explicitly pinned activity IDs (2026-10-14): part of the plan's inputs. */
  readonly preferredActivityIds: readonly string[];
  readonly budgetMinor: number | null;
  readonly mealSelectionIds: {
    readonly breakfast: string | null;
    readonly lunch: string | null;
    readonly dinner: string | null;
  };
  readonly confirmedMealIds: readonly string[];
  /**
   * The planned flight/hotel offer: the confirmed reservation or, for a declined
   * booking ("I don't want to book"), the persisted selection. `*Booked` is part
   * of the fingerprint: confirming a late booking invalidates the approval.
   */
  readonly flightOfferId: string | null;
  readonly flightBooked: boolean;
  readonly hotelOfferId: string | null;
  readonly hotelBooked: boolean;
  /** Meals the traveler arranges themselves: never required in the plan. */
  readonly selfArrangedMeals: readonly Meal[];
  /** Activities the traveler arranges themselves: no sightings required. */
  readonly selfArrangedActivities: boolean;
}

/** Inputs-only fingerprint re-verified at approval time. */
export function computeItinerarySourceFingerprint(input: ItinerarySourceFingerprintInput): string {
  return fingerprint({
    kind: "itinerary-source",
    // v2: the planned flight/hotel offers and their booked state are inputs.
    schemaVersion: 2,
    snapshotId: input.snapshotId,
    sightseeingDate: input.sightseeingDate,
    travelVariant: input.travelVariant,
    adults: input.adults,
    destinationCityId: input.destinationCityId,
    pace: input.pace,
    minimumActivityCounts: input.minimumActivityCounts,
    preferredActivityIds: [...input.preferredActivityIds].sort(),
    budgetMinor: input.budgetMinor,
    mealSelectionIds: input.mealSelectionIds,
    confirmedMealIds: [...input.confirmedMealIds].sort(),
    flightOfferId: input.flightOfferId,
    flightBooked: input.flightBooked,
    hotelOfferId: input.hotelOfferId,
    hotelBooked: input.hotelBooked,
    selfArrangedMeals: [...input.selfArrangedMeals].sort(),
    selfArrangedActivities: input.selfArrangedActivities,
  });
}

/** Full input+content fingerprint (evidence carried by the validation result). */
export function computeItineraryFingerprint(
  source: ItinerarySourceFingerprintInput,
  events: readonly ItineraryEvent[],
): string {
  return fingerprint({
    kind: "itinerary",
    schemaVersion: 1,
    source: computeItinerarySourceFingerprint(source),
    events: events.map((event) => ({
      kind: event.kind,
      refId: event.refId,
      startMinute: event.startMinute,
      endMinute: event.endMinute,
      durationMinutes: event.durationMinutes,
      costInclusionKey: event.costInclusionKey,
      locked: event.locked,
    })),
  });
}

export interface ValidateItineraryInput {
  readonly events: readonly ItineraryEvent[];
  readonly assemblyIssues: readonly ItineraryIssue[];
  readonly costs: ItineraryCosts;
  readonly walkingKm: number;
  readonly pace: ActivityPace;
  readonly minimumActivityCounts: Readonly<Partial<Record<ActivityTag, number>>>;
  /** Explicitly pinned activity IDs (2026-10-14): part of the plan's inputs. */
  readonly preferredActivityIds: readonly string[];
  readonly budgetMinor: number | null;
  /** Null when a dinner slot exists; the deterministic reason otherwise. */
  readonly dinnerExcludedReason: string | null;
  /** True when a dinner offer is selected/confirmed for the sightseeing day. */
  readonly dinnerSelected: boolean;
  readonly simulatedFailure: boolean;
  readonly source: ItinerarySourceFingerprintInput;
  /** Reviewer `revise` suggestions demoted to visible warnings at the bound. */
  readonly review?: ItineraryReview | null;
  /** Explicitly selected activities (program preferences) that must be honored. */
  readonly preferredActivities?: readonly { readonly id: string; readonly name: string }[];
}

const REQUIRED_MEALS = ["breakfast", "lunch"] as const;

export function validateItinerary(input: ValidateItineraryInput): ItineraryValidation {
  const profile: PaceProfile = PACE_PROFILES[input.pace];
  const errors: ItineraryIssue[] = [];
  const warnings: ItineraryIssue[] = [];
  const simulatedFailure = input.simulatedFailure;

  // Deterministic conflicts recorded during assembly are errors.
  for (const issue of input.assemblyIssues) {
    errors.push({ ...issue, simulatedFailure: issue.simulatedFailure || simulatedFailure });
  }

  const metrics = computeItineraryMetrics({
    events: input.events,
    totalCostMinor: input.costs.totalMinor,
    budgetMinor: input.budgetMinor,
    walkingKm: input.walkingKm,
  });

  // Missing required meals: breakfast and lunch always, except when the traveler
  // arranges that meal themselves; dinner only when a slot exists or when the
  // user selected one that the assembly could not place.
  const selfArrangedMeals = new Set(input.source.selfArrangedMeals);
  const mealEvents = input.events.filter((event) => event.kind === "meal");
  const placedMeals = new Set(
    mealEvents.map((event) => mealNameForEvent(event, input.source.mealSelectionIds)),
  );
  for (const meal of REQUIRED_MEALS) {
    if (selfArrangedMeals.has(meal)) {
      continue;
    }
    if (!placedMeals.has(meal)) {
      errors.push({
        severity: "error",
        code: "missing_required_meal",
        message: `The plan is missing the required ${meal}; the day was not approved with an incomplete meal program.`,
        eventIds: [],
        simulatedFailure,
      });
    }
  }
  if (!selfArrangedMeals.has("dinner") && !placedMeals.has("dinner")) {
    if (input.dinnerSelected || input.dinnerExcludedReason === null) {
      errors.push({
        severity: "error",
        code: "missing_required_meal",
        message:
          "The selected dinner is missing from the plan and no deterministic no-slot result explains it.",
        eventIds: [],
        simulatedFailure,
      });
    }
  }

  if (metrics.activityCount > 0 && metrics.breakMinutes === 0) {
    errors.push({
      severity: "error",
      code: "missing_break",
      message: "The day has activities but no break block; nothing was compressed to make room.",
      eventIds: input.events.filter((event) => event.kind === "activity").map((event) => event.id).slice(0, 8),
      simulatedFailure,
    });
  }

  // Visits are OPT-IN (2026-10-14): the planner plans only pinned activities and
  // whatever is needed to satisfy a stored requirement, so a plan with NO visits
  // is the legitimate default — never an error. A short meal/visit span is only a
  // guideline warning (free time covers the rest of the day); the traveler who
  // arranges the activities themselves has no planned sightings at all.
  if (!input.source.selfArrangedActivities && metrics.activityCount > 0) {
    const contentStart = input.events
      .filter((event) => event.kind === "activity" || event.kind === "meal")
      .reduce<number | null>(
        (min, event) => (min === null ? event.startMinute : Math.min(min, event.startMinute)),
        null,
      );
    const contentEnd = input.events
      .filter((event) => event.kind === "activity" || event.kind === "meal")
      .reduce<number | null>(
        (max, event) => (max === null ? event.endMinute : Math.max(max, event.endMinute)),
        null,
      );
    if (contentStart !== null && contentEnd !== null) {
      const span = contentEnd - contentStart;
      if (span < MIN_CONTENT_SPAN_MINUTES) {
        warnings.push({
          severity: "warning",
          code: "insufficient_sightseeing",
          message: `Meals and visits span only ${Math.floor(span / 60)}h${String(span % 60).padStart(2, "0")}, below the seven-hour sightseeing day target; free time covers the rest of the day.`,
          eventIds: [],
          simulatedFailure,
        });
      }
    }
  }

  if (metrics.walkingKm > profile.walkCapKm) {
    errors.push({
      severity: "error",
      code: "excessive_walking",
      message: `About ${metrics.walkingKm} km of walking exceeds the ${profile.walkCapKm} km ${input.pace}-pace cap (simulated estimates).`,
      eventIds: input.events.filter((event) => event.kind === "transfer").map((event) => event.id).slice(0, 8),
      simulatedFailure,
    });
  }

  if (metrics.visitMinutes > profile.visitCapMinutes) {
    errors.push({
      severity: "error",
      code: "preference_conflict",
      message: `The plan needs ${metrics.visitMinutes} minutes of visits, above the ${profile.visitCapMinutes}-minute ${input.pace}-pace cap; nothing was silently reduced.`,
      eventIds: input.events.filter((event) => event.kind === "activity").map((event) => event.id).slice(0, 8),
      simulatedFailure,
    });
  }

  if (input.budgetMinor !== null && metrics.totalCostMinor > input.budgetMinor) {
    errors.push({
      severity: "error",
      code: "budget_exceeded",
      message: `The party total is EUR ${formatEur(metrics.totalCostMinor)}, above the EUR ${formatEur(input.budgetMinor)} budget; no price was changed and nothing was downgraded automatically.`,
      eventIds: [],
      simulatedFailure,
    });
  }

  const minimumEntries = Object.entries(input.minimumActivityCounts) as [
    ActivityTag,
    number | undefined,
  ][];
  for (const [tag, minimum] of minimumEntries) {
    if (minimum === undefined || minimum === null || input.source.selfArrangedActivities) {
      continue;
    }
    const actual = metrics.activityTagCounts[tag] ?? 0;
    if (actual < minimum) {
      errors.push({
        severity: "error",
        code: "unmet_minimum_activity_count",
        message: `The plan includes ${actual} ${tag} visit${actual === 1 ? "" : "s"} but at least ${minimum} were requested; the requirement was not silently dropped.`,
        eventIds: input.events.filter((event) => event.kind === "activity").map((event) => event.id).slice(0, 8),
        simulatedFailure,
      });
    }
  }

  const paceMessage = paceGuidelineMessage(profile, metrics.activityCount);
  if (paceMessage) {
    warnings.push({
      severity: "warning",
      code: "pace_guideline_deviation",
      message: paceMessage,
      eventIds: [],
      simulatedFailure: false,
    });
  }

  // The pace table requires one long break block on paced days; when no window
  // fits, the day is still approvable but the omission is explained.
  if (profile.longBreakMinutes > 0 && metrics.activityCount > 0) {
    const hasLongBreak = input.events.some(
      (event) => event.kind === "break" && event.durationMinutes >= profile.longBreakMinutes,
    );
    if (!hasLongBreak) {
      warnings.push({
        severity: "warning",
        code: "pace_guideline_deviation",
        message: `No ${profile.longBreakMinutes}-minute long break block fits this ${input.pace} day; only shorter rhythm breaks are planned.`,
        eventIds: [],
        simulatedFailure: false,
      });
    }
  }

  // Explicitly selected activities are honored independently of candidate order;
  // one that did not fit is surfaced instead of silently dropped.
  for (const preferred of input.source.selfArrangedActivities ? [] : (input.preferredActivities ?? [])) {
    const included = input.events.some(
      (event) => event.kind === "activity" && event.refId === preferred.id,
    );
    if (!included) {
      warnings.push({
        severity: "warning",
        code: "preferred_activity_missing",
        message: `Your preferred activity "${preferred.name}" is not in this plan; it did not fit the pace and timing.`,
        eventIds: [],
        simulatedFailure: false,
      });
    }
  }

  if (input.review?.verdict === "revise" && input.review.suggestionsAsWarnings) {
    for (const issue of input.review.issues.slice(0, 8)) {
      warnings.push({
        severity: "warning",
        code: "review_suggestion",
        message: `Review suggestion (${issue.code}): ${issue.explanation}`,
        eventIds: issue.eventIds.slice(0, 8),
        simulatedFailure: false,
      });
    }
  }

  return {
    status: errors.length > 0 ? "invalid" : "valid",
    errors,
    warnings,
    metrics,
    fingerprint: computeItineraryFingerprint(input.source, input.events),
    sourceFingerprint: computeItinerarySourceFingerprint(input.source),
  };
}

function mealNameForEvent(
  event: ItineraryEvent,
  selections: { breakfast: string | null; lunch: string | null; dinner: string | null },
): "breakfast" | "lunch" | "dinner" | "unknown" {
  if (event.refId !== null) {
    for (const meal of ["breakfast", "lunch", "dinner"] as const) {
      if (selections[meal] === event.refId) {
        return meal;
      }
    }
  }
  const lower = event.title.toLowerCase();
  for (const meal of ["breakfast", "lunch", "dinner"] as const) {
    if (lower.includes(meal)) {
      return meal;
    }
  }
  return "unknown";
}

export function formatEur(minor: number): string {
  return (minor / 100).toFixed(2);
}
