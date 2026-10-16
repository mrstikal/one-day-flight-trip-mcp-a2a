import type { PoolClient } from "pg";
import {
  GENERATOR_VERSION,
  REFERENCE_VERSION,
  ROUTE_POLICY_VERSION,
  SCHEMA_VERSION,
  type RouteAirport,
  type RouteDestination,
  type RouteGroundCorridor,
  type RouteHub,
  type RouteInputs,
  type RouteIslandException,
  type SnapshotContext,
  type TripRecord,
} from "@odft/contracts";
import {
  loadCountryPolicy,
  resolveCityAirports,
  type CatchmentAirport,
  type ReviewedAirportLink,
} from "@odft/data";

/**
 * DB-aware reconstruction of the canonical `RouteInputs` (04-domain-model
 * section 4). Used by both the persisted approval and the independent booking
 * guard so a stale approval is detected from current reference evidence.
 */

type Queryable = Pick<PoolClient, "query">;

export const TRANSFER_POLICY = {
  originAccessMinutes: 45,
  departureBufferMinutes: 120,
  arrivalClearanceMinutes: 45,
  maxDestinationTransferMinutes: 120,
  minConnectionMinutes: 75,
  maxConnectionMinutes: 240,
} as const;

/** Reviewed connection hubs (05 section 5); geometry comes from the reference DB. */
export const HUB_IATAS = ["PRG", "FRA", "CDG", "AMS", "VIE"] as const;

interface AirportRow {
  id: string;
  iata: string;
  country_key: string;
  lat: number;
  lon: number;
  zone: string;
  zone_source: "geo-tz" | "override";
  eligible_origin: boolean;
  airport_type: string;
  scheduled_service: boolean;
}

interface CityRow {
  id: string;
  country_key: string;
  name: string;
  lat: number;
  lon: number;
  zone: string;
  coverage_flag: string;
}

function zoneResolved(zone: string): boolean {
  return zone.length > 0 && !zone.startsWith("Etc/");
}

function toRouteAirport(
  row: AirportRow,
  options: {
    transferMinutes: number;
    transferMode: "public_transport" | "taxi";
    eligibleDestination: boolean;
    reviewed: boolean;
    evidenceRefs: string[];
    metroCatchmentId: string | null;
  },
): RouteAirport {
  return {
    airportId: row.id,
    iata: row.iata,
    countryKey: row.country_key,
    lat: row.lat,
    lon: row.lon,
    zone: zoneResolved(row.zone) ? row.zone : null,
    zoneResolved: zoneResolved(row.zone),
    metroCatchmentId: options.metroCatchmentId,
    transferMinutes: options.transferMinutes,
    transferMode: options.transferMode,
    eligibleOrigin: row.eligible_origin,
    eligibleDestination: options.eligibleDestination,
    largeAirport: row.airport_type === "large_airport",
    reviewed: options.reviewed,
    evidenceRefs: options.evidenceRefs,
  };
}

async function originMetroCatchment(client: Queryable, airportId: string): Promise<string | null> {
  const result = await client.query<{ metro_catchment_id: string }>(
    `SELECT metro_catchment_id FROM odft_app.reference_city_airports
       WHERE airport_id = $1 ORDER BY reviewed DESC, transfer_minutes ASC LIMIT 1`,
    [airportId],
  );
  return result.rows[0]?.metro_catchment_id ?? null;
}

export async function buildRouteInputs(
  client: Queryable,
  trip: Pick<
    TripRecord,
    | "originAirportId"
    | "destinationCityId"
    | "destinationCountryKey"
    | "sightseeingDate"
    | "travelVariant"
    | "adults"
  >,
): Promise<RouteInputs | undefined> {
  const originResult = await client.query<AirportRow>(
    `SELECT id, iata, country_key, lat, lon, zone, zone_source, eligible_origin, airport_type, scheduled_service
       FROM odft_app.reference_airports WHERE id = $1`,
    [trip.originAirportId],
  );
  const originRow = originResult.rows[0];
  const cityResult = await client.query<CityRow>(
    `SELECT id, country_key, name, lat, lon, zone, coverage_flag FROM odft_app.reference_cities WHERE id = $1`,
    [trip.destinationCityId],
  );
  const cityRow = cityResult.rows[0];
  if (!originRow || !cityRow) {
    return undefined;
  }

  const originCatchment = await originMetroCatchment(client, originRow.id);

  // Reviewed destination links + nearby suitable airports (Phase 02 resolution).
  const reviewedResult = await client.query<{
    airport_id: string;
    metro_catchment_id: string;
    transfer_minutes: number;
    transfer_mode: "public_transport" | "taxi";
    eligible_destination: boolean;
    evidence_refs: unknown;
  }>(
    `SELECT airport_id, metro_catchment_id, transfer_minutes, transfer_mode, eligible_destination, evidence_refs
       FROM odft_app.reference_city_airports WHERE city_id = $1`,
    [cityRow.id],
  );
  const reviewed: ReviewedAirportLink[] = reviewedResult.rows.map((row) => ({
    airportId: row.airport_id,
    metroCatchmentId: row.metro_catchment_id,
    transferMinutes: row.transfer_minutes,
    transferMode: row.transfer_mode,
    eligibleDestination: row.eligible_destination,
    evidenceRefs: Array.isArray(row.evidence_refs) ? (row.evidence_refs as string[]) : [],
  }));

  const latDelta = 150 / 111;
  const lonDelta = 150 / (111 * Math.max(0.1, Math.cos((cityRow.lat * Math.PI) / 180)));
  const nearbyResult = await client.query<AirportRow>(
    `SELECT id, iata, country_key, lat, lon, zone, zone_source, eligible_origin, airport_type, scheduled_service
       FROM odft_app.reference_airports
      WHERE lat BETWEEN $1 AND $2 AND lon BETWEEN $3 AND $4
        AND scheduled_service = true AND zone NOT LIKE 'Etc/%' AND length(zone) > 0`,
    [
      cityRow.lat - latDelta,
      cityRow.lat + latDelta,
      cityRow.lon - lonDelta,
      cityRow.lon + lonDelta,
    ],
  );
  const nearbyById = new Map(nearbyResult.rows.map((row) => [row.id, row]));

  const candidates: CatchmentAirport[] = nearbyResult.rows.map((row) => ({
    id: row.id,
    lat: row.lat,
    lon: row.lon,
    zone: row.zone,
    scheduledService: row.scheduled_service,
  }));
  const resolution = resolveCityAirports(
    { id: cityRow.id, lat: cityRow.lat, lon: cityRow.lon },
    candidates,
    reviewed,
  );

  const destinationAirports: RouteAirport[] = [];
  for (const link of resolution.links) {
    const row = nearbyById.get(link.airportId);
    if (!row) {
      continue;
    }
    destinationAirports.push(
      toRouteAirport(row, {
        transferMinutes: link.transferMinutes,
        transferMode: link.transferMode,
        eligibleDestination: link.eligibleDestination,
        reviewed: link.reviewed,
        evidenceRefs: [...link.evidenceRefs],
        metroCatchmentId: link.metroCatchmentId,
      }),
    );
  }

  const evidenceResult = await client.query<{
    kind: string;
    origin_ref: string;
    destination_ref: string;
    minutes: number | null;
    evidence_refs: unknown;
  }>(
    `SELECT kind, origin_ref, destination_ref, minutes, evidence_refs
       FROM odft_app.reference_route_evidence ORDER BY id ASC`,
  );
  const groundCorridors: RouteGroundCorridor[] = [];
  const islandExceptions: RouteIslandException[] = [];
  for (const row of evidenceResult.rows) {
    const evidenceRefs = Array.isArray(row.evidence_refs) ? (row.evidence_refs as string[]) : [];
    if (row.kind === "ground_corridor" && row.minutes !== null) {
      groundCorridors.push({
        originRef: row.origin_ref,
        destinationRef: row.destination_ref,
        minutes: row.minutes,
        evidenceRefs,
      });
    } else if (row.kind === "island_exception") {
      islandExceptions.push({
        originRef: row.origin_ref,
        destinationRef: row.destination_ref,
        evidenceRefs,
      });
    }
  }

  const hubResult = await client.query<AirportRow>(
    `SELECT id, iata, country_key, lat, lon, zone, zone_source, eligible_origin, airport_type, scheduled_service
       FROM odft_app.reference_airports WHERE iata = ANY($1::text[])`,
    [[...HUB_IATAS]],
  );
  const hubAirports: RouteHub[] = hubResult.rows
    .filter((row) => zoneResolved(row.zone))
    .map((row) => ({ iata: row.iata, lat: row.lat, lon: row.lon, zone: row.zone }));

  const policy = loadCountryPolicy();
  const manifestResult = await client.query<{ version: string | null }>(
    `SELECT md5(string_agg(source || ':' || sha256 || ':' || COALESCE(revision, ''), ',' ORDER BY source)) AS version
       FROM odft_app.reference_manifests`,
  );
  const referenceVersion = manifestResult.rows[0]?.version ?? REFERENCE_VERSION;
  const origin = toRouteAirport(originRow, {
    transferMinutes: 0,
    transferMode: "public_transport",
    eligibleDestination: false,
    reviewed: true,
    evidenceRefs: [],
    metroCatchmentId: originCatchment,
  });
  const destinationCatchments = new Set(
    resolution.links.filter((link) => link.reviewed).map((link) => link.metroCatchmentId),
  );
  const destinationCatchment =
    destinationCatchments.size === 1 ? ([...destinationCatchments][0] ?? null) : null;
  const destination: RouteDestination = {
    countryKey: cityRow.country_key,
    cityId: cityRow.id,
    name: cityRow.name,
    lat: cityRow.lat,
    lon: cityRow.lon,
    zone: zoneResolved(cityRow.zone) ? cityRow.zone : null,
    zoneResolved: zoneResolved(cityRow.zone),
    metroCatchmentId: destinationCatchment,
    isCurated: cityRow.coverage_flag === "curated_landmarks",
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    routePolicyVersion: ROUTE_POLICY_VERSION,
    generatorVersion: GENERATOR_VERSION,
    referenceVersion,
    origin,
    destination,
    originKnown: true,
    destinationKnown: true,
    destinationAirports,
    groundCorridors,
    islandExceptions,
    curatedDirectPairs: policy.curatedDirectPairs.map(
      ([from, to]) => [from, to] as [string, string],
    ),
    hubAirports,
    sightseeingDate: trip.sightseeingDate,
    travelVariant: trip.travelVariant,
    adults: trip.adults,
    transfer: TRANSFER_POLICY,
  } satisfies RouteInputs;
}

/** Deterministic city size factor used by synthetic generation (05 section 8). */
const CURATED_CITY_FACTORS: Readonly<Record<string, number>> = {
  Paris: 1.3,
  Barcelona: 1.1,
};

/**
 * Build the snapshot generation context from the live trip and its route inputs.
 * Reads the reference city row for the display name, coverage, and size factor.
 */
export async function buildSnapshotContext(
  client: Queryable,
  trip: Pick<
    TripRecord,
    | "destinationCityId"
    | "destinationCountryKey"
    | "sightseeingDate"
    | "travelVariant"
    | "adults"
  >,
  inputs: RouteInputs,
): Promise<SnapshotContext> {
  const cityResult = await client.query<{ name: string; coverage_flag: string }>(
    `SELECT name, coverage_flag FROM odft_app.reference_cities WHERE id = $1`,
    [trip.destinationCityId],
  );
  const row = cityResult.rows[0];
  const cityZone = inputs.destination.zone ?? "UTC";
  return {
    destinationCityId: trip.destinationCityId,
    countryKey: trip.destinationCountryKey,
    cityName: row?.name ?? "City",
    center: { lat: inputs.destination.lat, lon: inputs.destination.lon },
    envelopeRadiusKm: 16,
    cityZone,
    cityFactor: CURATED_CITY_FACTORS[row?.name ?? ""] ?? 1.0,
    sightseeingDate: trip.sightseeingDate,
    travelVariant: trip.travelVariant,
    adults: trip.adults,
    isCurated: row?.coverage_flag === "curated_landmarks",
    referenceVersion: REFERENCE_VERSION,
  };
}
