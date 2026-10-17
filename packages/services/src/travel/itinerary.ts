import type { Pool } from "pg";
import {
  AIRPORT_BUFFER_MINUTES,
  assembleItinerary,
  buildItineraryConflictDecision,
  computeItinerarySourceFingerprint,
  ensureTransferAllowance,
  localMinuteOfInstant,
  paceMealDuration,
  proposedStopWindow,
  simulatedOpeningWindow,
  validateItinerary,
  type ItinerarySourceFingerprintInput,
} from "@odft/domain";
import { SyntheticRoutingProvider } from "@odft/data";
import {
  approveItineraryDraft,
  getReferenceAirport,
  ItineraryPersistenceError,
  loadItineraryById,
  loadItineraryPlanningData,
  loadLatestItinerary,
  loadOverlay,
  loadSnapshotManifest,
  parseClock,
  persistItineraryDraft,
  PostgresSnapshotSource,
  recordFaultOutcome,
  saveItineraryReview,
  type ItineraryPlanningData,
} from "@odft/persistence";
import type {
  ItineraryCosts,
  ItineraryIssue,
  ItineraryMetrics,
  ItineraryReview,
  Meal,
  ScenarioManifest,
  SnapshotContent,
  TripPreferences,
  TripRecord,
} from "@odft/contracts";
import type { RouteMode } from "@odft/data";
import {
  enforceOptInVisits,
  plannerContextSchema,
  reviewerContextSchema,
  type PlannerContext,
  type PlannerOutput,
  type ReviewerContext,
} from "@odft/ai";
import type { OperationAuthority } from "../ai/authority.js";
import { fencingContextFor } from "../ai/authority.js";
import type { AiService } from "../ai/runtime.js";
import { evaluateItineraryReview } from "./itinerary-review.js";
import type {
  ItineraryApprovalResult,
  ItineraryPlanResult,
  ItineraryReviewResult,
  ServiceEventWriter,
} from "./types.js";

/**
 * Phase 02 itinerary service: the Phase 10 bounded planning loop composition —
 * planner call, deterministic assembly/validation, immutable draft persistence,
 * the reviewer call and the fenced approval. Extracted from the worker without
 * behavior changes.
 */

const ITINERARY_ROUTING_RULE_VERSION = "phase10";
const ITINERARY_ROUTING = new SyntheticRoutingProvider();

/* ---- Phase 10 itinerary helpers ---------------------------------------------- */

function mealWindowMinutes(offer: { windowStart: string; windowEnd: string }): {
  start: number;
  end: number;
} {
  const start = parseClock(offer.windowStart) ?? 8 * 60;
  const end = parseClock(offer.windowEnd) ?? 22 * 60;
  return { start, end: Math.max(start + 15, end) };
}

type AssemblyMealCandidate = Parameters<typeof assembleItinerary>[0]["meals"][number];
type AssemblyActivityCandidate = Parameters<typeof assembleItinerary>[0]["activities"][number];

function selectedMealOffers(data: ItineraryPlanningData): AssemblyMealCandidate[] {
  const services: Meal[] = ["breakfast", "lunch", "dinner"];
  const confirmed = new Set(data.confirmedMealIds);
  const pace = data.trip.preferences.activityPace;
  const candidates: AssemblyMealCandidate[] = [];
  for (const service of services) {
    const offerId = data.confirmedMeals[service] ?? data.selectedMeals[service];
    if (!offerId) {
      continue;
    }
    const offer = data.content.restaurants.find(
      (restaurant) => restaurant.id === offerId && restaurant.meal === service,
    );
    if (!offer) {
      continue;
    }
    const window = mealWindowMinutes(offer);
    candidates.push({
      id: offer.id,
      name: offer.name,
      meal: offer.meal,
      level: offer.level,
      // Confirmed reservations keep their fixed duration; unbooked slots follow
      // the authoritative pace meal durations (08 section 7). Both the planner
      // context and the assembly read this value, so they always agree.
      durationMinutes: confirmed.has(offer.id)
        ? offer.durationMinutes
        : paceMealDuration(pace, offer.meal, offer.level),
      partyTotalMinor: offer.partyTotalMinor,
      windowStartMinute: window.start,
      windowEndMinute: window.end,
      anchor: offer.anchor,
      provenance: [`${offer.name} (${offer.level})`],
    });
  }
  return candidates;
}

function activityCandidates(data: ItineraryPlanningData): AssemblyActivityCandidate[] {
  // The traveler arranges the visits themselves: no activity candidates reach
  // the planner, so the plan contains no activity events by design.
  if (data.selfArrangedActivities) {
    return [];
  }
  const preferred = new Set(data.preferredActivityIds);
  return [...data.content.activities]
    .sort((a, b) => {
      const preferredDelta = (preferred.has(b.id) ? 1 : 0) - (preferred.has(a.id) ? 1 : 0);
      if (preferredDelta !== 0) {
        return preferredDelta;
      }
      const referenceDelta = (b.reference ? 1 : 0) - (a.reference ? 1 : 0);
      return referenceDelta !== 0 ? referenceDelta : a.id.localeCompare(b.id);
    })
    .map((activity) => ({
      id: activity.id,
      name: activity.name,
      tags: activity.tags,
      durationMinutes: activity.durationMinutes,
      ticketMinorPerAdult: activity.ticketMinorPerAdult,
      anchor: activity.anchor,
      reference: activity.reference,
      provenance: [activity.reference ? "Reference landmark data" : "Demo activity template"],
    }));
}

function returnDepartureInstant(data: ItineraryPlanningData): string | null {
  const flight = data.flightOfferId
    ? data.content.flights.find((combination) => combination.id === data.flightOfferId)
    : undefined;
  return flight?.inbound.segments[0]?.departureInstant ?? null;
}

/** Explicitly selected activities with their display names (bounded to two). */
function preferredActivityNames(
  data: ItineraryPlanningData,
): { id: string; name: string }[] {
  if (data.selfArrangedActivities) {
    return [];
  }
  return data.preferredActivityIds
    .slice(0, 2)
    .map((id) => ({
      id,
      name: data.content.activities.find((activity) => activity.id === id)?.name ?? id,
    }));
}

/**
 * Latest content end for a same-day return: the simulated airport transfer from
 * the FARTHEST possible final stop (hotel or any candidate) plus the full
 * 120-minute departure buffer. The assembly recomputes it from the actual last
 * venue, so the planner hint is conservative and they can never disagree.
 */
function airportLeadMinutes(data: ItineraryPlanningData): number {
  const airport = data.destinationAirportAnchor;
  if (!airport) {
    return AIRPORT_BUFFER_MINUTES;
  }
  const hotel = data.hotelOfferId
    ? data.content.hotels.find((offer) => offer.id === data.hotelOfferId)
    : undefined;
  const origins = [
    ...(hotel ? [hotel.anchor] : []),
    ...data.content.activities.map((activity) => activity.anchor),
    ...data.content.restaurants.map((restaurant) => restaurant.anchor),
  ];
  let maxTransferMinutes = 0;
  for (const start of origins) {
    const estimate = ITINERARY_ROUTING.estimate({
      startRef: "candidate",
      endRef: data.destinationAirportId ?? "airport",
      mode: "airport_transfer",
      adults: data.trip.adults,
      start,
      end: airport,
      ruleVersion: ITINERARY_ROUTING_RULE_VERSION,
    });
    maxTransferMinutes = Math.max(maxTransferMinutes, estimate.estimatedMinutes);
  }
  return maxTransferMinutes + AIRPORT_BUFFER_MINUTES;
}

/** Bounded, deterministic planner context (03-langgraph-design.md section 3). */
function buildPlannerContext(
  data: ItineraryPlanningData,
  feedback: readonly string[],
  departureMinuteRaw: number,
): PlannerContext {
  const meals = selectedMealOffers(data);
  const activities = activityCandidates(data).slice(0, Math.max(0, 57 - meals.length));
  // The return window constrains the sightseeing day only when the return flies
  // on that same day; a two-nights return has no day-D window.
  const sameDayReturn = departureMinuteRaw < 1440;
  return plannerContextSchema.parse({
    role: "planner",
    sightseeingDate: data.trip.sightseeingDate,
    destinationCityId: data.trip.destinationCityId,
    pace: data.trip.preferences.activityPace,
    interests: data.trip.preferences.interests,
    minimumActivityCounts: data.trip.preferences.minimumActivityCounts,
    preferredActivityIds: data.preferredActivityIds,
    budgetMinor: data.trip.preferences.maxBudgetMinor ?? null,
    fixedWindows: [
      ...meals.map((meal) => ({
        kind: "meal" as const,
        refId: meal.id,
        startMinute: meal.windowStartMinute,
        endMinute: meal.windowEndMinute,
      })),
      ...(sameDayReturn
        ? [
            {
              // `startMinute` is the latest allowed content end (departure minus
              // the airport transfer and the departure buffer); `endMinute` is
              // the departure itself.
              kind: "airport" as const,
              refId: "return_flight",
              startMinute: Math.max(0, Math.min(1439, departureMinuteRaw - airportLeadMinutes(data))),
              endMinute: Math.min(1439, departureMinuteRaw),
            },
          ]
        : []),
    ].slice(0, 24),
    candidates: [
      ...meals.map((meal) => ({
        id: meal.id,
        kind: "meal" as const,
        meal: meal.meal,
        tags: [],
        durationMinutes: Math.min(180, meal.durationMinutes),
        openingStartMinute: meal.windowStartMinute,
        openingEndMinute: Math.min(1439, meal.windowEndMinute),
      })),
      ...activities.map((activity) => {
        const window = simulatedOpeningWindow(activity.tags);
        return {
          id: activity.id,
          kind: "activity" as const,
          tags: [...activity.tags],
          durationMinutes: Math.min(180, Math.max(5, activity.durationMinutes)),
          openingStartMinute: window.startMinute,
          openingEndMinute: Math.min(1439, window.endMinute),
        };
      }),
    ].slice(0, 60),
    validationFeedback: feedback.slice(0, 10),
  });
}

function buildReviewerContext(
  data: ItineraryPlanningData,
  record: {
    events: readonly {
      id: string;
      kind: string;
      title: string;
      refId: string | null;
      activityTags: readonly string[];
      startMinute: number;
      durationMinutes: number;
      locked: boolean;
      location: { lat: number; lon: number } | null;
    }[];
    validation: {
      metrics: {
        walkingMinutes: number;
        transferMinutes: number;
        activityCount: number;
        museumCount: number;
      };
    };
  },
): ReviewerContext {
  const requirements = Object.entries(data.trip.preferences.minimumActivityCounts)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([tag, minimumCount]) => ({ tag: tag as never, minimumCount }))
    .filter((requirement) => requirement.minimumCount >= 1 && requirement.minimumCount <= 7)
    .slice(0, 8);
  return reviewerContextSchema.parse({
    role: "reviewer",
    events: record.events.slice(0, 24).map((event) => ({
      id: event.id,
      kind: event.kind,
      title: event.title,
      refId: event.refId,
      tags: [...event.activityTags],
      startMinute: Math.min(1439, event.startMinute),
      durationMinutes: event.durationMinutes,
      locked: event.locked,
      // Coordinates carry extra display precision fields; the reviewer context is
      // strict and only needs the two numbers.
      location: event.location ? { lat: event.location.lat, lon: event.location.lon } : null,
    })),
    metrics: {
      totalWalkingMinutes: record.validation.metrics.walkingMinutes,
      totalTransferMinutes: record.validation.metrics.transferMinutes,
      activityCount: record.validation.metrics.activityCount,
      museumCount: record.validation.metrics.museumCount,
    },
    preferences: data.trip.preferences,
    preferredActivityIds: data.selfArrangedActivities ? [] : data.preferredActivityIds,
    activitiesSelfArranged: data.selfArrangedActivities,
    selfArrangedMeals: data.selfArrangedMeals,
    requirements: data.selfArrangedActivities ? [] : requirements,
  });
}

/** The persisted inputs whose change invalidates an approval. */
function itinerarySource(data: ItineraryPlanningData): ItinerarySourceFingerprintInput {
  return {
    snapshotId: data.snapshotId,
    sightseeingDate: data.trip.sightseeingDate,
    travelVariant: data.trip.travelVariant,
    adults: data.trip.adults,
    destinationCityId: data.trip.destinationCityId,
    pace: data.trip.preferences.activityPace,
    minimumActivityCounts: data.trip.preferences.minimumActivityCounts,
    preferredActivityIds: data.preferredActivityIds,
    budgetMinor: data.trip.preferences.maxBudgetMinor ?? null,
    mealSelectionIds: {
      breakfast: data.confirmedMeals.breakfast ?? data.selectedMeals.breakfast,
      lunch: data.confirmedMeals.lunch ?? data.selectedMeals.lunch,
      dinner: data.confirmedMeals.dinner ?? data.selectedMeals.dinner,
    },
    confirmedMealIds: data.confirmedMealIds,
    flightOfferId: data.flightOfferId,
    flightBooked: data.flightBooked,
    hotelOfferId: data.hotelOfferId,
    hotelBooked: data.hotelBooked,
    selfArrangedMeals: data.selfArrangedMeals,
    selfArrangedActivities: data.selfArrangedActivities,
  };
}

/**
 * Phase 10: the planner proposes the selection and order, but the required room
 * between consecutive located stops (route estimate plus pace buffer) is domain
 * arithmetic. A live planner reliably leaves some back-to-back pairs, which the
 * validator can only reject; widen them deterministically before assembly.
 */
function normalizePlannerSchedule(
  output: PlannerOutput,
  data: ItineraryPlanningData,
): PlannerOutput {
  const meals = selectedMealOffers(data);
  const activities = activityCandidates(data);
  const normalized = ensureTransferAllowance({
    // The gap arithmetic must use the SAME resolved geometry the assembly will
    // place (confirmed meals locked to the offer's window start and fixed
    // duration, pace durations for unbooked meals, candidate durations for
    // activities, filler capped at 180): otherwise a pair the normalization
    // thinks fits can still fail as `transfer_gap` after assembly.
    stops: output.stops.map((stop) => {
      const window = proposedStopWindow({
        stop,
        meals,
        activities,
        confirmedMealIds: data.confirmedMealIds,
        pace: data.trip.preferences.activityPace,
      });
      return {
        kind: stop.kind,
        refId: stop.kind === "meal" || stop.kind === "activity" ? stop.refId : null,
        anchor: window.anchor,
        latestStartMinute: window.latestStartMinute,
        earliestStartMinute: window.earliestStartMinute,
        startMinute: window.startMinute,
        durationMinutes: window.durationMinutes,
      };
    }),
    pace: data.trip.preferences.activityPace,
    adults: data.trip.adults,
    routing: ITINERARY_ROUTING,
    routingRuleVersion: ITINERARY_ROUTING_RULE_VERSION,
  });
  const stops: PlannerOutput["stops"] = normalized.map((stop) =>
    stop.kind === "meal" || stop.kind === "activity"
      ? stop.refId !== null
        ? {
            kind: stop.kind,
            refId: stop.refId,
            startMinute: stop.startMinute,
            durationMinutes: stop.durationMinutes,
          }
        : // A located stop without a resolved reference cannot survive resolution;
          // keep its time budget as an unlocated break instead of inventing an id.
          {
            kind: "break" as const,
            startMinute: stop.startMinute,
            durationMinutes: stop.durationMinutes,
          }
      : { kind: stop.kind, startMinute: stop.startMinute, durationMinutes: stop.durationMinutes },
  );
  return { ...output, stops };
}

/** Scenario E: inject exactly one labeled overlap after schema parsing. */
function injectFirstAttemptOverlap(output: PlannerOutput): PlannerOutput {
  const content = output.stops
    .map((stop, index) => ({ stop, index }))
    .filter(({ stop }) => stop.kind === "meal" || stop.kind === "activity" || stop.kind === "free_time");
  if (content.length < 2) {
    return output;
  }
  const first = content[0];
  const second = content[1];
  if (!first || !second) {
    return output;
  }
  return {
    ...output,
    stops: output.stops.map((stop, index) =>
      index === second.index ? { ...stop, startMinute: first.stop.startMinute } : stop,
    ),
  };
}

const INVALID_PROPOSAL_LABEL =
  "The planner proposal was rejected before feasibility validation; no draft was persisted.";

/**
 * Build the deterministic assembly input of one proposal from planning data.
 * Shared by the worker planning path and the read-only itinerary tools so the
 * rules live in one place (Phase 04).
 */
function buildItineraryAssemblyInput(
  data: ItineraryPlanningData,
  inputs: {
    readonly proposal: PlannerOutput | { readonly stops: readonly never[] };
    readonly seedScope: string;
    readonly simulatedFailure: boolean;
    readonly departureInstant: string;
  },
): Parameters<typeof assembleItinerary>[0] {
  const hotel = data.hotelOfferId
    ? data.content.hotels.find((offer) => offer.id === data.hotelOfferId)
    : undefined;
  const flight = data.flightOfferId
    ? data.content.flights.find((combination) => combination.id === data.flightOfferId)
    : undefined;
  return {
    proposal: inputs.proposal,
    seedScope: inputs.seedScope,
    sightseeingDate: data.trip.sightseeingDate,
    zone: data.zone,
    adults: data.trip.adults,
    pace: data.trip.preferences.activityPace,
    activities: activityCandidates(data),
    meals: selectedMealOffers(data),
    confirmedMealIds: data.confirmedMealIds,
    flight: flight
      ? {
          offerId: flight.id,
          partyTotalMinor: flight.partyTotalMinor,
          label: `Flights ${flight.id}`,
        }
      : null,
    hotel: hotel
      ? {
          offerId: hotel.id,
          name: hotel.name,
          partyTotalMinor: hotel.partyTotalMinor,
          anchor: hotel.anchor,
        }
      : null,
    destinationAirport:
      data.destinationAirportId && data.destinationAirportAnchor
        ? {
            id: data.destinationAirportId,
            name: "destination airport",
            anchor: data.destinationAirportAnchor,
          }
        : null,
    dinnerExcludedReason: data.dinnerExcludedReason,
    selfArrangedMeals: data.selfArrangedMeals,
    selfArrangedActivities: data.selfArrangedActivities,
    returnDepartureInstant: inputs.departureInstant,
    routing: ITINERARY_ROUTING,
    routingRuleVersion: ITINERARY_ROUTING_RULE_VERSION,
    simulatedFailure: inputs.simulatedFailure,
  };
}

/* ---- Service ------------------------------------------------------------------ */

export interface TravelItineraryServiceDeps {
  readonly pool: Pool;
  readonly ai: AiService;
  readonly authority: OperationAuthority;
  readonly writeEvent: ServiceEventWriter;
  /** Driver abort signal (shutdown/lease loss), forwarded to AI calls. */
  readonly signal?: AbortSignal;
}

export interface TravelItineraryService {
  /**
   * Phase 10: run one bounded planning attempt (planner role or fixture, then
   * deterministic assembly + validation + immutable draft persistence).
   */
  planItinerary(input: {
    tripId: string;
    operationId: string;
    attempt: number;
    feedback: readonly string[];
  }): Promise<ItineraryPlanResult>;
  /**
   * Phase 10: review the deterministically valid draft through the reviewer role
   * (or fixture); persists typed findings and demotes nonblocking suggestions.
   */
  reviewItinerary(input: {
    tripId: string;
    operationId: string;
    attempt: number;
    atBound: boolean;
    previousRevisionFingerprint: string | null;
  }): Promise<ItineraryReviewResult>;
  /** Phase 10: fenced approval of the current draft (fingerprint-bound). */
  approveItinerary(input: {
    tripId: string;
    operationId: string;
    decisionId: string;
    acceptedRevision: number;
    itineraryId: string;
  }): Promise<ItineraryApprovalResult>;
}

export function createTravelItineraryService(
  deps: TravelItineraryServiceDeps,
): TravelItineraryService {
  const { pool, ai, authority, writeEvent, signal } = deps;

  return {
    async planItinerary(input) {
      const data = await loadItineraryPlanningData(pool, input.tripId);
      const departureInstant = returnDepartureInstant(data);
      // The plan is built around the confirmed flight or, for a declined booking
      // ("I don't want to book"), the persisted selection: either way the return
      // window, the airport buffer, and the flight/hotel costs are all included.
      if (!data.flightOfferId || !departureInstant) {
        throw new ItineraryPersistenceError(
          "CONFLICT",
          "the itinerary needs a confirmed or selected flight before planning can start",
        );
      }
      const departureMinuteRaw = localMinuteOfInstant(
        departureInstant,
        data.trip.sightseeingDate,
        data.zone,
      );
      const context = buildPlannerContext(data, input.feedback, departureMinuteRaw);
      await writeEvent({
        type: "itinerary.attempt_started",
        payload: { attempt: input.attempt, candidateCount: context.candidates.length },
      });
      const planned = await ai.plan({
        tripId: input.tripId,
        operationId: input.operationId,
        fencingToken: authority.fencingToken,
        attempt: input.attempt,
        context,
        ...(signal ? { signal } : {}),
      });

      // Scenario E: the persisted first-attempt overlay injects one labeled
      // overlap after parsing and records its outcome (idempotent per operation).
      const overlay = await loadOverlay(pool, input.tripId, "itinerary", input.operationId);
      const overlayArmed = overlay !== null && overlay.mode === "invalid_itinerary";
      const injectedBefore = overlayArmed && (overlay?.counters["attempts"] ?? 0) >= 1;
      let output = planned.kind === "planned" ? planned.output : null;
      let simulatedFailure = false;
      let simulatedFailureNote: string | null = null;
      let injectedThisAttempt = false;
      const activities = activityCandidates(data);
      // Visits are OPT-IN (2026-10-14): strip any activity the user did not pin
      // and that no stored tag minimum needs — the live model reliably adds
      // opportunistic extras despite the planner-v2 instruction.
      if (output) {
        output = enforceOptInVisits(output, {
          preferredActivityIds: data.preferredActivityIds,
          minimumActivityCounts: data.trip.preferences.minimumActivityCounts,
          candidates: activities,
        });
      }
      // Phase 10: the transfer room between consecutive located stops is domain
      // arithmetic, not model arithmetic; widen the planner's packed pairs before
      // the (deliberate) fault injection and validation so the bounded loop fails
      // only on genuine conflicts.
      if (output) {
        output = normalizePlannerSchedule(output, data);
      }
      if (output && overlayArmed && !injectedBefore) {
        const injected = injectFirstAttemptOverlap(output);
        injectedThisAttempt = injected !== output;
        output = injected;
        simulatedFailure = injectedThisAttempt;
        if (injectedThisAttempt) {
          simulatedFailureNote =
            "Simulated failure: this draft contains an injected first-attempt overlap; the bounded loop re-plans it.";
        }
      } else if (injectedBefore && input.attempt > 1) {
        // The repaired draft still carries the labeled fault so the timeline can
        // show that the injected corruption was detected and repaired.
        simulatedFailure = true;
        simulatedFailureNote =
          "Simulated failure: the first planning attempt included an injected overlap; it was repaired within the bounded loop.";
      }

      const source = itinerarySource(data);
      const assembly = assembleItinerary(
        buildItineraryAssemblyInput(data, {
          proposal: output ?? { stops: [] },
          seedScope: `${input.operationId}:${input.attempt}`,
          simulatedFailure,
          departureInstant,
        }),
      );

      const rejectionIssue: ItineraryIssue | null =
        output === null
          ? {
              severity: "error",
              code: "invalid_proposal",
              message:
                planned.kind === "rejected"
                  ? `${INVALID_PROPOSAL_LABEL} ${planned.reason}`.slice(0, 400)
                  : INVALID_PROPOSAL_LABEL,
              eventIds: [],
              simulatedFailure: false,
            }
          : null;

      const validation = validateItinerary({
        events: rejectionIssue ? [] : assembly.events,
        assemblyIssues: rejectionIssue ? [...assembly.issues, rejectionIssue] : assembly.issues,
        costs: assembly.costs,
        walkingKm: assembly.walkingKm,
        pace: data.trip.preferences.activityPace,
        minimumActivityCounts: data.trip.preferences.minimumActivityCounts,
        preferredActivityIds: data.preferredActivityIds,
        budgetMinor: data.trip.preferences.maxBudgetMinor ?? null,
        dinnerExcludedReason: data.dinnerExcludedReason,
        dinnerSelected:
          (data.confirmedMeals.dinner ?? data.selectedMeals.dinner) !== null,
        simulatedFailure,
        source,
        preferredActivities: preferredActivityNames(data),
      });

      let persisted: { id: string; version: number } | null = null;
      if (!rejectionIssue) {
        persisted = await persistItineraryDraft(
          pool,
          {
            tripId: input.tripId,
            operationId: input.operationId,
            attempt: input.attempt,
            sightseeingDate: data.trip.sightseeingDate,
            zone: data.zone,
            adults: data.trip.adults,
            pace: data.trip.preferences.activityPace,
            travelVariant: data.trip.travelVariant,
            events: [...assembly.events],
            validation,
            costs: assembly.costs,
            review: null,
            simulatedFailure,
            simulatedFailureNote,
          },
          fencingContextFor(authority, input.operationId, input.tripId),
        );
      }

      // Replay consistency: `persistItineraryDraft` returns the STORED version
      // when the attempt's effect already committed, so the graph state and the
      // review step must read the stored validation — never the freshly computed
      // one, which could differ from the persisted draft after a crash replay.
      const stored = persisted ? await loadItineraryById(pool, persisted.id) : undefined;
      const effectiveValidation = stored?.validation ?? validation;
      const effectiveSimulatedFailure = stored?.simulatedFailure ?? simulatedFailure;
      const effectiveSimulatedFailureNote = stored?.simulatedFailureNote ?? simulatedFailureNote;
      const effectiveBudgetConflict = effectiveValidation.errors.some(
        (error) => error.code === "budget_exceeded",
      );
      const effectiveConflictDecision =
        effectiveValidation.status === "invalid"
          ? buildItineraryConflictDecision({
              errors: effectiveValidation.errors,
              metrics: effectiveValidation.metrics,
              pace: data.trip.preferences.activityPace,
              minimumActivityCounts: data.trip.preferences.minimumActivityCounts,
              review: null,
            })
          : null;

      // The fault outcome is recorded only after the corrupted draft committed:
      // a crash before persistence leaves the injection unrecorded, so the next
      // attempt injects once more instead of claiming a corruption that never
      // reached the timeline (still exactly one injection per operation bound).
      if (injectedThisAttempt) {
        await recordFaultOutcome(
          pool,
          {
            tripId: input.tripId,
            operationId: input.operationId,
            domain: "itinerary",
            fault: "invalid_itinerary",
            outcome: "unavailable",
            attempt: 1,
            reason: "injected first-attempt overlap",
          },
          fencingContextFor(authority, input.operationId, input.tripId),
        );
      }

      await writeEvent({
        type: "itinerary.attempt_finished",
        payload: {
          attempt: input.attempt,
          status: effectiveValidation.status,
          errorCodes: effectiveValidation.errors.map((error) => error.code),
          warningCodes: effectiveValidation.warnings.map((warning) => warning.code),
          simulatedFailure: effectiveSimulatedFailure,
          mode: planned.mode,
        },
      });

      return {
        itineraryId: persisted?.id ?? null,
        version: persisted?.version ?? null,
        status: effectiveValidation.status,
        errors: effectiveValidation.errors,
        warnings: effectiveValidation.warnings,
        metrics: effectiveValidation.metrics,
        budgetConflict: effectiveBudgetConflict,
        conflictDecision: effectiveConflictDecision,
        simulatedFailure: effectiveSimulatedFailure,
        simulatedFailureNote: effectiveSimulatedFailureNote,
        mode: planned.mode,
      };
    },

    async reviewItinerary(input) {
      const data = await loadItineraryPlanningData(pool, input.tripId);
      const record = await loadLatestItinerary(pool, input.tripId);
      if (!record) {
        throw new ItineraryPersistenceError("CONFLICT", "no itinerary draft is available to review");
      }
      const context = buildReviewerContext(data, record);
      await writeEvent({
        type: "itinerary.review_started",
        payload: { attempt: input.attempt },
      });
      const reviewed = await ai.review({
        tripId: input.tripId,
        operationId: input.operationId,
        fencingToken: authority.fencingToken,
        attempt: input.attempt,
        context,
        ...(signal ? { signal } : {}),
      });
      const evaluation = evaluateItineraryReview(context, reviewed.output, input);
      const suggestions = reviewed.output.issues
        .map((issue) => `${issue.code}: ${issue.explanation}`.slice(0, 300))
        .slice(0, 8);
      const reviewWarnings: ItineraryIssue[] = evaluation.warningIssues
        .slice(0, 8)
        .map((issue) => ({
          severity: "warning" as const,
          code: "review_suggestion" as const,
          message: `Review suggestion (${issue.code}): ${issue.explanation}`.slice(0, 400),
          eventIds: issue.eventIds.slice(0, 8),
          simulatedFailure: false,
        }));
      const validation = {
        ...record.validation,
        warnings: [
          ...record.validation.warnings.filter((warning) => warning.code !== "review_suggestion"),
          ...reviewWarnings,
        ],
      };
      const review: ItineraryReview = {
        verdict: reviewed.output.verdict,
        issues: reviewed.output.issues,
        suggestedOrder: reviewed.output.suggestedOrder,
        explanation: reviewed.output.explanation,
        suggestionsAsWarnings: evaluation.warningIssues.length > 0,
      };
      await saveItineraryReview(
        pool,
        {
          tripId: input.tripId,
          itineraryId: record.id,
          operationId: input.operationId,
          review,
          validation,
          simulatedFailure: record.simulatedFailure,
          simulatedFailureNote: record.simulatedFailureNote,
        },
        fencingContextFor(authority, input.operationId, input.tripId),
      );
      const conflictDecision =
        evaluation.verdict === "conflict"
          ? buildItineraryConflictDecision({
              errors: record.validation.errors,
              metrics: record.validation.metrics,
              pace: data.trip.preferences.activityPace,
              minimumActivityCounts: data.trip.preferences.minimumActivityCounts,
              review,
            })
          : null;
      await writeEvent({
        type: "itinerary.reviewed",
        payload: {
          verdict: evaluation.verdict,
          suppressionReason: evaluation.suppressionReason,
          issueCount: reviewed.output.issues.length,
          attempt: input.attempt,
          mode: reviewed.mode,
        },
      });
      // Suggested order arrives as assembled event ids (unstable across
      // attempts); map it to the stable candidate refIds the planner recognizes.
      const eventRefById = new Map(
        record.events
          .filter((event) => event.refId !== null && !event.locked)
          .map((event) => [event.id, event.refId as string]),
      );
      const suggestedCandidateOrder = [
        ...new Set(
          reviewed.output.suggestedOrder
            .map((eventId) => eventRefById.get(eventId))
            .filter((refId): refId is string => typeof refId === "string"),
        ),
      ];
      return {
        verdict: evaluation.verdict,
        revisionFingerprint: evaluation.revisionFingerprint,
        suggestions,
        issueCount: reviewed.output.issues.length,
        suggestedOrder: reviewed.output.suggestedOrder,
        suggestedCandidateOrder,
        warnings: reviewWarnings,
        conflictDecision,
        mode: reviewed.mode,
      };
    },

    async approveItinerary(input) {
      const data = await loadItineraryPlanningData(pool, input.tripId);
      const currentSourceFingerprint = computeItinerarySourceFingerprint(itinerarySource(data));
      const ref = await approveItineraryDraft(
        pool,
        {
          tripId: input.tripId,
          itineraryId: input.itineraryId,
          currentSourceFingerprint,
        },
        fencingContextFor(authority, input.operationId, input.tripId),
      );
      await writeEvent({
        type: "itinerary.approved",
        payload: { itineraryId: ref.id, version: ref.version, decisionId: input.decisionId },
      });
      return { itineraryId: ref.id, version: ref.version };
    },
  };
}

/* ---- Phase 04: read-only itinerary tools for the MCP surface ----------------- */

/**
 * Deterministic itinerary preflight over an EXPLICIT frozen snapshot.
 *
 * These power the Itinerary Tools MCP endpoint: they reuse the routing,
 * assembly, validation, metrics and cost functions unchanged, validate every
 * referenced candidate against the snapshot (never accepting an invented id),
 * and persist nothing — no draft, no artifact, no fault counter.
 */

export interface ItineraryToolsScope {
  readonly snapshotId: string;
}

export interface ItineraryToolContextInput {
  readonly adults: number;
  readonly sightseeingDate: string;
  readonly travelVariant: "one_night" | "two_nights";
  readonly preferences: TripPreferences;
  readonly flightOfferId: string;
  readonly hotelOfferId: string | null;
  readonly destinationAirportId: string | null;
  readonly mealSelections: { readonly breakfast: string | null; readonly lunch: string | null; readonly dinner: string | null };
  readonly confirmedMealIds: readonly string[];
  readonly selfArrangedMeals: readonly Meal[];
  readonly selfArrangedActivities: boolean;
  readonly preferredActivityIds: readonly string[];
  readonly dinnerExcludedReason: string | null;
}

export interface ItineraryProposalStopInput {
  readonly kind: "meal" | "activity" | "free_time" | "break" | "transfer";
  readonly refId: string | null;
  readonly startMinute: number;
  readonly durationMinutes: number;
}

export interface ItineraryFindingFact {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
}

export interface ItineraryValidationFact {
  readonly snapshotId: string;
  readonly status: "valid" | "invalid";
  readonly errors: readonly ItineraryFindingFact[];
  readonly warnings: readonly ItineraryFindingFact[];
  readonly metrics: ItineraryMetrics;
  readonly walkingKm: number;
  readonly costs: ItineraryCosts;
  readonly simulatedFailure: boolean;
}

export interface TravelCostFact {
  readonly snapshotId: string;
  readonly partyTotalMinor: number;
  readonly breakdown: ItineraryCosts;
  readonly currency: "EUR";
}

export interface TravelTimeFact {
  readonly snapshotId: string;
  readonly mode: RouteMode;
  readonly distanceKm: number;
  readonly estimatedMinutes: number;
  readonly ruleVersion: string;
  readonly fromRef: string;
  readonly toRef: string;
}

export interface TravelItineraryToolsService {
  estimateTravelTime(input: {
    readonly snapshotId: string;
    readonly from: { readonly refId?: string; readonly airportId?: string };
    readonly to: { readonly refId?: string; readonly airportId?: string };
    readonly mode: RouteMode;
    readonly adults: number;
  }): Promise<TravelTimeFact>;
  validateProposal(input: {
    readonly scope: ItineraryToolsScope;
    readonly context: ItineraryToolContextInput;
    readonly stops: readonly ItineraryProposalStopInput[];
  }): Promise<ItineraryValidationFact>;
  calculateTripCost(input: {
    readonly scope: ItineraryToolsScope;
    readonly context: ItineraryToolContextInput;
  }): Promise<TravelCostFact>;
}

export class ItineraryToolError extends Error {
  readonly code: "INVALID_ARGUMENT" | "NOT_FOUND";
  constructor(code: ItineraryToolError["code"], message: string) {
    super(message);
    this.name = "ItineraryToolError";
    this.code = code;
  }
}

function anchorOf(content: SnapshotContent, refId: string): { lat: number; lon: number } | undefined {
  return (
    content.hotels.find((offer) => offer.id === refId)?.anchor ??
    content.restaurants.find((offer) => offer.id === refId)?.anchor ??
    content.activities.find((activity) => activity.id === refId)?.anchor ??
    content.events.find((event) => event.id === refId)?.anchor
  );
}

export function createTravelItineraryToolsService(deps: {
  readonly pool: Pool;
}): TravelItineraryToolsService {
  const source = new PostgresSnapshotSource(deps.pool);

  async function loadScope(scope: ItineraryToolsScope): Promise<{ content: SnapshotContent; manifest: ScenarioManifest }> {
    const manifest = await loadSnapshotManifest(deps.pool, scope.snapshotId);
    const content = await source.getContent(scope.snapshotId);
    if (!content) {
      throw new ItineraryToolError("NOT_FOUND", `snapshot ${scope.snapshotId} is not materialized`);
    }
    return { content, manifest };
  }

  /**
   * Validate every referenced candidate id against the frozen snapshot and
   * cross-check the caller-supplied context against the snapshot's own
   * context: cost/validation math must describe THIS snapshot.
   */
  function assertMembership(content: SnapshotContent, context: ItineraryToolContextInput, stops: readonly ItineraryProposalStopInput[]): void {
    if (
      context.adults !== content.context.adults ||
      context.sightseeingDate !== content.context.sightseeingDate ||
      context.travelVariant !== content.context.travelVariant
    ) {
      throw new ItineraryToolError(
        "INVALID_ARGUMENT",
        "the supplied context (adults/date/variant) does not match the frozen snapshot",
      );
    }
    const flight = content.flights.find((combination) => combination.id === context.flightOfferId);
    if (!flight) {
      throw new ItineraryToolError("INVALID_ARGUMENT", `unknown flight offer ${context.flightOfferId}`);
    }
    if (context.hotelOfferId && !content.hotels.some((offer) => offer.id === context.hotelOfferId)) {
      throw new ItineraryToolError("INVALID_ARGUMENT", `unknown hotel offer ${context.hotelOfferId}`);
    }
    for (const [meal, offerId] of Object.entries(context.mealSelections)) {
      if (offerId === null) {
        continue;
      }
      const offer = content.restaurants.find((restaurant) => restaurant.id === offerId);
      if (!offer || offer.meal !== meal) {
        throw new ItineraryToolError(
          "INVALID_ARGUMENT",
          `meal selection ${offerId} is not a ${meal} offer in this snapshot`,
        );
      }
    }
    for (const stop of stops) {
      if ((stop.kind === "meal" || stop.kind === "activity") && stop.refId) {
        const known =
          stop.kind === "meal"
            ? content.restaurants.some((offer) => offer.id === stop.refId)
            : content.activities.some((activity) => activity.id === stop.refId);
        if (!known) {
          throw new ItineraryToolError(
            "INVALID_ARGUMENT",
            `proposal references unknown ${stop.kind} candidate ${stop.refId}`,
          );
        }
      }
    }
  }

  function planningDataOf(
    snapshotId: string,
    content: SnapshotContent,
    context: ItineraryToolContextInput,
    destinationAirportAnchor: { lat: number; lon: number } | null,
  ): ItineraryPlanningData {
    const trip: TripRecord = {
      id: "00000000-0000-4000-8000-000000000000",
      sessionId: "00000000-0000-4000-8000-000000000000",
      revision: 0,
      adults: context.adults,
      originAirportId: content.flights[0]?.outbound.segments[0]?.fromAirportId ?? "",
      destinationCityId: content.context.destinationCityId,
      destinationCountryKey: content.context.countryKey,
      sightseeingDate: context.sightseeingDate,
      travelVariant: context.travelVariant,
      preferences: context.preferences,
      workflowStatus: "ready",
      recoveryRequired: false,
    };
    const selectedMeals = {
      breakfast: context.mealSelections.breakfast,
      lunch: context.mealSelections.lunch,
      dinner: context.mealSelections.dinner,
    };
    const confirmedMeals = {
      breakfast: context.confirmedMealIds.includes(context.mealSelections.breakfast ?? "")
        ? context.mealSelections.breakfast
        : null,
      lunch: context.confirmedMealIds.includes(context.mealSelections.lunch ?? "")
        ? context.mealSelections.lunch
        : null,
      dinner: context.confirmedMealIds.includes(context.mealSelections.dinner ?? "")
        ? context.mealSelections.dinner
        : null,
    };
    return {
      trip,
      zone: content.context.cityZone,
      snapshotId,
      content,
      selectedMeals,
      confirmedMeals,
      confirmedMealIds: context.confirmedMealIds,
      selfArrangedMeals: [...context.selfArrangedMeals],
      selfArrangedActivities: context.selfArrangedActivities,
      flightOfferId: context.flightOfferId,
      flightBooked: false,
      hotelOfferId: context.hotelOfferId,
      hotelBooked: false,
      dinnerExcludedReason: context.dinnerExcludedReason,
      destinationAirportId: context.destinationAirportId,
      destinationAirportAnchor,
      preferredActivityIds: [...context.preferredActivityIds],
    };
  }

  function runAssembly(
    snapshotId: string,
    content: SnapshotContent,
    context: ItineraryToolContextInput,
    destinationAirportAnchor: { lat: number; lon: number } | null,
    stops: readonly ItineraryProposalStopInput[],
  ): { validation: ReturnType<typeof validateItinerary>; costs: ItineraryCosts; walkingKm: number } {
    const data = planningDataOf(snapshotId, content, context, destinationAirportAnchor);
    const flight = content.flights.find((combination) => combination.id === context.flightOfferId);
    const departureInstant = flight?.inbound.segments[0]?.departureInstant;
    if (!departureInstant) {
      throw new ItineraryToolError("INVALID_ARGUMENT", "the selected flight has no return departure");
    }
    const proposal: PlannerOutput = {
      stops: stops.map((stop) => ({
        kind: stop.kind,
        refId: stop.refId,
        startMinute: stop.startMinute,
        durationMinutes: stop.durationMinutes,
      })) as PlannerOutput["stops"],
      explanation: "itinerary-tools preflight proposal",
      compromises: [],
    };
    const assembly = assembleItinerary(
      buildItineraryAssemblyInput(data, {
        proposal,
        seedScope: `${snapshotId}:itinerary-tools`,
        simulatedFailure: false,
        departureInstant,
      }),
    );
    const validation = validateItinerary({
      events: assembly.events,
      assemblyIssues: assembly.issues,
      costs: assembly.costs,
      walkingKm: assembly.walkingKm,
      pace: data.trip.preferences.activityPace,
      minimumActivityCounts: data.trip.preferences.minimumActivityCounts,
      preferredActivityIds: data.preferredActivityIds,
      budgetMinor: data.trip.preferences.maxBudgetMinor ?? null,
      dinnerExcludedReason: data.dinnerExcludedReason,
      dinnerSelected: (data.confirmedMeals.dinner ?? data.selectedMeals.dinner) !== null,
      simulatedFailure: false,
      source: itinerarySource(data),
      preferredActivities: preferredActivityNames(data),
    });
    return { validation, costs: assembly.costs, walkingKm: assembly.walkingKm };
  }

  return {
    async estimateTravelTime(input) {
      const { content } = await loadScope({ snapshotId: input.snapshotId });
      const resolve = async (
        ref: { refId?: string; airportId?: string },
      ): Promise<{ anchor: { lat: number; lon: number }; label: string }> => {
        if (ref.airportId) {
          const airport = await getReferenceAirport(deps.pool, ref.airportId);
          if (!airport) {
            throw new ItineraryToolError("INVALID_ARGUMENT", `unknown airport ${ref.airportId}`);
          }
          return { anchor: { lat: airport.lat, lon: airport.lon }, label: airport.iata };
        }
        if (ref.refId) {
          const anchor = anchorOf(content, ref.refId);
          if (!anchor) {
            throw new ItineraryToolError(
              "INVALID_ARGUMENT",
              `unknown snapshot candidate ${ref.refId}`,
            );
          }
          return { anchor, label: ref.refId };
        }
        throw new ItineraryToolError("INVALID_ARGUMENT", "a refId or airportId is required");
      };
      const from = await resolve(input.from);
      const to = await resolve(input.to);
      const estimate = ITINERARY_ROUTING.estimate({
        startRef: from.label,
        endRef: to.label,
        mode: input.mode,
        adults: input.adults,
        start: from.anchor,
        end: to.anchor,
        ruleVersion: ITINERARY_ROUTING_RULE_VERSION,
      });
      return {
        snapshotId: input.snapshotId,
        mode: input.mode,
        distanceKm: estimate.distanceKm,
        estimatedMinutes: estimate.estimatedMinutes,
        ruleVersion: ITINERARY_ROUTING_RULE_VERSION,
        fromRef: from.label,
        toRef: to.label,
      };
    },

    async validateProposal(input) {
      const { content } = await loadScope(input.scope);
      assertMembership(content, input.context, input.stops);
      const airportAnchor = input.context.destinationAirportId
        ? await (async () => {
            const airport = await getReferenceAirport(deps.pool, input.context.destinationAirportId as string);
            return airport ? { lat: airport.lat, lon: airport.lon } : null;
          })()
        : null;
      const { validation, costs, walkingKm } = runAssembly(
        input.scope.snapshotId,
        content,
        input.context,
        airportAnchor,
        input.stops,
      );
      return {
        snapshotId: input.scope.snapshotId,
        status: validation.status,
        errors: validation.errors.map((error) => ({
          severity: error.severity,
          code: error.code,
          message: error.message,
        })),
        warnings: validation.warnings.map((warning) => ({
          severity: warning.severity,
          code: warning.code,
          message: warning.message,
        })),
        metrics: validation.metrics,
        walkingKm,
        costs,
        simulatedFailure: false,
      };
    },

    async calculateTripCost(input) {
      const { content } = await loadScope(input.scope);
      assertMembership(content, input.context, []);
      const airportAnchor = input.context.destinationAirportId
        ? await (async () => {
            const airport = await getReferenceAirport(deps.pool, input.context.destinationAirportId as string);
            return airport ? { lat: airport.lat, lon: airport.lon } : null;
          })()
        : null;
      const { costs } = runAssembly(
        input.scope.snapshotId,
        content,
        input.context,
        airportAnchor,
        [],
      );
      return {
        snapshotId: input.scope.snapshotId,
        partyTotalMinor: costs.totalMinor,
        breakdown: costs,
        currency: "EUR",
      };
    },
  };
}
