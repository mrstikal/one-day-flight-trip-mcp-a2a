import type { Pool } from "pg";
import {
  BookingService,
  AIRPORT_BUFFER_MINUTES,
  assembleItinerary,
  buildItineraryConflictDecision,
  computeItinerarySourceFingerprint,
  ensureTransferAllowance,
  fingerprint,
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
  applyTripCommands,
  commitRouteChange,
  evaluateAndPersistRoute,
  getActiveReservation,
  getOperationPayload,
  getTrip,
  ItineraryPersistenceError,
  loadItineraryById,
  loadItineraryPlanningData,
  loadLatestItinerary,
  loadOverlay,
  loadTripProgress,
  loadTripResearchInputs,
  materializeFlightSnapshot,
  parseClock,
  persistItineraryDraft,
  planProgramSelections,
  PostgresBookingStore,
  previewRouteChange,
  rankTripRecommendations,
  recordFaultOutcome,
  recordPreferredActivities,
  removeProgramSelections,
  researchTripDomain,
  saveItineraryReview,
  ScenarioService,
  setSelfArrangedState,
  upsertProgramSelections,
  validateAndPersistSchedules,
  validateTripLogistics,
  type ItineraryPlanningData,
  type OperationFencingContext,
} from "@odft/persistence";
import {
  chatCommandPayloadSchema,
  type ItineraryIssue,
  type ItineraryReview,
  type Meal,
} from "@odft/contracts";
import {
  enforceOptInVisits,
  plannerContextSchema,
  reviewerContextSchema,
  type PlannerContext,
  type PlannerOutput,
  type ReviewerContext,
} from "@odft/ai";
import type { TravelPorts } from "@odft/workflow";
import { createFencedEventWriter, createFencedRunEffect } from "../driver.js";
import { ensureCityLandmarks, type LandmarkDiscoveryOptions } from "./landmark-discovery.js";
import type { AiService } from "../ai/service.js";
import { evaluateItineraryReview } from "./itinerary-review.js";

/**
 * Build the production travel-graph ports for one claimed operation. All access
 * to reference data, scenario generation, the two feasibility stages, the Phase
 * 09 per-domain research/ranking services, the Phase 08 intent runtime, and the
 * booking service is wired here so the graph nodes stay orchestration-only.
 */

const RESEARCH_MATERIALIZED_DOMAINS = [
  "hotels",
  "breakfast",
  "lunch",
  "dinner",
  "activities",
  "events",
] as const;

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

type AssemblyMealCandidate = Parameters<typeof assembleItinerary>[0]["meals"][number];
type AssemblyActivityCandidate = Parameters<typeof assembleItinerary>[0]["activities"][number];

/**
 * The fencing context for a domain write. It refuses a write that targets a
 * different operation/trip than the claimed one, so a stale or misrouted task
 * can never borrow the current worker's token.
 */
function fenceFor(
  ctx: OperationFencingContext,
  operationId: string,
  tripId: string,
): OperationFencingContext {
  if (operationId !== ctx.operationId || tripId !== ctx.tripId) {
    throw new Error("research write targets a different operation than the claimed one");
  }
  return { operationId: ctx.operationId, tripId: ctx.tripId, fencingToken: ctx.fencingToken };
}

export function createTravelPortsFactory(
  pool: Pool,
  ai: AiService,
  options: {
    readonly wikidataDiscovery?: boolean;
    readonly discoveryFetch?: typeof fetch;
    readonly onDiscoveryLog?: LandmarkDiscoveryOptions["logger"];
  } = {},
): (ctx: OperationFencingContext, signal?: AbortSignal) => TravelPorts {
  const booking = new BookingService(new PostgresBookingStore(pool));
  const scenarios = new ScenarioService(pool);
  const insertFencedEvent = createFencedEventWriter(pool);
  return (ctx: OperationFencingContext, signal?: AbortSignal): TravelPorts => ({
    now: () => new Date(),
    runEffect: createFencedRunEffect(pool, ctx),

    async loadTrip(tripId: string) {
      const trip = await getTrip(pool, tripId);
      return trip ? { trip } : undefined;
    },

    async applyCommands(input) {
      return applyTripCommands(pool, { tripId: input.tripId, commands: input.commands });
    },

    async evaluateRoute(tripId) {
      // On-demand curation runs before the route inputs fix the snapshot's
      // `isCurated`, so a discovered city immediately gets real landmark
      // activities; failures are non-fatal (generic categories remain).
      const trip = await getTrip(pool, tripId);
      if (trip) {
        await ensureCityLandmarks(pool, trip.destinationCityId, {
          enabled: options.wikidataDiscovery ?? false,
          ...(options.discoveryFetch ? { fetchImpl: options.discoveryFetch } : {}),
          ...(options.onDiscoveryLog ? { logger: options.onDiscoveryLog } : {}),
        });
      }
      const evaluated = await evaluateAndPersistRoute(pool, tripId);
      if (!evaluated) {
        throw new Error(`cannot evaluate route for trip ${tripId}: missing reference inputs`);
      }
      return evaluated.result;
    },

    async materializeFlights(tripId) {
      const materialized = await materializeFlightSnapshot(pool, tripId);
      return materialized
        ? { scenarioKey: materialized.scenarioKey, snapshotId: materialized.snapshotId }
        : undefined;
    },

    async validateSchedules(input) {
      const result = await validateAndPersistSchedules(pool, input.tripId, input.snapshotId);
      if (!result) {
        throw new Error(
          `cannot validate schedules for trip ${input.tripId}: snapshot or approval missing`,
        );
      }
      return result;
    },

    async propose(input) {
      const trip = await getTrip(pool, input.tripId);
      if (!trip) {
        throw new Error(`trip ${input.tripId} not found while staging a proposal`);
      }
      return booking.propose({
        tripId: input.tripId,
        sessionId: trip.sessionId,
        service: input.service,
        offerId: input.offerId,
        operationId: input.operationId,
        sourceFingerprint: input.sourceFingerprint,
        fencingToken: ctx.fencingToken,
      });
    },

    async confirm(input) {
      const trip = await getTrip(pool, input.tripId);
      if (!trip) {
        throw new Error(`trip ${input.tripId} not found while confirming a booking`);
      }
      return booking.confirm({
        tripId: input.tripId,
        sessionId: trip.sessionId,
        proposalId: input.proposalId,
        decisionId: input.decisionId,
        operationId: input.operationId,
        acceptedRevision: input.acceptedRevision,
        confirmationKey: input.confirmationKey,
        acceptedDemoDisclaimer: true,
        fencingToken: ctx.fencingToken,
      });
    },

    async replace(input) {
      const trip = await getTrip(pool, input.tripId);
      if (!trip) {
        throw new Error(`trip ${input.tripId} not found while confirming a replacement`);
      }
      const active = await getActiveReservation(pool, input.tripId, input.service);
      if (!active) {
        throw new Error(`no active ${input.service} reservation to replace`);
      }
      return booking.replaceConfirmed({
        tripId: input.tripId,
        sessionId: trip.sessionId,
        proposalId: input.proposalId,
        decisionId: input.decisionId,
        operationId: input.operationId,
        acceptedRevision: input.acceptedRevision,
        confirmationKey: input.confirmationKey,
        acceptedDemoDisclaimer: true,
        affectedReservationId: active.id,
        fencingToken: ctx.fencingToken,
      });
    },

    async declineBooking(input) {
      const trip = await getTrip(pool, input.tripId);
      if (!trip) {
        throw new Error(`trip ${input.tripId} not found while declining a booking`);
      }
      return booking.declineBooking({
        tripId: input.tripId,
        sessionId: trip.sessionId,
        proposalId: input.proposalId,
        decisionId: input.decisionId,
        operationId: input.operationId,
        fencingToken: ctx.fencingToken,
      });
    },

    async ensureDomains(tripId) {
      const manifest = await scenarios.ensureDomains(tripId, [...RESEARCH_MATERIALIZED_DOMAINS]);
      return { materializedDomains: manifest.materializedDomains, snapshotId: manifest.snapshotId };
    },

    async loadResearchInputs(tripId, operationId, searchIntent) {
      return loadTripResearchInputs(pool, tripId, operationId, searchIntent ?? null);
    },

    async researchDomain(input) {
      // Domain writes (artifact upsert, fault counters) verify the operation's
      // fencing token inside their own short transactions, so a worker that lost
      // its lease writes nothing.
      return researchTripDomain(pool, input, fenceFor(ctx, input.operationId, input.tripId));
    },

    async rankRecommendations(input) {
      return rankTripRecommendations(
        pool,
        input,
        fenceFor(ctx, input.operationId, input.tripId),
      );
    },

    async recordResearchEvent(event) {
      await insertFencedEvent(ctx, {
        type: `research.domain_${event.phase}`,
        payload: {
          domain: event.domain,
          attempt: event.attempt,
          durationMs: event.durationMs,
          status: event.status,
          simulatedFailure: event.simulatedFailure,
          reason: event.reason,
          fingerprint: event.fingerprint,
        },
      });
    },

    async applyProgram(input) {
      const plan = await planProgramSelections(pool, {
        tripId: input.tripId,
        mealSelections: input.mealSelections,
        selfArrangedMeals: input.selfArrangedMeals,
      });
      let firstReplacement: {
        proposalId: string;
        service: (typeof plan.replacements)[number]["serviceKey"];
        sourceFingerprint: string;
      } | null = null;
      for (const replacement of plan.replacements) {
        const trip = await getTrip(pool, input.tripId);
        if (!trip) {
          throw new Error(`trip ${input.tripId} not found while staging a meal replacement`);
        }
        const sourceFingerprint = fingerprint({
          kind: "replacement_confirmation",
          tripId: input.tripId,
          operationId: input.operationId,
          service: replacement.serviceKey,
          offerId: replacement.offerId,
        });
        const proposal = await booking.propose({
          tripId: input.tripId,
          sessionId: trip.sessionId,
          service: replacement.serviceKey,
          offerId: replacement.offerId,
          operationId: input.operationId,
          sourceFingerprint,
          fencingToken: ctx.fencingToken,
        });
        firstReplacement ??= {
          proposalId: proposal.proposalId,
          service: replacement.serviceKey,
          sourceFingerprint,
        };
      }
      await upsertProgramSelections(pool, input.tripId, plan.selections);
      // A meal the traveler now arranges themselves loses its unbooked selection
      // (planProgramSelections refused this for any confirmed reservation).
      await removeProgramSelections(pool, input.tripId, plan.selfArrangedMeals);
      await setSelfArrangedState(pool, input.tripId, {
        meals: plan.selfArrangedMeals,
        activities: input.activitiesSelfArranged,
      });
      // Self-arranged activities keep the previously recorded preferences (they
      // return unchanged when the traveler opts back in).
      if (!input.activitiesSelfArranged) {
        await recordPreferredActivities(pool, {
          tripId: input.tripId,
          preferredActivityIds: input.preferredActivityIds,
        });
      }
      await insertFencedEvent(ctx, { type: "program.saved", payload: {} });
      return {
        applied: true,
        replacementStaged: firstReplacement !== null,
        replacementProposalId: firstReplacement?.proposalId ?? null,
        replacementService: firstReplacement?.service ?? null,
        replacementSourceFingerprint: firstReplacement?.sourceFingerprint ?? null,
      };
    },

    async validateSelectedLogistics(input) {
      return validateTripLogistics(pool, input.tripId);
    },

    async loadProgress(tripId) {
      return loadTripProgress(pool, tripId);
    },

    async previewRouteChange(input) {
      return previewRouteChange(pool, { tripId: input.tripId, commands: input.commands });
    },

    async commitRouteChange(input) {
      return commitRouteChange(pool, {
        tripId: input.tripId,
        operationId: input.operationId,
        decisionId: input.decisionId,
        proposalId: input.proposalId,
        affectedReservationIds: input.affectedReservationIds,
        commands: input.commands,
        fencingToken: ctx.fencingToken,
      });
    },

    async interpretIntent(input) {
      return ai.interpret({
        tripId: input.tripId,
        operationId: input.operationId,
        fencingToken: ctx.fencingToken,
        message: input.message,
        ...(signal ? { signal } : {}),
      });
    },

    async loadChatMessage(operationId) {
      const payload = await getOperationPayload(pool, operationId);
      const parsed = chatCommandPayloadSchema.safeParse(payload);
      return parsed.success ? parsed.data.message : undefined;
    },

    async loadOperationPayload(operationId) {
      return getOperationPayload(pool, operationId);
    },

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
      await insertFencedEvent(ctx, {
        type: "itinerary.attempt_started",
        payload: { attempt: input.attempt, candidateCount: context.candidates.length },
      });
      const planned = await ai.plan({
        tripId: input.tripId,
        operationId: input.operationId,
        fencingToken: ctx.fencingToken,
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
      const meals = selectedMealOffers(data);
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

      const hotel = data.hotelOfferId
        ? data.content.hotels.find((offer) => offer.id === data.hotelOfferId)
        : undefined;
      const flight = data.flightOfferId
        ? data.content.flights.find((combination) => combination.id === data.flightOfferId)
        : undefined;
      const source = itinerarySource(data);
      const assembly = assembleItinerary({
        proposal: output ?? { stops: [] },
        seedScope: `${input.operationId}:${input.attempt}`,
        sightseeingDate: data.trip.sightseeingDate,
        zone: data.zone,
        adults: data.trip.adults,
        pace: data.trip.preferences.activityPace,
        activities,
        meals,
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
        returnDepartureInstant: departureInstant,
        routing: ITINERARY_ROUTING,
        routingRuleVersion: ITINERARY_ROUTING_RULE_VERSION,
        simulatedFailure,
      });

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
          fenceFor(ctx, input.operationId, input.tripId),
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
          fenceFor(ctx, input.operationId, input.tripId),
        );
      }

      await insertFencedEvent(ctx, {
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
      await insertFencedEvent(ctx, {
        type: "itinerary.review_started",
        payload: { attempt: input.attempt },
      });
      const reviewed = await ai.review({
        tripId: input.tripId,
        operationId: input.operationId,
        fencingToken: ctx.fencingToken,
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
        fenceFor(ctx, input.operationId, input.tripId),
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
      await insertFencedEvent(ctx, {
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
        fenceFor(ctx, input.operationId, input.tripId),
      );
      await insertFencedEvent(ctx, {
        type: "itinerary.approved",
        payload: { itineraryId: ref.id, version: ref.version, decisionId: input.decisionId },
      });
      return { itineraryId: ref.id, version: ref.version };
    },
  });
}
