import type { AIRole, BookableKey, ModelFacingCommand, ModelFacingIntentResult } from "@odft/contracts";
import type { IntentContext } from "./context/compact-context.js";
import type {
  LLMAdapter,
  StructuredRequest,
  StructuredResponse,
} from "./adapter.js";
import { AdapterError } from "./adapter.js";
import type {
  PlannerContext,
  RecommendationContext,
  ReviewerContext,
} from "./context/role-contexts.js";

/**
 * Deterministic, credentials-free fixture adapter
 * (06-ai-agent-design.md section 10).
 *
 * Fixture invocations never touch the network. Their counters are tracked
 * separately from real tokens/cost: `billableCalls` is always zero, and no
 * fixture answer is ever presented as a genuine model response.
 */

export interface FixtureCounters {
  calls: number;
  byRole: Record<AIRole, number>;
}

const WORD_COUNTS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
};

function parseCount(text: string): number | undefined {
  const digit = text.match(/\b([1-7])\b/);
  if (digit?.[1]) {
    return Number.parseInt(digit[1], 10);
  }
  for (const [word, value] of Object.entries(WORD_COUNTS)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) {
      return value;
    }
  }
  return undefined;
}

function museumCount(context: IntentContext): number {
  return context.currentActivityCounts.museum ?? 0;
}

/**
 * Deterministic scripted intent interpretation. Unknown input returns an
 * explicitly scripted limitation with the graphical controls still available.
 */
export function fixtureIntent(message: string, context: IntentContext): ModelFacingIntentResult {
  const text = message.toLowerCase();

  const wantsRelaxed = /(less exhausting|less tiring|relaxed|slow(er)? pace|calm(er)?)/.test(text);
  const wantsIntensive = /(more intensive|intensive|packed|busy day|pack more)/.test(text);
  const museumsRequest = /museum/.test(text);
  const explicitCount = museumsRequest ? parseCount(text) : undefined;
  const relativeCount = /(more|another|additional|extra)/.test(text);
  // A relative count ("two more museums") is resolved against the CURRENT count, so
  // the numeric request keeps its meaning instead of collapsing to the bare number.
  const requestedMuseums =
    museumsRequest && relativeCount
      ? museumCount(context) + (explicitCount ?? 1)
      : explicitCount;

  // Above the seven-activity cap the request cannot be honored: ask, never clamp
  // silently (the numeric meaning must survive).
  if (museumsRequest && requestedMuseums !== undefined && requestedMuseums > 7) {
    const current = museumCount(context);
    return {
      kind: "clarification",
      question: `At most 7 museums fit the day; you asked for ${requestedMuseums}. What should I do?`,
      requestedCommands: [
        { type: "set_activity_requirement", tag: "museum", minimumCount: 7 },
      ],
      preserve: [],
      options: [
        {
          id: "keep_current",
          label: `Keep the current ${current} museum${current === 1 ? "" : "s"}`,
          commands:
            current > 0
              ? [{ type: "set_activity_requirement", tag: "museum", minimumCount: current }]
              : [{ type: "set_activity_requirement", tag: "museum", minimumCount: null }],
        },
        {
          id: "maximum_seven",
          label: "Use the maximum of 7 museums",
          commands: [{ type: "set_activity_requirement", tag: "museum", minimumCount: 7 }],
        },
      ],
    };
  }

  // Contradictory pace + museum count: ask a bounded clarification (P10 owns the
  // deterministic pace/count feasibility; the intent role must not silently drop it).
  if (wantsRelaxed && museumsRequest && requestedMuseums !== undefined && requestedMuseums >= 5) {
    return {
      kind: "clarification",
      question: `A relaxed day cannot fit ${requestedMuseums} major museums. What should I do?`,
      requestedCommands: [
        { type: "set_activity_requirement", tag: "museum", minimumCount: requestedMuseums },
      ],
      preserve: [],
      options: [
        {
          id: "relaxed_two",
          label: "Keep the relaxed pace with 2 museums",
          commands: [
            { type: "set_activity_pace", pace: "relaxed" },
            { type: "set_activity_requirement", tag: "museum", minimumCount: 2 },
          ],
        },
        {
          id: "denser_museums",
          label: `Use a moderate pace for ${requestedMuseums} museums`,
          commands: [
            { type: "set_activity_pace", pace: "moderate" },
            { type: "set_activity_requirement", tag: "museum", minimumCount: requestedMuseums },
          ],
        },
      ],
    };
  }

  if (/(confirm|book it|book the|pay|purchase|reserve it)/.test(text)) {
    if (context.selectedServices.length === 1) {
      const selected = context.selectedServices[0];
      if (selected && selected.service !== "activities" && selected.service !== "events") {
        return {
          kind: "commands",
          commands: [{ type: "propose_selection", service: selected.service, offerId: selected.offerId }],
          preserve: [],
          interpretation: "Open the existing selection for review; nothing is confirmed yet.",
        };
      }
    }
    if (context.selectedServices.length > 1) {
      const bookable = context.selectedServices.filter(
        (
          service,
        ): service is (typeof context.selectedServices)[number] & { service: BookableKey } =>
          service.service !== "activities" && service.service !== "events",
      );
      if (bookable.length >= 2) {
        return {
          kind: "clarification",
          question: "Which demo service should I open for review?",
          requestedCommands: [],
          preserve: [],
          options: bookable.slice(0, 4).map((service, index) => ({
            id: `review_${index + 1}`,
            label: `Review the ${service.service}`,
            commands: [
              { type: "propose_selection" as const, service: service.service, offerId: service.offerId },
            ],
          })),
        };
      }
    }
    return {
      kind: "unsupported",
      explanation:
        "I can't confirm or book anything from chat. Choose a service, then use the review and confirmation controls.",
    };
  }

  if (/(cheaper|lower price|less expensive|save money)/.test(text) && /hotel/.test(text)) {
    return {
      kind: "commands",
      commands: [{ type: "find_alternatives", target: "hotel", objective: "cheaper" }],
      preserve: ["flights", "breakfast", "lunch", "dinner", "activities", "events"],
      interpretation:
        "Marked for a lower-priced hotel search in your selected category; nothing changes until you review an alternative.",
    };
  }

  if (/(luxury|luxurious)/.test(text) && /dinner/.test(text)) {
    return {
      kind: "commands",
      commands: [{ type: "set_service_override", service: "dinner", level: "luxury" }],
      preserve: ["flights", "hotel", "breakfast", "lunch", "activities"],
      interpretation: "Show luxury dinner alternatives without changing your existing reservation.",
    };
  }

  if (/budget/.test(text) && /breakfast/.test(text)) {
    return {
      kind: "commands",
      commands: [{ type: "set_service_override", service: "breakfast", level: "budget" }],
      preserve: ["flights", "hotel", "lunch", "dinner", "activities"],
      interpretation: "Set a Budget breakfast preference; other services keep their levels.",
    };
  }

  if (/better hotel|nicer hotel|improve the hotel|upgrade the hotel/.test(text)) {
    return {
      kind: "clarification",
      question: "What matters most for a better hotel: location, rating, or a luxury category?",
      requestedCommands: [],
      preserve: ["flights", "breakfast", "lunch", "dinner", "activities"],
      options: [
        {
          id: "better_location",
          label: "Better location",
          commands: [{ type: "find_alternatives", target: "hotel", objective: "better_location" }],
        },
        {
          id: "higher_rating",
          label: "Higher rating",
          commands: [{ type: "find_alternatives", target: "hotel", objective: "higher_rating" }],
        },
        {
          id: "luxury_level",
          label: "A luxury category hotel",
          commands: [{ type: "find_alternatives", target: "hotel", objective: "match_preferences", level: "luxury" }],
        },
      ],
    };
  }

  if (wantsRelaxed) {
    // A numeric museum request must never be silently dropped by a pace change.
    const commands: ModelFacingCommand[] = [{ type: "set_activity_pace", pace: "relaxed" }];
    if (museumsRequest && requestedMuseums !== undefined) {
      commands.push({
        type: "set_activity_requirement",
        tag: "museum",
        minimumCount: Math.min(7, Math.max(1, requestedMuseums)),
      });
    }
    return {
      kind: "commands",
      commands,
      preserve: ["flights", "hotel", "breakfast", "lunch", "dinner"],
      interpretation:
        commands.length > 1
          ? `Use a relaxed pace with at least ${requestedMuseums} museums; keep every booking and confirmed meal time.`
          : "Use a relaxed pace and keep every booking and confirmed meal time.",
    };
  }

  if (wantsIntensive) {
    return {
      kind: "commands",
      commands: [{ type: "set_activity_pace", pace: "intensive" }],
      preserve: ["flights", "hotel", "breakfast", "lunch", "dinner"],
      interpretation: "Use an intensive pace while keeping existing bookings.",
    };
  }

  if (museumsRequest && requestedMuseums !== undefined) {
    const absolute = Math.min(7, Math.max(1, requestedMuseums));
    return {
      kind: "commands",
      commands: [{ type: "set_activity_requirement", tag: "museum", minimumCount: absolute }],
      preserve: ["flights", "breakfast", "lunch", "dinner"],
      interpretation: `Require at least ${absolute} museums in the plan.`,
    };
  }

  if (/(park)/.test(text) && /(instead|rather|prefer)/.test(text)) {
    return {
      kind: "commands",
      commands: [
        { type: "set_activity_requirement", tag: "museum", minimumCount: null },
        {
          type: "set_interests",
          interests: { culture: 2, relaxation: 4, entertainment: 1 },
          preferredTags: ["park", "garden"],
        },
      ],
      preserve: ["flights", "hotel", "breakfast", "lunch", "dinner"],
      interpretation: "Prefer parks and gardens over another museum, keeping the bookings.",
    };
  }

  if (/(cheaper|budget|save money)/.test(text)) {
    return {
      kind: "clarification",
      question: "Which part should I search for a cheaper option: hotel, meals, or activities?",
      requestedCommands: [],
      preserve: ["flights"],
      options: [
        {
          id: "cheaper_hotel",
          label: "Cheaper hotel",
          commands: [{ type: "find_alternatives", target: "hotel", objective: "cheaper" }],
        },
        {
          id: "cheaper_meals",
          label: "Cheaper meals",
          commands: [{ type: "find_alternatives", target: "dinner", objective: "cheaper" }],
        },
        {
          id: "cheaper_activities",
          label: "Cheaper activities",
          commands: [{ type: "find_alternatives", target: "activities", objective: "cheaper" }],
        },
      ],
    };
  }

  return {
    kind: "unsupported",
    explanation:
      "This is a scripted fixture response. Use the listed demo requests or the graphical controls.",
  };
}

/** Deterministic fixture ranking: cheaper first, then by id (stable ordering). */
export function fixtureRecommendation(
  context: RecommendationContext,
): { rankedOfferIds: string[]; reasons: { offerId: string; explanation: string }[]; tradeoffs: string[] } {
  const ranked = [...context.candidates].sort(
    (a, b) => a.partyTotalMinor - b.partyTotalMinor || a.offerId.localeCompare(b.offerId),
  );
  return {
    rankedOfferIds: ranked.map((candidate) => candidate.offerId),
    reasons: ranked.slice(0, 5).map((candidate) => ({
      offerId: candidate.offerId,
      explanation: `Deterministic fixture ranking: party total ${candidate.partyTotalMinor} EUR minor units.`,
    })),
    tradeoffs: ranked.length > 1 ? ["Fixture ranking ignores qualitative preferences."] : [],
  };
}

/** Invalid first itinerary fixture for the Phase 10 repair test. */
export const FIXTURE_INVALID_FIRST_ITINERARY = {
  stops: [{ kind: "activity", refId: "invented-activity", startMinute: 100, durationMinutes: 30 }],
  explanation: "fixture: invented candidate id (must be rejected)",
  compromises: [],
} as const;

/**
 * Deterministic fixture pace profile mirroring the authoritative
 * `PACE_PROFILES` in `@odft/domain` (asserted by the itinerary pace unit test;
 * the AI package intentionally depends only on contracts).
 */
const FIXTURE_PACE = {
  relaxed: { targetMin: 2, targetMax: 3, visitCap: 240, rhythmBreak: 20, buffer: 20 },
  moderate: { targetMin: 3, targetMax: 5, visitCap: 360, rhythmBreak: 12, buffer: 15 },
  intensive: { targetMin: 5, targetMax: 7, visitCap: 480, rhythmBreak: 8, buffer: 10 },
} as const;

/**
 * Extra minutes reserved inside the fixture schedule for the simulated transfer
 * and the airport buffer, so the deterministic assembly never records a
 * `transfer_gap` for a plan the fixture produced. The planner context carries no
 * anchors, so the base allowance covers the worst intra-city leg; when the
 * validator reports a `transfer_gap`, the allowance grows on the next attempt
 * (the bounded loop repairs the plan instead of failing it).
 */
const TRAVEL_ALLOWANCE = 25;
const TRAVEL_ALLOWANCE_STEP = 35;
const TRAVEL_ALLOWANCE_MAX = 150;

type FixtureCandidate = PlannerContext["candidates"][number];

interface FixtureStop {
  kind: "meal" | "activity" | "break" | "free_time";
  refId?: string;
  startMinute: number;
  durationMinutes: number;
}

function mealCandidate(
  context: PlannerContext,
  meal: "breakfast" | "lunch" | "dinner",
): FixtureCandidate | undefined {
  return context.candidates.find((candidate) => candidate.kind === "meal" && candidate.meal === meal);
}

function windowStartFor(candidate: FixtureCandidate, fallbackMinute: number): number {
  return candidate.openingStartMinute ?? fallbackMinute;
}


/**
 * Deterministic full-day fixture planner (Phase 10 step 1): breakfast, morning
 * activities, lunch, afternoon activities, dinner, and rhythm breaks inside the
 * fixed windows. It honors `minimumActivityCounts` even when that exceeds the
 * pace cap (the validator then reports the conflict instead of the planner
 * silently dropping a requirement) and reports compromises in the output.
 */
export function fixturePlanner(context: PlannerContext) {
  const profile = FIXTURE_PACE[context.pace];
  const stops: FixtureStop[] = [];
  const compromises: string[] = [];

  const breakfast = mealCandidate(context, "breakfast");
  const lunch = mealCandidate(context, "lunch");
  const dinner = mealCandidate(context, "dinner");
  // The worker supplies a deterministic, preference-first order; the fixture
  // must NOT re-sort it, otherwise explicitly preferred activities are lost.
  const activities = context.candidates.filter((candidate) => candidate.kind === "activity");

  // 1. Explicitly pinned visits first (visits are OPT-IN, 2026-10-14): the
  // planner plans exactly the preferred activity IDs plus whatever satisfies the
  // requested tag minimums — it never adds any other visit. The worker supplies
  // a deterministic, preference-first order; the fixture must NOT re-sort it,
  // otherwise explicitly preferred activities are lost.
  const chosen: FixtureCandidate[] = [];
  const chosenCounts: Record<string, number> = {};
  const pinned = new Set(context.preferredActivityIds);
  for (const candidate of activities) {
    if (!pinned.has(candidate.id)) {
      continue;
    }
    chosen.push(candidate);
    for (const candidateTag of candidate.tags) {
      chosenCounts[candidateTag] = (chosenCounts[candidateTag] ?? 0) + 1;
    }
  }

  // 2. Required tags next: never silently drop a requested minimum.
  for (const tag of Object.keys(context.minimumActivityCounts).sort()) {
    const minimum = context.minimumActivityCounts[tag as keyof typeof context.minimumActivityCounts];
    if (minimum === undefined || minimum === null || minimum <= 0) {
      continue;
    }
    let found = chosenCounts[tag] ?? 0;
    for (const candidate of activities) {
      if (found >= minimum) {
        break;
      }
      if (chosen.includes(candidate)) {
        continue;
      }
      if (candidate.tags.includes(tag as never)) {
        chosen.push(candidate);
        found += 1;
        for (const candidateTag of candidate.tags) {
          chosenCounts[candidateTag] = (chosenCounts[candidateTag] ?? 0) + 1;
        }
      }
    }
    if (found < minimum) {
      compromises.push(
        `Only ${found} ${tag} candidate${found === 1 ? "" : "s"} are available; the requested minimum of ${minimum} cannot be met from the supplied inventory.`,
      );
    }
  }

  const requiredMinutes = chosen.reduce((sum, candidate) => sum + candidate.durationMinutes, 0);
  if (requiredMinutes > profile.visitCap) {
    compromises.push(
      `The requested visits need ${requiredMinutes} minutes, above the ${profile.visitCap}-minute ${context.pace}-pace cap; the plan keeps the request for clarification instead of reducing it.`,
    );
  }

  // Requirement-critical candidates are placed before the remaining pinned ones:
  // an unmet tag minimum is a hard validator error, while a dropped pin only
  // warns (`preferred_activity_missing`). Without this order the layout could
  // drop the visit that satisfied a minimum and trigger an avoidable
  // clarification (2026-10-14).
  const criticalMinimumTags = Object.entries(context.minimumActivityCounts).filter(
    (entry): entry is [string, number] => (entry[1] ?? 0) > 0,
  );
  if (criticalMinimumTags.length > 0) {
    const critical = new Set<FixtureCandidate>();
    for (const [tag, minimum] of criticalMinimumTags) {
      let kept = 0;
      for (const candidate of chosen) {
        if (kept >= minimum) {
          break;
        }
        if (candidate.tags.includes(tag as never)) {
          critical.add(candidate);
          kept += 1;
        }
      }
    }
    chosen.sort((left, right) => Number(critical.has(right)) - Number(critical.has(left)));
  }

  const returnWindow = context.fixedWindows.find(
    (window) => window.kind === "airport" && window.refId === "return_flight",
  );
  // `startMinute` is the latest allowed content end (departure minus the airport
  // transfer and the departure buffer); a later-day return has no window here.
  const returnContentDeadline = returnWindow?.startMinute ?? null;

  const breakfastStart = breakfast ? windowStartFor(breakfast, 8 * 60) : null;
  if (breakfast && breakfastStart !== null) {
    stops.push({
      kind: "meal",
      refId: breakfast.id,
      startMinute: breakfastStart,
      durationMinutes: breakfast.durationMinutes,
    });
  }
  const breakfastEnd = breakfast && breakfastStart !== null ? breakfastStart + breakfast.durationMinutes : 9 * 60;

  const lunchStart = lunch ? windowStartFor(lunch, 12 * 60 + 30) : 12 * 60 + 30;
  const lunchEnd = lunch ? lunchStart + lunch.durationMinutes : lunchStart;
  const dinnerStart = dinner ? windowStartFor(dinner, 19 * 60) : null;

  const remaining = [...chosen];
  const transferGapMentions = context.validationFeedback.filter((feedback) =>
    feedback.includes("transfer_gap"),
  ).length;
  const airportBufferMentions = context.validationFeedback.filter((feedback) =>
    feedback.includes("airport_buffer"),
  ).length;
  const allowance = Math.min(
    TRAVEL_ALLOWANCE_MAX,
    TRAVEL_ALLOWANCE + TRAVEL_ALLOWANCE_STEP * transferGapMentions,
  );
  // One uniform gap between consecutive content events: the pace buffer plus
  // the travel allowance (the assembly computes the real estimate inside it).
  const travelGap = profile.buffer + allowance;
  let cursor = Math.max(9 * 60, breakfastEnd + travelGap);

  // Segment A: morning activities before lunch.
  for (const candidate of [...remaining]) {
    const start = Math.max(cursor, candidate.openingStartMinute ?? 0);
    const end = start + candidate.durationMinutes;
    if (end > lunchStart - travelGap) {
      break;
    }
    if (candidate.openingEndMinute !== undefined && end > candidate.openingEndMinute) {
      break;
    }
    stops.push({ kind: "activity", refId: candidate.id, startMinute: start, durationMinutes: candidate.durationMinutes });
    remaining.splice(remaining.indexOf(candidate), 1);
    cursor = end + profile.rhythmBreak + travelGap;
  }

  if (lunch) {
    stops.push({
      kind: "meal",
      refId: lunch.id,
      startMinute: lunchStart,
      durationMinutes: lunch.durationMinutes,
    });
  }

  // Segment B: afternoon activities until dinner (or the return window).
  cursor = Math.max(cursor, lunchEnd + travelGap);
  const afternoonDeadline =
    dinnerStart !== null
      ? dinnerStart - travelGap
      : returnContentDeadline !== null
        ? returnContentDeadline - 20 - 30 * airportBufferMentions
        : null;
  for (const candidate of [...remaining]) {
    const start = Math.max(cursor, candidate.openingStartMinute ?? 0);
    const end = start + candidate.durationMinutes;
    if (afternoonDeadline !== null && end > afternoonDeadline) {
      break;
    }
    if (candidate.openingEndMinute !== undefined && end > candidate.openingEndMinute) {
      break;
    }
    stops.push({ kind: "activity", refId: candidate.id, startMinute: start, durationMinutes: candidate.durationMinutes });
    remaining.splice(remaining.indexOf(candidate), 1);
    cursor = end + profile.rhythmBreak + travelGap;
  }

  if (dinner) {
    stops.push({
      kind: "meal",
      refId: dinner.id,
      startMinute: dinnerStart ?? 19 * 60,
      durationMinutes: dinner.durationMinutes,
    });
  }

  if (remaining.length > 0) {
    compromises.push(
      `${remaining.length} candidate visit${remaining.length === 1 ? "" : "s"} did not fit the remaining day and were left out rather than overlapping stops.`,
    );
  }

  return {
    stops,
    explanation: `Deterministic fixture itinerary: ${stops.length} stops for a ${context.pace} day.`,
    compromises,
  };
}

/**
 * Deterministic fixture review (Phase 10 step 4): qualitative only. A relaxed
 * day filled with four or more visits, or a day with excessive simulated
 * travel, yields a nonblocking `revise` suggestion; the planner reacts to the
 * `review:` feedback by reducing optional fill, so requirements keep priority.
 */
export function fixtureReviewer(context: ReviewerContext) {
  // Walking legs are transfer events too, so the transfer total already includes
  // walking minutes; adding totalWalkingMinutes again would double-count them.
  const travelMinutes = context.metrics.totalTransferMinutes;
  const issues: { code: string; eventIds: string[]; explanation: string }[] = [];
  if (context.preferences.activityPace === "relaxed" && context.metrics.activityCount >= 4) {
    issues.push({
      code: "pace_mismatch",
      eventIds: [],
      explanation: `A relaxed day with ${context.metrics.activityCount} visits feels dense; consider fewer optional visits.`,
    });
  }
  if (travelMinutes > 150) {
    issues.push({
      code: "excess_travel",
      eventIds: [],
      explanation: `About ${travelMinutes} minutes of simulated travel; consider grouping nearby stops.`,
    });
  }
  if (issues.length === 0) {
    return { verdict: "acceptable" as const, issues: [], suggestedOrder: [], explanation: "Fixture review." };
  }
  return {
    verdict: "revise" as const,
    issues,
    suggestedOrder: [],
    explanation: "Fixture review: nonblocking stylistic suggestions.",
  };
}

export class FixtureAdapter implements LLMAdapter {
  private readonly counters: FixtureCounters = {
    calls: 0,
    byRole: { intent: 0, recommendation: 0, planner: 0, reviewer: 0 },
  };
  private readonly scriptedIntents: Record<string, ModelFacingIntentResult>;

  constructor(options: { readonly scriptedIntents?: Record<string, ModelFacingIntentResult> } = {}) {
    this.scriptedIntents = options.scriptedIntents ?? {};
  }

  get fixtureCounters(): FixtureCounters {
    return { calls: this.counters.calls, byRole: { ...this.counters.byRole } };
  }

  /** Fixture invocations are never billed as real tokens/cost. */
  get billableCalls(): number {
    return 0;
  }

  async generateObject<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    this.counters.calls += 1;
    this.counters.byRole[request.role] += 1;
    let value: unknown;
    switch (request.role) {
      case "intent": {
        const context = request.context as IntentContext;
        value = this.scriptedIntents[context.message] ?? fixtureIntent(context.message, context);
        break;
      }
      case "recommendation":
        value = fixtureRecommendation(request.context as RecommendationContext);
        break;
      case "planner":
        value = fixturePlanner(request.context as PlannerContext);
        break;
      case "reviewer":
        value = fixtureReviewer(request.context as ReviewerContext);
        break;
      default:
        throw new AdapterError("AI_UNSUPPORTED", `unknown role ${String(request.role)}`);
    }
    const parsed = request.outputSchema.safeParse(value);
    if (!parsed.success) {
      throw new AdapterError("AI_SCHEMA_INVALID", "fixture value does not match the role schema");
    }
    return {
      value: parsed.data,
      callId: `fixture-${this.counters.calls}`,
      model: "fixture",
      latencyMs: 0,
      attempts: 1,
      mode: "fixture",
    };
  }
}
