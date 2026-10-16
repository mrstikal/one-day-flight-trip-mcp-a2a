import type {
  ActivityRef,
  EventRef,
  FlightCombination,
  HotelOffer,
  RestaurantOffer,
  ScenarioDomain,
  ScenarioDomainHashes,
  SnapshotContent,
} from "@odft/contracts";
import { SNAPSHOT_MAX_BYTES } from "@odft/contracts";
import { fingerprint } from "@odft/domain";

/**
 * Per-domain and per-meal content hashes (05 section 7). `generatedAt` is
 * metadata and is excluded; a dinner extension therefore cannot change the
 * flight/hotel/breakfast/lunch hashes. Flight combinations are hashed without
 * their snapshot back-reference so a new snapshot version does not invalidate
 * the flight domain.
 */

function flightContent(combinations: readonly FlightCombination[]): unknown {
  return combinations
    .map(({ scenarioSnapshotId: _ignored, ...rest }) => rest)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function meals(restaurants: readonly RestaurantOffer[], meal: string): unknown {
  return restaurants
    .filter((offer) => offer.meal === meal)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function computeDomainHashes(content: SnapshotContent): ScenarioDomainHashes {
  return {
    flights: fingerprint(flightContent(content.flights)),
    hotels: fingerprint([...content.hotels].sort((a, b) => a.id.localeCompare(b.id))),
    breakfast: fingerprint(meals(content.restaurants, "breakfast")),
    lunch: fingerprint(meals(content.restaurants, "lunch")),
    dinner: fingerprint(meals(content.restaurants, "dinner")),
    activities: fingerprint([...content.activities].sort((a, b) => a.id.localeCompare(b.id))),
    events: fingerprint([...content.events].sort((a, b) => a.id.localeCompare(b.id))),
  };
}

export function materializedDomains(content: SnapshotContent): ScenarioDomain[] {
  const domains: ScenarioDomain[] = [];
  if (content.flights.length > 0) {
    domains.push("flights");
  }
  if (content.hotels.length > 0) {
    domains.push("hotels");
  }
  const mealDomains: ScenarioDomain[] = ["breakfast", "lunch", "dinner"];
  for (const domain of mealDomains) {
    if (content.restaurants.some((offer) => offer.meal === domain)) {
      domains.push(domain);
    }
  }
  if (content.activities.length > 0) {
    domains.push("activities");
  }
  if (content.events.length > 0) {
    domains.push("events");
  }
  return domains;
}

export interface SnapshotAdditions {
  readonly hotels?: readonly HotelOffer[];
  readonly restaurants?: readonly RestaurantOffer[];
  readonly activities?: readonly ActivityRef[];
  readonly events?: readonly EventRef[];
  readonly flights?: readonly FlightCombination[];
}

/** Append-only extension that preserves prior offer IDs and unrelated content. */
export function extendSnapshotContent(
  base: SnapshotContent,
  additions: SnapshotAdditions,
): SnapshotContent {
  return {
    ...base,
    flights: additions.flights ? [...base.flights, ...additions.flights] : base.flights,
    hotels: additions.hotels ? [...base.hotels, ...additions.hotels] : base.hotels,
    restaurants: additions.restaurants
      ? [...base.restaurants, ...additions.restaurants]
      : base.restaurants,
    activities: additions.activities
      ? [...base.activities, ...additions.activities]
      : base.activities,
    events: additions.events ? [...base.events, ...additions.events] : base.events,
  };
}

export function snapshotByteSize(content: SnapshotContent): number {
  return Buffer.byteLength(JSON.stringify(content), "utf8");
}

export function assertSnapshotBounded(content: SnapshotContent): void {
  const size = snapshotByteSize(content);
  if (size > SNAPSHOT_MAX_BYTES) {
    throw new Error(
      `snapshot content is ${size} bytes and exceeds the ${SNAPSHOT_MAX_BYTES}-byte cap`,
    );
  }
}
