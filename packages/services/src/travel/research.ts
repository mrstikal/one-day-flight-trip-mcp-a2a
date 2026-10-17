import type { Pool } from "pg";
import {
  decideProviderOutcome,
  SyntheticAccommodationSearchProvider,
  SyntheticAttractionsProvider,
  SyntheticEventsProvider,
  SyntheticFlightSearchProvider,
  SyntheticRestaurantSearchProvider,
  type BehaviorOverlay,
} from "@odft/data";
import {
  effectiveLevel,
  loadSnapshotManifest,
  loadTripResearchInputs,
  nightDates,
  PostgresSnapshotSource,
  rankTripRecommendations,
  researchTripDomain,
} from "@odft/persistence";
import { SCENARIO_DOMAIN_FOR_RESEARCH, type FeasibleRouteApproval, type Meal, type ScenarioManifest, type ServiceLevel, type TripRecord } from "@odft/contracts";
import type { OperationAuthority } from "../ai/authority.js";
import { fencingContextFor } from "../ai/authority.js";
import type {
  RankDomainCandidates,
  RankedServices,
  ResearchDomain,
  ResearchEvent,
  ResearchInputs,
  ResearchOutcome,
  ResearchSearchIntent,
  ServiceEventWriter,
} from "./types.js";

export type { BehaviorOverlay };

/**
 * Phase 02 research service: the Phase 09 per-domain research/ranking composition
 * over the persistence layer. Domain writes (artifact upsert, fault counters)
 * verify the operation's fencing token inside their own short transactions, so a
 * worker that lost its lease writes nothing.
 */

export interface TravelResearchServiceDeps {
  readonly pool: Pool;
  readonly authority: OperationAuthority;
  readonly writeEvent: ServiceEventWriter;
}

export interface TravelResearchService {
  /** Phase 09: deterministic per-domain research input fingerprints. */
  loadResearchInputs(
    tripId: string,
    operationId: string,
    searchIntent?: ResearchSearchIntent | null,
  ): Promise<ResearchInputs>;
  /** Phase 09: research one domain (provider + idempotent artifact write). */
  researchDomain(input: {
    tripId: string;
    operationId: string;
    domain: ResearchDomain;
    attempt: number;
    inputFingerprint: string;
    /** Phase 11: operation-scoped level override / cheaper comparison. */
    searchIntent?: ResearchSearchIntent | null;
  }): Promise<ResearchOutcome>;
  /** Phase 09: deterministic re-filter/re-order + artifact persistence. */
  rankRecommendations(input: {
    tripId: string;
    operationId: string;
    domains: readonly RankDomainCandidates[];
    /** Phase 11: operation-scoped level override / cheaper comparison. */
    searchIntent?: ResearchSearchIntent | null;
  }): Promise<RankedServices>;
  /** Phase 09: persist one safe domain timing/attempt event. */
  recordResearchEvent(event: ResearchEvent): Promise<void>;
}

export function createTravelResearchService(
  deps: TravelResearchServiceDeps,
): TravelResearchService {
  const { pool, authority, writeEvent } = deps;
  return {
    async loadResearchInputs(tripId, operationId, searchIntent) {
      return loadTripResearchInputs(pool, tripId, operationId, searchIntent ?? null);
    },

    async researchDomain(input) {
      return researchTripDomain(pool, input, fencingContextFor(authority, input.operationId, input.tripId));
    },

    async rankRecommendations(input) {
      return rankTripRecommendations(
        pool,
        input,
        fencingContextFor(authority, input.operationId, input.tripId),
      );
    },

    async recordResearchEvent(event) {
      await writeEvent({
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
  };
}

/* ---- Phase 04: read-only frozen-snapshot queries for the MCP surface --------- */

/**
 * Read-only candidate queries over an EXPLICIT frozen snapshot.
 *
 * These power the Travel Data MCP tools: they never resolve the trip's active
 * snapshot pointer, never write recommendation artifacts or fault counters, and
 * never materialize anything. The persisted behavior overlay and attempt are
 * injected so a simulated provider outcome is honored without recording it —
 * only the coordinator owns fault-outcome writes (plan §3.11).
 */

export interface SnapshotReadScope {
  readonly snapshotId: string;
  readonly trip: TripRecord;
  /** Resolved immutable fault overlay (null: normal behavior). */
  readonly behavior: BehaviorOverlay | null;
  readonly attempt: number;
  /** Operation-scoped category override of the delegation (optional). */
  readonly levelOverride?: ServiceLevel | null;
}

export interface SnapshotCandidatePage<T> {
  readonly domain: ResearchDomain | "flights";
  readonly snapshotId: string;
  /** Manifest domain content hash: the frozen-identity evidence. */
  readonly domainHash: string;
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly hasMore: boolean;
  readonly items: readonly T[];
  readonly providerStatus: "ok" | "unavailable" | "retryable_error" | "unsupported";
  readonly reason: string | null;
  /** True when a persisted simulation overlay produced this outcome (§3.11). */
  readonly simulated: boolean;
}

export interface ScenarioMetadataFact {
  readonly snapshotId: string;
  readonly scenarioKey: string;
  readonly seed: string;
  readonly generatorVersion: string;
  readonly fakerVersion: string;
  readonly referenceVersion: string;
  readonly generatedAt: string;
  readonly destinationCityId: string;
  readonly routeFingerprint: string;
  readonly materializedDomains: readonly string[];
  readonly domainVersions: Readonly<Record<string, number>>;
  readonly domainContentHashes: Readonly<Record<string, string>>;
  readonly counts: {
    readonly flights: number;
    readonly hotels: number;
    readonly restaurants: number;
    readonly activities: number;
    readonly events: number;
  };
}

export interface FlightCandidateFact {
  readonly id: string;
  readonly partyTotalMinor: number;
  readonly perAdultMinor: number;
  readonly adults: number;
  readonly supportedVariants: readonly string[];
  readonly outbound: readonly FlightSegmentFact[];
  readonly inbound: readonly FlightSegmentFact[];
}

export interface FlightSegmentFact {
  readonly fromIata: string;
  readonly toIata: string;
  readonly departureInstant: string;
  readonly arrivalInstant: string;
  readonly durationMinutes: number;
}

export interface HotelCandidateFact {
  readonly id: string;
  readonly name: string;
  readonly level: ServiceLevel;
  readonly nights: number;
  readonly adults: number;
  readonly partyTotalMinor: number;
  readonly luggageStorage: boolean;
  readonly centerDistanceKm: number;
  readonly anchor: { readonly lat: number; readonly lon: number };
}

export interface RestaurantCandidateFact {
  readonly id: string;
  readonly name: string;
  readonly meal: Meal;
  readonly level: ServiceLevel;
  readonly partyTotalMinor: number;
  readonly durationMinutes: number;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly anchor: { readonly lat: number; readonly lon: number };
}

export interface ActivityCandidateFact {
  readonly id: string;
  readonly name: string;
  readonly kind: "landmark" | "generic";
  readonly tags: readonly string[];
  readonly durationMinutes: number;
  readonly ticketMinorPerAdult: number;
  readonly reference: boolean;
  readonly anchor: { readonly lat: number; readonly lon: number };
}

export interface EventCandidateFact {
  readonly id: string;
  readonly name: string;
  readonly kind: "performance" | "exhibition" | "festival";
  readonly date: string;
  readonly startLocalTime: string;
  readonly durationMinutes: number;
  readonly ticketMinorPerAdult: number;
  readonly anchor: { readonly lat: number; readonly lon: number };
}

export interface PageRequest {
  readonly page?: number;
  readonly pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

function paginate<T>(items: readonly T[], request: PageRequest): { items: readonly T[]; page: number; pageSize: number; hasMore: boolean; total: number } {
  const page = Math.max(1, Math.floor(request.page ?? 1));
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(request.pageSize ?? DEFAULT_PAGE_SIZE)));
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page,
    pageSize,
    hasMore: start + pageSize < items.length,
    total: items.length,
  };
}

function segmentFacts(direction: {
  segments: readonly {
    fromIata: string;
    toIata: string;
    departureInstant: string;
    arrivalInstant: string;
    elapsedMinutes: number;
  }[];
}): FlightSegmentFact[] {
  return direction.segments.map((segment) => ({
    fromIata: segment.fromIata,
    toIata: segment.toIata,
    departureInstant: segment.departureInstant,
    arrivalInstant: segment.arrivalInstant,
    durationMinutes: segment.elapsedMinutes,
  }));
}

export interface TravelSnapshotReadDependencies {
  readonly pool: Pool;
}

export interface TravelSnapshotReadService {
  /** Manifest + bounded content counts of an explicit snapshot (no trip read). */
  readScenarioMetadata(snapshotId: string): Promise<ScenarioMetadataFact>;
  /**
   * Schedule-valid flight combinations of the delegated approval, ranked by
   * party total. Only combinations the persisted Stage B validation accepted
   * are returned (the approval alone is not a schedule guarantee).
   */
  searchFlights(
    input: SnapshotReadScope & PageRequest & {
      readonly approval: FeasibleRouteApproval;
      readonly validCombinationIds: readonly string[];
    },
  ): Promise<SnapshotCandidatePage<FlightCandidateFact>>;
  searchHotels(input: SnapshotReadScope & PageRequest): Promise<SnapshotCandidatePage<HotelCandidateFact>>;
  searchRestaurants(input: SnapshotReadScope & PageRequest & { readonly meal: Meal }): Promise<SnapshotCandidatePage<RestaurantCandidateFact>>;
  searchAttractions(input: SnapshotReadScope & PageRequest): Promise<SnapshotCandidatePage<ActivityCandidateFact>>;
  searchEvents(input: SnapshotReadScope & PageRequest): Promise<SnapshotCandidatePage<EventCandidateFact>>;
}

export function createTravelSnapshotReadService(
  deps: TravelSnapshotReadDependencies,
): TravelSnapshotReadService {
  const source = new PostgresSnapshotSource(deps.pool);

  async function manifestFor(snapshotId: string): Promise<ScenarioManifest> {
    return loadSnapshotManifest(deps.pool, snapshotId);
  }

  function levelFor(scope: SnapshotReadScope, service: Meal | "hotel"): ServiceLevel {
    if (scope.levelOverride) {
      return scope.levelOverride;
    }
    return effectiveLevel(scope.trip.preferences, service);
  }

  function domainHashOf(manifest: ScenarioManifest, domain: ResearchDomain | "flights"): string {
    return manifest.domainContentHashes[domain === "flights" ? "flights" : SCENARIO_DOMAIN_FOR_RESEARCH[domain]];
  }

  function pageOf<T>(
    domain: ResearchDomain | "flights",
    scope: SnapshotReadScope,
    manifest: ScenarioManifest,
    request: PageRequest,
    items: readonly T[],
  ): SnapshotCandidatePage<T> {
    const page = paginate(items, request);
    return {
      domain,
      snapshotId: scope.snapshotId,
      domainHash: domainHashOf(manifest, domain),
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
      hasMore: page.hasMore,
      items: page.items,
      providerStatus: "ok",
      reason: null,
      simulated: false,
    };
  }

  function providerFailure<T>(
    domain: ResearchDomain | "flights",
    scope: SnapshotReadScope,
    manifest: ScenarioManifest,
    status: "unavailable" | "retryable_error" | "unsupported",
    reason: string,
    request: PageRequest,
  ): SnapshotCandidatePage<T> {
    const page = paginate([], request);
    return {
      domain,
      snapshotId: scope.snapshotId,
      domainHash: domainHashOf(manifest, domain),
      total: 0,
      page: page.page,
      pageSize: page.pageSize,
      hasMore: false,
      items: [],
      providerStatus: status,
      reason,
      simulated:
        scope.behavior !== null &&
        decideProviderOutcome(
          scope.behavior,
          domain === "flights" ? "flights" : SCENARIO_DOMAIN_FOR_RESEARCH[domain],
          scope.attempt,
        ) !== "ok",
    };
  }

  return {
    async readScenarioMetadata(snapshotId) {
      const manifest = await manifestFor(snapshotId);
      const content = await source.getContent(snapshotId);
      if (!content) {
        throw new Error(`snapshot ${snapshotId} is not materialized`);
      }
      return {
        snapshotId: manifest.snapshotId,
        scenarioKey: manifest.scenarioKey,
        seed: manifest.seed,
        generatorVersion: manifest.generatorVersion,
        fakerVersion: manifest.fakerVersion,
        referenceVersion: manifest.referenceVersion,
        generatedAt: manifest.generatedAt,
        destinationCityId: manifest.destinationCityId,
        routeFingerprint: manifest.routeFingerprint,
        materializedDomains: [...manifest.materializedDomains],
        domainVersions: { ...manifest.domainVersions },
        domainContentHashes: { ...manifest.domainContentHashes },
        counts: {
          flights: content.flights.length,
          hotels: content.hotels.length,
          restaurants: content.restaurants.length,
          activities: content.activities.length,
          events: content.events.length,
        },
      };
    },

    async searchFlights(input) {
      const manifest = await manifestFor(input.snapshotId);
      const provider = new SyntheticFlightSearchProvider(source, input.behavior);
      const result = await provider.search({
        snapshotId: input.snapshotId,
        approval: input.approval,
        travelVariant: input.trip.travelVariant,
        adults: input.trip.adults,
        attempt: input.attempt,
      });
      if (result.status !== "ok") {
        return providerFailure("flights", input, manifest, result.status, result.reason, input);
      }
      const validIds = new Set(input.validCombinationIds);
      const valid = result.value.filter((combination) => validIds.has(combination.id));
      if (valid.length === 0) {
        return providerFailure(
          "flights",
          input,
          manifest,
          "unsupported",
          "no combination in this snapshot passed the schedule validation",
          input,
        );
      }
      const facts: FlightCandidateFact[] = [...valid]
        .sort((a, b) => a.partyTotalMinor - b.partyTotalMinor || a.id.localeCompare(b.id))
        .map((combination) => ({
          id: combination.id,
          partyTotalMinor: combination.partyTotalMinor,
          perAdultMinor: combination.perAdultMinor,
          adults: combination.adults,
          supportedVariants: [...combination.supportedVariants],
          outbound: segmentFacts(combination.outbound),
          inbound: segmentFacts(combination.inbound),
        }));
      return pageOf("flights", input, manifest, input, facts);
    },

    async searchHotels(input) {
      const manifest = await manifestFor(input.snapshotId);
      const provider = new SyntheticAccommodationSearchProvider(source, input.behavior);
      const result = await provider.search({
        snapshotId: input.snapshotId,
        level: levelFor(input, "hotel"),
        adults: input.trip.adults,
        dates: nightDates(input.trip.sightseeingDate, input.trip.travelVariant),
        attempt: input.attempt,
      });
      if (result.status !== "ok") {
        return providerFailure("hotel", input, manifest, result.status, result.reason, input);
      }
      const offerable =
        input.trip.travelVariant === "one_night"
          ? result.value.filter((offer) => offer.luggageStorage)
          : result.value;
      const facts: HotelCandidateFact[] = [...offerable]
        .sort((a, b) => a.partyTotalMinor - b.partyTotalMinor || a.id.localeCompare(b.id))
        .map((offer) => ({
          id: offer.id,
          name: offer.name,
          level: offer.level,
          nights: offer.nights,
          adults: offer.adults,
          partyTotalMinor: offer.partyTotalMinor,
          luggageStorage: offer.luggageStorage,
          centerDistanceKm: offer.centerDistanceKm,
          anchor: { lat: offer.anchor.lat, lon: offer.anchor.lon },
        }));
      return pageOf("hotel", input, manifest, input, facts);
    },

    async searchRestaurants(input) {
      const manifest = await manifestFor(input.snapshotId);
      const provider = new SyntheticRestaurantSearchProvider(source, input.behavior);
      const result = await provider.search({
        snapshotId: input.snapshotId,
        meal: input.meal,
        level: levelFor(input, input.meal),
        adults: input.trip.adults,
        attempt: input.attempt,
      });
      if (result.status !== "ok") {
        return providerFailure(input.meal, input, manifest, result.status, result.reason, input);
      }
      const facts: RestaurantCandidateFact[] = [...result.value]
        .sort((a, b) => a.partyTotalMinor - b.partyTotalMinor || a.id.localeCompare(b.id))
        .map((offer) => ({
          id: offer.id,
          name: offer.name,
          meal: offer.meal,
          level: offer.level,
          partyTotalMinor: offer.partyTotalMinor,
          durationMinutes: offer.durationMinutes,
          windowStart: offer.windowStart,
          windowEnd: offer.windowEnd,
          anchor: { lat: offer.anchor.lat, lon: offer.anchor.lon },
        }));
      return pageOf(input.meal, input, manifest, input, facts);
    },

    async searchAttractions(input) {
      const manifest = await manifestFor(input.snapshotId);
      const provider = new SyntheticAttractionsProvider(source);
      const result = await provider.list({
        snapshotId: input.snapshotId,
        cityId: input.trip.destinationCityId,
      });
      if (result.status !== "ok") {
        return providerFailure("attractions", input, manifest, result.status, result.reason, input);
      }
      // Same deterministic ordering the research path uses: preferred tags
      // first, then reviewed reference landmarks, then id.
      const preferred = new Set(input.trip.preferences.preferredActivityTags);
      const facts: ActivityCandidateFact[] = [...result.value]
        .sort((a, b) => {
          const preferredDelta =
            (a.tags.some((tag) => preferred.has(tag)) ? 1 : 0) -
            (b.tags.some((tag) => preferred.has(tag)) ? 1 : 0);
          if (preferredDelta !== 0) {
            return -preferredDelta;
          }
          const referenceDelta = (b.reference ? 1 : 0) - (a.reference ? 1 : 0);
          return referenceDelta !== 0 ? referenceDelta : a.id.localeCompare(b.id);
        })
        .map((activity) => ({
          id: activity.id,
          name: activity.name,
          kind: activity.kind,
          tags: [...activity.tags],
          durationMinutes: activity.durationMinutes,
          ticketMinorPerAdult: activity.ticketMinorPerAdult,
          reference: activity.reference,
          anchor: { lat: activity.anchor.lat, lon: activity.anchor.lon },
        }));
      return pageOf("attractions", input, manifest, input, facts);
    },

    async searchEvents(input) {
      const manifest = await manifestFor(input.snapshotId);
      const provider = new SyntheticEventsProvider(source);
      const result = await provider.list({
        snapshotId: input.snapshotId,
        date: input.trip.sightseeingDate,
      });
      if (result.status !== "ok") {
        return providerFailure("events", input, manifest, result.status, result.reason, input);
      }
      const facts: EventCandidateFact[] = [...result.value]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((event) => ({
          id: event.id,
          name: event.name,
          kind: event.kind,
          date: event.date,
          startLocalTime: event.startLocalTime,
          durationMinutes: event.durationMinutes,
          ticketMinorPerAdult: event.ticketMinorPerAdult,
          anchor: { lat: event.anchor.lat, lon: event.anchor.lon },
        }));
      return pageOf("events", input, manifest, input, facts);
    },
  };
}
