import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  emptyOverlay,
  SyntheticAccommodationSearchProvider,
  SyntheticAttractionsProvider,
  SyntheticEventsProvider,
  SyntheticRestaurantSearchProvider,
  type BehaviorOverlay,
} from "@odft/data";
import { orderSearchCandidates, type BoundOfferReference } from "@odft/domain";
import {
  ARTIFACT_SERVICE_KEY_FOR_RESEARCH,
  SCENARIO_DOMAIN_FOR_RESEARCH,
  type Meal,
  type ResearchDomain,
  type SnapshotContent,
  type ResearchDomainStatus,
  type ResearchSearchIntent,
  type ScenarioDomain,
  type ServiceLevel,
  type TripPreferences,
} from "@odft/contracts";
import { getTrip } from "../trips.js";
import { recordRecommendationArtifact } from "../recommendations.js";
import type { OperationFencingContext } from "../operations/fencing.js";
import { loadOverlay, loadOverlaySummaries, recordFaultOutcome } from "./faults.js";
import {
  loadSnapshotContent,
  loadSnapshotManifest,
  PostgresSnapshotSource,
} from "./snapshots.js";
import { dinnerSlotAvailable } from "./trip-services.js";

/**
 * Phase 09 per-domain research and ranking services (03 section 4).
 *
 * One task researches exactly one domain against the active snapshot: the
 * persisted behavior overlay is consulted first, then the Phase 04 provider is
 * called, and an `ok` result writes one recommendation artifact keyed by the
 * deterministic input fingerprint. Failures are *values* (`unavailable`,
 * `retryable_error`, `unsupported`) so a failing domain never aborts its
 * siblings; only unexpected exceptions propagate to the graph superstep.
 *
 * Pool safety: providers acquire their own short-lived connections, so this
 * module never holds one across a provider call.
 */

const MEALS: readonly Meal[] = ["breakfast", "lunch", "dinner"];

export interface TripResearchInputs {
  readonly snapshotId: string;
  /** Deterministic research input fingerprint per research domain. */
  readonly fingerprints: Record<ResearchDomain, string>;
}

export interface ResearchDomainRequest {
  readonly tripId: string;
  readonly operationId: string;
  readonly domain: ResearchDomain;
  readonly attempt: number;
  readonly inputFingerprint: string;
  /** Phase 11: operation-scoped search intent (level override / cheaper). */
  readonly searchIntent?: ResearchSearchIntent | null;
}

export interface ResearchDomainOutcome {
  readonly domain: ResearchDomain;
  readonly status: ResearchDomainStatus;
  readonly artifactId: string | null;
  readonly offerIds: string[];
  /** True when a persisted simulation overlay caused this outcome. */
  readonly simulatedFailure: boolean;
  /** Safe short explanation for events/UI (never a provider payload). */
  readonly reason: string | null;
  readonly attempt: number;
}

export interface RankDomainCandidates {
  readonly domain: ResearchDomain;
  readonly artifactId: string;
  readonly inputFingerprint: string;
  readonly offerIds: readonly string[];
}

export interface RankedTripServices {
  readonly hotelOfferIds: string[];
  readonly mealOfferIds: {
    readonly breakfast: string[];
    readonly lunch: string[];
    readonly dinner: string[];
  };
  readonly activityIds: string[];
  readonly mealDefaults: {
    readonly breakfast: string | null;
    readonly lunch: string | null;
    readonly dinner: string | null;
  };
  readonly dinnerNotIncludedReason: string | null;
}

/** Canonical JSON SHA-256 (sorted keys), matching the domain fingerprint rule. */
function contentFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, entry) => {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const record = entry as Record<string, unknown>;
          return Object.keys(record)
            .sort()
            .reduce<Record<string, unknown>>((acc, key) => {
              acc[key] = record[key];
              return acc;
            }, {});
        }
        return entry;
      }),
      "utf8",
    )
    .digest("hex");
}

function effectiveLevel(preferences: TripPreferences, service: Meal | "hotel"): ServiceLevel {
  return preferences.serviceOverrides[service] ?? preferences.defaultServiceLevel;
}

type Queryable = { query: Pool["query"] };

const SEARCH_TARGET_DOMAIN: Readonly<Record<string, ResearchDomain>> = {
  hotel: "hotel",
  breakfast: "breakfast",
  lunch: "lunch",
  dinner: "dinner",
  activities: "attractions",
};

/**
 * Phase 11 operation-scoped level override for a `find_alternatives` request:
 *
 * - an explicit `level` searches that category without changing preferences;
 * - `cheaper` preserves the SELECTED/CONFIRMED offer's category even when the
 *   global effective preference has since changed, so a cheaper same-category
 *   alternative is actually comparable;
 * - any other objective/domain searches with the effective preference.
 */
async function searchLevelOverride(input: {
  readonly client: Queryable;
  readonly tripId: string;
  readonly snapshotId: string | undefined;
  readonly searchIntent: ResearchSearchIntent | null | undefined;
  readonly domain: ResearchDomain;
}): Promise<ServiceLevel | undefined> {
  const intent = input.searchIntent;
  if (!intent) {
    return undefined;
  }
  if ((SEARCH_TARGET_DOMAIN[intent.target] ?? null) !== input.domain) {
    return undefined;
  }
  if (intent.level !== null) {
    return intent.level;
  }
  if (intent.objective !== "cheaper" || input.domain === "attractions" || !input.snapshotId) {
    return undefined;
  }
  // Deterministic precedence: the confirmed reservation defines the bound
  // category; a plain selection is only the fallback.
  const bound = await input.client.query<{ offer_id: string }>(
    `SELECT offer_id FROM odft_app.reservations
      WHERE trip_id = $1 AND service_key = $2 AND status = 'confirmed'
      UNION ALL
     SELECT offer_id FROM odft_app.trip_selections
      WHERE trip_id = $1 AND service_key = $2
     ORDER BY offer_id`,
    [input.tripId, input.domain],
  );
  const confirmed = await input.client.query<{ offer_id: string }>(
    `SELECT offer_id FROM odft_app.reservations
      WHERE trip_id = $1 AND service_key = $2 AND status = 'confirmed'
      LIMIT 1`,
    [input.tripId, input.domain],
  );
  const offerId = confirmed.rows[0]?.offer_id ?? bound.rows[0]?.offer_id;
  if (!offerId) {
    return undefined;
  }
  const content = await loadSnapshotContent(input.client as Pool, input.snapshotId);
  if (!content) {
    return undefined;
  }
  if (input.domain === "hotel") {
    return content.hotels.find((offer) => offer.id === offerId)?.level;
  }
  return content.restaurants.find((offer) => offer.id === offerId)?.level;
}

function nightsForVariant(variant: "one_night" | "two_nights"): number {
  return variant === "one_night" ? 1 : 2;
}

function shiftDate(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map((part) => Number.parseInt(part, 10));
  const date = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days));
  return date.toISOString().slice(0, 10);
}

function nightDates(sightseeingDate: string, variant: "one_night" | "two_nights"): string[] {
  const checkIn = shiftDate(sightseeingDate, -1);
  return Array.from({ length: nightsForVariant(variant) }, (_unused, index) =>
    shiftDate(checkIn, index),
  );
}

/** Deterministic default: lowest party total, then lowest id. */
function pickDefault<T extends { id: string; partyTotalMinor: number }>(
  offers: readonly T[],
): string | null {
  if (offers.length === 0) {
    return null;
  }
  return (
    [...offers].sort((a, b) => a.partyTotalMinor - b.partyTotalMinor || a.id.localeCompare(b.id))[0]
      ?.id ?? null
  );
}

/** Deterministic candidate order: ascending party total, then id. */
function byPartyTotal<T extends { id: string; partyTotalMinor: number }>(offers: readonly T[]): T[] {
  return [...offers].sort((a, b) => a.partyTotalMinor - b.partyTotalMinor || a.id.localeCompare(b.id));
}

async function loadBoundOfferReference(
  client: Queryable,
  tripId: string,
  serviceKey: string,
  content: SnapshotContent,
): Promise<BoundOfferReference | undefined> {
  // The confirmed reservation carries its own party total.
  const confirmed = await client.query<{ offer_id: string; party_total_minor: string }>(
    `SELECT offer_id, party_total_minor::text AS party_total_minor
       FROM odft_app.reservations
      WHERE trip_id = $1 AND service_key = $2 AND status = 'confirmed'
      LIMIT 1`,
    [tripId, serviceKey],
  );
  const confirmedRow = confirmed.rows[0];
  if (confirmedRow) {
    return {
      offerId: confirmedRow.offer_id,
      partyTotalMinor: Number.parseInt(confirmedRow.party_total_minor, 10),
    };
  }
  // A selection stores no price; the offer in the active snapshot does.
  const selection = await client.query<{ offer_id: string }>(
    `SELECT offer_id FROM odft_app.trip_selections
      WHERE trip_id = $1 AND service_key = $2 LIMIT 1`,
    [tripId, serviceKey],
  );
  const offerId = selection.rows[0]?.offer_id;
  if (!offerId) {
    return undefined;
  }
  const offer =
    content.hotels.find((candidate) => candidate.id === offerId) ??
    content.restaurants.find((candidate) => candidate.id === offerId);
  return offer ? { offerId, partyTotalMinor: offer.partyTotalMinor } : undefined;
}

/** Whether a persisted overlay alters the provider behavior of one domain. */
export function overlayTargetsDomain(overlay: BehaviorOverlay, domain: ScenarioDomain): boolean {
  switch (overlay.mode) {
    case "provider_failure":
      return overlay.failureDomain === domain;
    case "hotels_unavailable":
      return domain === "hotels";
    case "no_flights":
      return domain === "flights";
    default:
      return false;
  }
}

/**
 * Deterministic per-domain research input fingerprints. Only the domain's own
 * content hash, the effective preferences it consumes, and the overlay that can
 * alter its provider behavior enter the digest, so extending the dinner inventory
 * cannot invalidate flights or other meals, while arming/re-arming a fault for a
 * domain does invalidate that domain's cached result.
 */
export async function loadTripResearchInputs(
  pool: Pool,
  tripId: string,
  operationId?: string,
  searchIntent?: ResearchSearchIntent | null,
): Promise<TripResearchInputs> {
  const client = await pool.connect();
  let trip: Awaited<ReturnType<typeof getTrip>>;
  let manifest: Awaited<ReturnType<typeof loadSnapshotManifest>>;
  let overlays: Awaited<ReturnType<typeof loadOverlaySummaries>>;
  let override: { readonly domain: ResearchDomain; readonly level: ServiceLevel } | undefined;
  try {
    trip = await getTrip(client, tripId);
    if (!trip) {
      throw new Error(`trip ${tripId} not found while loading research inputs`);
    }
    if (!trip.activeScenarioSnapshotId) {
      throw new Error(`trip ${tripId} has no active scenario snapshot`);
    }
    manifest = await loadSnapshotManifest(client, trip.activeScenarioSnapshotId);
    overlays = await loadOverlaySummaries(client, tripId, operationId);
    // One operation-scoped override can only target the searched domain.
    const overrideDomain = SEARCH_TARGET_DOMAIN[searchIntent?.target ?? ""];
    if (searchIntent && overrideDomain) {
      const level = await searchLevelOverride({
        client,
        tripId,
        snapshotId: manifest.snapshotId,
        searchIntent,
        domain: overrideDomain,
      });
      if (level) {
        override = { domain: overrideDomain, level };
      }
    }
  } finally {
    client.release();
  }
  const levelFor = (domain: "hotel" | Meal): ServiceLevel =>
    override && override.domain === domain ? override.level : effectiveLevel(trip.preferences, domain);
  const hashes = manifest.domainContentHashes;
  const preferences = trip.preferences;
  const interests = Object.entries(preferences.interests).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  const preferredTags = [...preferences.preferredActivityTags].sort();
  const minimumCounts = Object.entries(preferences.minimumActivityCounts)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .sort((a, b) => a[0].localeCompare(b[0]));
  const overlayFor = (domain: ScenarioDomain): { mode: string; overlayVersion: number } =>
    overlays[domain] ?? { mode: "normal", overlayVersion: 0 };
  const fingerprintFor = (domain: ResearchDomain, extra: Record<string, unknown>): string =>
    contentFingerprint({ schema: "research-input-v1", domain, ...extra });
  return {
    snapshotId: manifest.snapshotId,
    fingerprints: {
      hotel: fingerprintFor("hotel", {
        hash: hashes.hotels,
        level: levelFor("hotel"),
        adults: trip.adults,
        variant: trip.travelVariant,
        dates: nightDates(trip.sightseeingDate, trip.travelVariant),
        overlay: overlayFor("hotels"),
      }),
      breakfast: fingerprintFor("breakfast", {
        hash: hashes.breakfast,
        level: levelFor("breakfast"),
        adults: trip.adults,
        overlay: overlayFor("breakfast"),
      }),
      lunch: fingerprintFor("lunch", {
        hash: hashes.lunch,
        level: levelFor("lunch"),
        adults: trip.adults,
        overlay: overlayFor("lunch"),
      }),
      dinner: fingerprintFor("dinner", {
        hash: hashes.dinner,
        level: levelFor("dinner"),
        adults: trip.adults,
        overlay: overlayFor("dinner"),
      }),
      attractions: fingerprintFor("attractions", {
        hash: hashes.activities,
        cityId: trip.destinationCityId,
        interests,
        preferredTags,
        minimumCounts,
        overlay: overlayFor("activities"),
      }),
      events: fingerprintFor("events", {
        hash: hashes.events,
        cityId: trip.destinationCityId,
        date: trip.sightseeingDate,
        overlay: overlayFor("events"),
      }),
    },
  };
}

type DomainProviderOutcome =
  | { readonly status: "ok"; readonly offerIds: string[] }
  | {
      readonly status: "unavailable" | "retryable_error" | "unsupported";
      readonly reason: string;
    };

async function callDomainProvider(input: {
  readonly pool: Pool;
  readonly domain: ResearchDomain;
  readonly snapshotId: string;
  readonly trip: NonNullable<Awaited<ReturnType<typeof getTrip>>>;
  readonly behavior: BehaviorOverlay;
  readonly attempt: number;
  /** Phase 11: operation-scoped category override for the searched domain. */
  readonly levelOverride?: ServiceLevel;
}): Promise<DomainProviderOutcome> {
  const source = new PostgresSnapshotSource(input.pool);
  const trip = input.trip;
  const levelFor = (service: Meal | "hotel"): ServiceLevel =>
    input.levelOverride ?? effectiveLevel(trip.preferences, service);
  switch (input.domain) {
    case "hotel": {
      const provider = new SyntheticAccommodationSearchProvider(source, input.behavior);
      const result = await provider.search({
        snapshotId: input.snapshotId,
        level: levelFor("hotel"),
        adults: trip.adults,
        dates: nightDates(trip.sightseeingDate, trip.travelVariant),
        attempt: input.attempt,
      });
      if (result.status !== "ok") {
        return result;
      }
      // The one-night variant needs luggage storage after checkout during the
      // sightseeing day; budget hotels without it are not offerable.
      const offers =
        trip.travelVariant === "one_night"
          ? result.value.filter((offer) => offer.luggageStorage)
          : result.value;
      return { status: "ok", offerIds: byPartyTotal(offers).map((offer) => offer.id) };
    }
    case "breakfast":
    case "lunch":
    case "dinner": {
      const provider = new SyntheticRestaurantSearchProvider(source, input.behavior);
      const result = await provider.search({
        snapshotId: input.snapshotId,
        meal: input.domain,
        level: levelFor(input.domain),
        adults: trip.adults,
        attempt: input.attempt,
      });
      if (result.status !== "ok") {
        return result;
      }
      return { status: "ok", offerIds: byPartyTotal(result.value).map((offer) => offer.id) };
    }
    case "attractions": {
      const provider = new SyntheticAttractionsProvider(source);
      const result = await provider.list({
        snapshotId: input.snapshotId,
        cityId: trip.destinationCityId,
      });
      if (result.status !== "ok") {
        return result;
      }
      return { status: "ok", offerIds: result.value.map((activity) => activity.id) };
    }
    case "events": {
      const provider = new SyntheticEventsProvider(source);
      const result = await provider.list({
        snapshotId: input.snapshotId,
        date: trip.sightseeingDate,
      });
      if (result.status !== "ok") {
        return result;
      }
      return { status: "ok", offerIds: [...result.value].sort((a, b) => a.id.localeCompare(b.id)).map((event) => event.id) };
    }
  }
}

/** Research exactly one domain; known provider outcomes become tagged values. */
export async function researchTripDomain(
  pool: Pool,
  input: ResearchDomainRequest,
  fence?: OperationFencingContext,
): Promise<ResearchDomainOutcome> {
  const scenarioDomain = SCENARIO_DOMAIN_FOR_RESEARCH[input.domain];
  const loadClient = await pool.connect();
  let trip: Awaited<ReturnType<typeof getTrip>>;
  let snapshotId: string | undefined;
  let overlay: BehaviorOverlay | null;
  try {
    trip = await getTrip(loadClient, input.tripId);
    if (!trip) {
      throw new Error(`trip ${input.tripId} not found during domain research`);
    }
    snapshotId = trip.activeScenarioSnapshotId;
    if (!snapshotId) {
      throw new Error(`trip ${input.tripId} has no active scenario snapshot`);
    }
    overlay = await loadOverlay(loadClient, input.tripId, scenarioDomain, input.operationId);
  } finally {
    loadClient.release();
  }
  const behavior = overlay ?? emptyOverlay("normal");
  const simulated = overlay !== null && overlayTargetsDomain(overlay, scenarioDomain);

  // Phase 11: a `find_alternatives` search may target a different category than
  // the trip's effective preference (explicit level, or the bound offer's
  // category for a cheaper search).
  let levelOverride: ServiceLevel | undefined;
  if (input.searchIntent) {
    const overrideDomain = SEARCH_TARGET_DOMAIN[input.searchIntent.target];
    if (overrideDomain === input.domain) {
      const client = await pool.connect();
      try {
        levelOverride = await searchLevelOverride({
          client,
          tripId: input.tripId,
          snapshotId,
          searchIntent: input.searchIntent,
          domain: input.domain,
        });
      } finally {
        client.release();
      }
    }
  }

  const result = await callDomainProvider({
    pool,
    domain: input.domain,
    snapshotId,
    trip,
    behavior,
    attempt: input.attempt,
    ...(levelOverride ? { levelOverride } : {}),
  });

  if (simulated && overlay) {
    await recordFaultOutcome(
      pool,
      {
        tripId: input.tripId,
        operationId: input.operationId,
        domain: scenarioDomain,
        fault: overlay.mode,
        outcome: result.status,
        attempt: input.attempt,
        overlayVersion: overlay.overlayVersion,
        ...(result.status === "ok" ? {} : { reason: result.reason }),
      },
      fence,
    );
  }

  if (result.status !== "ok") {
    const injected = simulated || result.status === "retryable_error";
    const prefix = injected ? "Simulated failure: " : "";
    return {
      domain: input.domain,
      status: result.status,
      artifactId: null,
      offerIds: [],
      simulatedFailure: injected,
      reason: `${prefix}${result.reason}`.slice(0, 400),
      attempt: input.attempt,
    };
  }

  // The dinner artifact carries the deterministic no-slot reason already at
  // research time, so it survives paths that skip `rank_recommendations` (for
  // example a necessary-domain recovery decision).
  let dinnerNotIncludedReason: string | null = null;
  if (input.domain === "dinner") {
    const contentClient = await pool.connect();
    let content: Awaited<ReturnType<typeof loadSnapshotContent>>;
    try {
      content = await loadSnapshotContent(contentClient, snapshotId);
    } finally {
      contentClient.release();
    }
    if (content) {
      const slot = await dinnerSlotAvailable(pool, input.tripId, content);
      dinnerNotIncludedReason = slot.available ? null : slot.reason;
    }
  }

  const artifactId = await recordRecommendationArtifact(
    pool,
    {
      tripId: input.tripId,
      serviceKey: ARTIFACT_SERVICE_KEY_FOR_RESEARCH[input.domain],
      inputFingerprint: input.inputFingerprint,
      rankedOfferIds: result.offerIds,
      snapshotRefs: [snapshotId],
      explanation:
        input.domain === "dinner"
          ? (dinnerNotIncludedReason ?? "")
          : `Deterministic research (Phase 09, ${input.domain}).`,
    },
    fence,
  );
  return {
    domain: input.domain,
    status: "ok",
    artifactId,
    offerIds: result.offerIds,
    simulatedFailure: false,
    reason: null,
    attempt: input.attempt,
  };
}

/**
 * Deterministic ranking over the researched candidates: membership, category
 * eligibility, party size, dates/variant, and price are re-checked against the
 * active snapshot before the final order is persisted. This is the binding
 * order an optional recommendation-role reorder may only permute.
 */
export async function rankTripRecommendations(
  pool: Pool,
  input: {
    readonly tripId: string;
    readonly domains: readonly RankDomainCandidates[];
    /** Phase 11: operation-scoped level override / cheaper comparison. */
    readonly searchIntent?: ResearchSearchIntent | null;
  },
  fence?: OperationFencingContext,
): Promise<RankedTripServices> {
  const client = await pool.connect();
  let trip: Awaited<ReturnType<typeof getTrip>>;
  let snapshotId: string | undefined;
  let content: Awaited<ReturnType<typeof loadSnapshotContent>>;
  let override: { readonly domain: ResearchDomain; readonly level: ServiceLevel } | undefined;
  let bound: BoundOfferReference | undefined;
  let targetDomain: ResearchDomain | undefined;
  try {
    trip = await getTrip(client, input.tripId);
    if (!trip) {
      throw new Error(`trip ${input.tripId} not found during ranking`);
    }
    snapshotId = trip.activeScenarioSnapshotId;
    if (!snapshotId) {
      throw new Error(`trip ${input.tripId} has no active scenario snapshot`);
    }
    content = await loadSnapshotContent(client, snapshotId);
    if (!content) {
      throw new Error(`trip ${input.tripId} active snapshot is not materialized`);
    }
    const overrideDomain = SEARCH_TARGET_DOMAIN[input.searchIntent?.target ?? ""];
    targetDomain = overrideDomain;
    if (input.searchIntent && overrideDomain) {
      const level = await searchLevelOverride({
        client,
        tripId: input.tripId,
        snapshotId,
        searchIntent: input.searchIntent,
        domain: overrideDomain,
      });
      if (level) {
        override = { domain: overrideDomain, level };
      }
      if (overrideDomain !== "attractions" && input.searchIntent.objective !== "match_preferences") {
        bound = await loadBoundOfferReference(client, input.tripId, overrideDomain, content);
      }
    }
  } finally {
    client.release();
  }
  if (!content) {
    throw new Error(`trip ${input.tripId} active snapshot is not materialized`);
  }
  const levelFor = (service: Meal | "hotel"): ServiceLevel =>
    override && override.domain === service
      ? override.level
      : effectiveLevel(trip.preferences, service);
  const byDomain = new Map(input.domains.map((domain) => [domain.domain, domain]));
  const candidateIds = (domain: ResearchDomain): Set<string> =>
    new Set(byDomain.get(domain)?.offerIds ?? []);
  const nights = nightsForVariant(trip.travelVariant);

  const hotelIds = candidateIds("hotel");
  const hotelOffers = content.hotels.filter(
    (offer) =>
      hotelIds.has(offer.id) &&
      offer.level === levelFor("hotel") &&
      offer.adults === trip.adults &&
      offer.nights === nights &&
      (trip.travelVariant !== "one_night" || offer.luggageStorage),
  );
  const objectiveFor = (domain: ResearchDomain): ResearchSearchIntent["objective"] | null =>
    targetDomain === domain ? (input.searchIntent?.objective ?? null) : null;
  const boundFor = (domain: ResearchDomain): BoundOfferReference | undefined =>
    targetDomain === domain ? bound : undefined;
  const hotelOfferIds = orderSearchCandidates(
    hotelOffers,
    objectiveFor("hotel"),
    await boundFor("hotel"),
  ).map((offer) => offer.id);

  const mealOfferIds: Record<Meal, string[]> = { breakfast: [], lunch: [], dinner: [] };
  const eligibleMeals: Record<Meal, { id: string; partyTotalMinor: number }[]> = {
    breakfast: [],
    lunch: [],
    dinner: [],
  };
  for (const meal of MEALS) {
    const ids = candidateIds(meal);
    const offers = content.restaurants.filter(
      (offer) =>
        ids.has(offer.id) &&
        offer.meal === meal &&
        offer.level === levelFor(meal) &&
        content.context.adults === trip.adults,
    );
    eligibleMeals[meal] = offers;
    mealOfferIds[meal] = orderSearchCandidates(offers, objectiveFor(meal), await boundFor(meal)).map(
      (offer) => offer.id,
    );
  }

  const activityIds = candidateIds("attractions");
  const activityOffers = content.activities.filter(
    (activity) => activityIds.has(activity.id) && activity.cityId === trip.destinationCityId,
  );
  const activityOrder = activityOffers.map((activity) => activity.id);

  const dinnerSlot = await dinnerSlotAvailable(pool, input.tripId, content);
  const mealDefaults = {
    breakfast: pickDefault(eligibleMeals.breakfast),
    lunch: pickDefault(eligibleMeals.lunch),
    dinner: dinnerSlot.available ? pickDefault(eligibleMeals.dinner) : null,
  };
  const dinnerNotIncludedReason = dinnerSlot.available ? null : dinnerSlot.reason;

  for (const domain of input.domains) {
    const rankedIds =
      domain.domain === "hotel"
        ? hotelOfferIds
        : domain.domain === "attractions"
          ? activityOrder
          : domain.domain === "breakfast" ||
              domain.domain === "lunch" ||
              domain.domain === "dinner"
            ? mealOfferIds[domain.domain]
            : [];
    // A targeted assistant search records its objective: the UI can then show
    // that the offers follow a custom request instead of a plain category
    // (match_preferences is the neutral refresh and stays unmarked).
    const objective = objectiveFor(domain.domain);
    const customSearch = objective !== null && objective !== "match_preferences" ? objective : null;
    await recordRecommendationArtifact(
      pool,
      {
        tripId: input.tripId,
        serviceKey: ARTIFACT_SERVICE_KEY_FOR_RESEARCH[domain.domain],
        inputFingerprint: domain.inputFingerprint,
        rankedOfferIds: rankedIds,
        snapshotRefs: [snapshotId],
        explanation:
          domain.domain === "dinner"
            ? (dinnerNotIncludedReason ?? "")
            : `Deterministic ranking (Phase 09, ${domain.domain}${customSearch ? `; custom search: ${customSearch}` : ""}).`,
      },
      fence,
    );
  }

  return {
    hotelOfferIds,
    mealOfferIds,
    activityIds: activityOrder,
    mealDefaults,
    dinnerNotIncludedReason,
  };
}
