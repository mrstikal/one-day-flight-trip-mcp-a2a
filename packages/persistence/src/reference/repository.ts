import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import {
  airportRefSchema,
  cityAirportLinkSchema,
  cityRefSchema,
  countryRefSchema,
  landmarkSchema,
  manifestSchema,
  normalizeSearchKey,
  resolveCatchment as resolveCatchmentPure,
  resolveCityAirports,
  routeEvidenceSchema,
  type AirportRef,
  type CatchmentAirport,
  type CityAirportLink,
  type CityRef,
  type CountryRef,
  type CoverageFlag,
  type Landmark,
  type ReferenceManifest,
  type ReviewedAirportLink,
  type RouteEvidence,
} from "@odft/data";

/**
 * Read-only reference lookups and the idempotent NDJSON loader.
 *
 * All lookups are read-only, deterministic, server-side, and never geocode
 * online. The loader is the only write path and is invoked explicitly (never at
 * application startup).
 */

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(MODULE_DIR, "..", "..", "..", "..");
const DATA_DIR = join(REPO_ROOT, "data", "reference");
const MANIFEST_DIR = join(REPO_ROOT, "data", "manifests");

export const DATASET_LIMITATION =
  "cities15000 covers places above roughly 15,000 people and capitals; smaller places may be absent.";

/** Escape LIKE wildcards so user input is treated literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

async function readNdjson<T>(path: string, parse: (row: unknown) => T): Promise<T[]> {
  const content = await readFile(path, "utf8");
  const rows: T[] = [];
  for (const line of content.split("\n")) {
    if (line.trim().length > 0) {
      rows.push(parse(JSON.parse(line) as unknown));
    }
  }
  return rows;
}

async function readManifests(): Promise<ReferenceManifest[]> {
  const names = (await readdir(MANIFEST_DIR)).filter(
    (name) => name.endsWith(".json") && name !== "index.json",
  );
  const manifests: ReferenceManifest[] = [];
  for (const name of [...names].sort()) {
    manifests.push(manifestSchema.parse(JSON.parse(await readFile(join(MANIFEST_DIR, name), "utf8"))));
  }
  return manifests;
}

export interface LoadResult {
  readonly countries: number;
  readonly cities: number;
  readonly airports: number;
  readonly cityAirports: number;
  readonly landmarks: number;
  readonly routeEvidence: number;
  readonly manifests: number;
}

/**
 * Upsert the committed NDJSON reference assets into PostgreSQL. Running it twice
 * does not duplicate rows (all upserts are keyed by primary key).
 */
export async function loadReferenceData(pool: Pool): Promise<LoadResult> {
  const countries = await readNdjson(join(DATA_DIR, "countries.ndjson"), (row) =>
    countryRefSchema.parse(row),
  );
  const cities = await readNdjson(join(DATA_DIR, "cities.ndjson"), (row) => cityRefSchema.parse(row));
  const airports = await readNdjson(join(DATA_DIR, "airports.ndjson"), (row) =>
    airportRefSchema.parse(row),
  );
  const cityAirports = await readNdjson(join(DATA_DIR, "city-airports.ndjson"), (row) =>
    cityAirportLinkSchema.parse(row),
  );
  const landmarks = await readNdjson(join(DATA_DIR, "landmarks.ndjson"), (row) =>
    landmarkSchema.parse(row),
  );
  const routeEvidence = await readNdjson(join(DATA_DIR, "route-evidence.ndjson"), (row) =>
    routeEvidenceSchema.parse(row),
  );
  const manifests = await readManifests();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const country of countries) {
      await client.query(
        `INSERT INTO odft_app.reference_countries (country_key, name, admitted, extension, policy_note)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (country_key) DO UPDATE SET
           name = EXCLUDED.name, admitted = EXCLUDED.admitted,
           extension = EXCLUDED.extension, policy_note = EXCLUDED.policy_note`,
        [country.countryKey, country.name, country.admitted, country.extension, country.policyNote ?? null],
      );
    }

    for (const city of cities) {
      await client.query(
        `INSERT INTO odft_app.reference_cities
           (id, country_key, name, ascii_name, lat, lon, zone, coverage_flag, population, search_key, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
         ON CONFLICT (id) DO UPDATE SET
           country_key = EXCLUDED.country_key, name = EXCLUDED.name, ascii_name = EXCLUDED.ascii_name,
           lat = EXCLUDED.lat, lon = EXCLUDED.lon, zone = EXCLUDED.zone,
           coverage_flag = EXCLUDED.coverage_flag, population = EXCLUDED.population,
           search_key = EXCLUDED.search_key, updated_at = now()`,
        [city.id, city.countryKey, city.name, city.asciiName, city.lat, city.lon, city.zone, city.coverage, city.population, city.searchKey],
      );
    }

    for (const airport of airports) {
      await client.query(
        `INSERT INTO odft_app.reference_airports
           (id, iata, icao, name, country_key, municipality, lat, lon, zone, zone_source, zone_evidence,
            zone_override_reason, eligible_origin, airport_type, scheduled_service, search_key, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
         ON CONFLICT (id) DO UPDATE SET
           iata = EXCLUDED.iata, icao = EXCLUDED.icao, name = EXCLUDED.name,
           country_key = EXCLUDED.country_key, municipality = EXCLUDED.municipality,
           lat = EXCLUDED.lat, lon = EXCLUDED.lon, zone = EXCLUDED.zone,
           zone_source = EXCLUDED.zone_source, zone_evidence = EXCLUDED.zone_evidence,
           zone_override_reason = EXCLUDED.zone_override_reason, eligible_origin = EXCLUDED.eligible_origin,
           airport_type = EXCLUDED.airport_type, scheduled_service = EXCLUDED.scheduled_service,
           search_key = EXCLUDED.search_key, updated_at = now()`,
        [airport.id, airport.iata, airport.icao ?? null, airport.name, airport.countryKey, airport.municipality ?? null, airport.lat, airport.lon, airport.zone, airport.zoneSource, airport.zoneEvidence, airport.zoneOverrideReason ?? null, airport.eligibleOrigin, airport.airportType, airport.scheduledService, airport.searchKey],
      );
    }

    for (const link of cityAirports) {
      await client.query(
        `INSERT INTO odft_app.reference_city_airports
           (city_id, airport_id, metro_catchment_id, transfer_minutes, transfer_mode, eligible_destination, reviewed, evidence_refs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         ON CONFLICT (city_id, airport_id) DO UPDATE SET
           metro_catchment_id = EXCLUDED.metro_catchment_id, transfer_minutes = EXCLUDED.transfer_minutes,
           transfer_mode = EXCLUDED.transfer_mode, eligible_destination = EXCLUDED.eligible_destination,
           reviewed = EXCLUDED.reviewed, evidence_refs = EXCLUDED.evidence_refs`,
        [link.cityId, link.airportId, link.metroCatchmentId, link.transferMinutes, link.transferMode, link.eligibleDestination, link.reviewed, JSON.stringify(link.evidenceRefs)],
      );
    }

    for (const landmark of landmarks) {
      await client.query(
        `INSERT INTO odft_app.reference_landmarks
           (id, city_id, name, lat, lon, source, source_id, source_url, verified, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
         ON CONFLICT (id) DO UPDATE SET
           city_id = EXCLUDED.city_id, name = EXCLUDED.name, lat = EXCLUDED.lat, lon = EXCLUDED.lon,
           source = EXCLUDED.source, source_id = EXCLUDED.source_id, source_url = EXCLUDED.source_url,
           verified = EXCLUDED.verified, updated_at = now()`,
        [landmark.id, landmark.cityId, landmark.name, landmark.lat, landmark.lon, landmark.source, landmark.sourceId, landmark.sourceUrl, landmark.verified],
      );
    }

    for (const evidence of routeEvidence) {
      await client.query(
        `INSERT INTO odft_app.reference_route_evidence
           (id, kind, origin_ref, destination_ref, minutes, details, evidence_refs)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           kind = EXCLUDED.kind, origin_ref = EXCLUDED.origin_ref, destination_ref = EXCLUDED.destination_ref,
           minutes = EXCLUDED.minutes, details = EXCLUDED.details, evidence_refs = EXCLUDED.evidence_refs`,
        [evidence.id, evidence.kind, evidence.originRef, evidence.destinationRef, evidence.minutes ?? null, evidence.details ?? null, JSON.stringify(evidence.evidenceRefs)],
      );
    }

    for (const manifest of manifests) {
      await client.query(
        `INSERT INTO odft_app.reference_manifests
           (source, url, retrieved_at, revision, sha256, license, license_url, transform_version,
            record_count, rejected_count, rejected_report, attribution, loaded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12, now())
         ON CONFLICT (source) DO UPDATE SET
           url = EXCLUDED.url, retrieved_at = EXCLUDED.retrieved_at, revision = EXCLUDED.revision,
           sha256 = EXCLUDED.sha256, license = EXCLUDED.license, license_url = EXCLUDED.license_url,
           transform_version = EXCLUDED.transform_version, record_count = EXCLUDED.record_count,
           rejected_count = EXCLUDED.rejected_count, rejected_report = EXCLUDED.rejected_report,
           attribution = EXCLUDED.attribution, loaded_at = now()`,
        [manifest.source, manifest.url, manifest.retrievedAt, manifest.revision ?? null, manifest.sha256, manifest.license, manifest.licenseUrl ?? null, manifest.transformVersion, manifest.recordCount, manifest.rejectedCount, JSON.stringify(manifest.rejectedReport), manifest.attribution ?? null],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return {
    countries: countries.length,
    cities: cities.length,
    airports: airports.length,
    cityAirports: cityAirports.length,
    landmarks: landmarks.length,
    routeEvidence: routeEvidence.length,
    manifests: manifests.length,
  };
}

interface CountryRow {
  country_key: string;
  name: string;
  extension: boolean;
  policy_note: string | null;
}

function toCountryRef(row: CountryRow): CountryRef {
  return {
    countryKey: row.country_key,
    name: row.name,
    admitted: true,
    extension: row.extension,
    ...(row.policy_note ? { policyNote: row.policy_note } : {}),
  };
}

/** Search admitted countries by name or key. */
export async function searchCountries(pool: Pool, q: string, limit = 20): Promise<CountryRef[]> {
  const needle = normalizeSearchKey(q);
  const result = await pool.query<CountryRow>(
    `SELECT country_key, name, extension, policy_note
       FROM odft_app.reference_countries
      WHERE admitted = true
        AND ($1 = '' OR lower(name) LIKE '%' || $1 || '%' ESCAPE '\\'
                     OR lower(country_key) LIKE $1 || '%' ESCAPE '\\')
      ORDER BY name ASC
      LIMIT $2`,
    [escapeLike(needle), Math.max(1, Math.min(limit, 50))],
  );
  return result.rows.map(toCountryRef);
}

export interface CitySearchInput {
  readonly countryKey: string;
  readonly q: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface CitySearchResult {
  readonly items: CityRef[];
  readonly nextCursor?: string;
  readonly datasetLimitation?: string;
}

interface CityRow {
  id: string;
  country_key: string;
  name: string;
  ascii_name: string;
  lat: number;
  lon: number;
  zone: string;
  coverage_flag: CoverageFlag;
  population: number;
  search_key: string;
}

function toCityRef(row: CityRow): CityRef {
  return {
    id: row.id,
    countryKey: row.country_key,
    name: row.name,
    asciiName: row.ascii_name,
    lat: row.lat,
    lon: row.lon,
    zone: row.zone,
    coverage: row.coverage_flag,
    population: row.population,
    searchKey: row.search_key,
  };
}

/** Search admitted cities in a country; never invents a city. */
export async function searchCities(pool: Pool, input: CitySearchInput): Promise<CitySearchResult> {
  const limit = Math.max(1, Math.min(input.limit, 50));
  const offset = input.cursor ? Math.max(0, Number.parseInt(input.cursor, 10) || 0) : 0;
  const needle = normalizeSearchKey(input.q);
  const result = await pool.query<CityRow>(
    `SELECT id, country_key, name, ascii_name, lat, lon, zone, coverage_flag, population, search_key
       FROM odft_app.reference_cities
      WHERE country_key = $1 AND ($2 = '' OR search_key LIKE '%' || $2 || '%' ESCAPE '\\')
      ORDER BY search_key ASC, population DESC, id ASC
      LIMIT $3 OFFSET $4`,
    [input.countryKey, escapeLike(needle), limit + 1, offset],
  );
  const rows = result.rows.slice(0, limit);
  const items = rows.map(toCityRef);
  const hasMore = result.rows.length > limit;
  const response: CitySearchResult = {
    items,
    ...(hasMore ? { nextCursor: String(offset + limit) } : {}),
    ...(items.length === 0 && needle.length > 0 ? { datasetLimitation: DATASET_LIMITATION } : {}),
  };
  return response;
}

export interface AirportSearchInput {
  readonly q: string;
  readonly cursor?: string;
  readonly limit: number;
  readonly scope: "origin";
}

export interface AirportSearchResult {
  readonly items: AirportRef[];
  readonly nextCursor?: string;
}

interface AirportRow {
  id: string;
  iata: string;
  icao: string | null;
  name: string;
  country_key: string;
  municipality: string | null;
  lat: number;
  lon: number;
  zone: string;
  zone_source: "geo-tz" | "override";
  zone_evidence: string;
  zone_override_reason: string | null;
  eligible_origin: boolean;
  airport_type: string;
  scheduled_service: boolean;
  search_key: string;
}

function toAirportRef(row: AirportRow): AirportRef {
  return {
    id: row.id,
    iata: row.iata,
    ...(row.icao ? { icao: row.icao } : {}),
    name: row.name,
    countryKey: row.country_key,
    ...(row.municipality ? { municipality: row.municipality } : {}),
    lat: row.lat,
    lon: row.lon,
    zone: row.zone,
    zoneSource: row.zone_source,
    zoneEvidence: row.zone_evidence,
    ...(row.zone_override_reason ? { zoneOverrideReason: row.zone_override_reason } : {}),
    eligibleOrigin: row.eligible_origin,
    airportType: row.airport_type,
    scheduledService: row.scheduled_service,
    searchKey: row.search_key,
  };
}

/** Search eligible origin airports. Only reviewed eligible origins are returned. */
export async function searchAirports(
  pool: Pool,
  input: AirportSearchInput,
): Promise<AirportSearchResult> {
  const limit = Math.max(1, Math.min(input.limit, 50));
  const offset = input.cursor ? Math.max(0, Number.parseInt(input.cursor, 10) || 0) : 0;
  const needle = normalizeSearchKey(input.q);
  const result = await pool.query<AirportRow>(
    `SELECT * FROM odft_app.reference_airports
      WHERE eligible_origin = true AND ($1 = '' OR search_key LIKE '%' || $1 || '%' ESCAPE '\\')
      ORDER BY search_key ASC, id ASC
      LIMIT $2 OFFSET $3`,
    [escapeLike(needle), limit + 1, offset],
  );
  const rows = result.rows.slice(0, limit);
  return {
    items: rows.map(toAirportRef),
    ...(result.rows.length > limit ? { nextCursor: String(offset + limit) } : {}),
  };
}

export interface CityAirportsResult {
  readonly links: CityAirportLink[];
  readonly limitation?: string;
}

interface ReviewedLinkRow {
  airport_id: string;
  metro_catchment_id: string;
  transfer_minutes: number;
  transfer_mode: "public_transport" | "taxi";
  eligible_destination: boolean;
  evidence_refs: unknown;
}

/** Resolve destination airports for a city (150 km / <= 3 airports / <= 120 min transfer). */
export async function getCityAirports(pool: Pool, cityId: string): Promise<CityAirportsResult> {
  const cityResult = await pool.query<CityRow>(`SELECT * FROM odft_app.reference_cities WHERE id = $1`, [
    cityId,
  ]);
  const cityRow = cityResult.rows[0];
  if (!cityRow) {
    return { links: [], limitation: `UNKNOWN_CITY: no reference city ${cityId}.` };
  }

  const reviewedResult = await pool.query<ReviewedLinkRow>(
    `SELECT airport_id, metro_catchment_id, transfer_minutes, transfer_mode, eligible_destination, evidence_refs
       FROM odft_app.reference_city_airports WHERE city_id = $1`,
    [cityId],
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
  const airportResult = await pool.query<AirportRow>(
    `SELECT * FROM odft_app.reference_airports
      WHERE lat BETWEEN $1 AND $2 AND lon BETWEEN $3 AND $4
        AND scheduled_service = true
        AND zone NOT LIKE 'Etc/%' AND length(zone) > 0`,
    [cityRow.lat - latDelta, cityRow.lat + latDelta, cityRow.lon - lonDelta, cityRow.lon + lonDelta],
  );
  const candidates: CatchmentAirport[] = airportResult.rows.map((row) => ({
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
  const links: CityAirportLink[] = resolution.links.map((link) => ({
    cityId: link.cityId,
    airportId: link.airportId,
    metroCatchmentId: link.metroCatchmentId,
    transferMinutes: link.transferMinutes,
    transferMode: link.transferMode,
    eligibleDestination: link.eligibleDestination,
    reviewed: link.reviewed,
    evidenceRefs: link.evidenceRefs,
  }));
  return resolution.limitation ? { links, limitation: resolution.limitation } : { links };
}

/** Whether the given airport ids belong to one reviewed metro catchment. */
export async function resolveCatchment(
  pool: Pool,
  airportIds: readonly string[],
): Promise<{ metroCatchmentId: string | null; sameCatchment: boolean }> {
  if (airportIds.length === 0) {
    return { metroCatchmentId: null, sameCatchment: false };
  }
  const result = await pool.query<{ airport_id: string; city_id: string; metro_catchment_id: string }>(
    `SELECT airport_id, city_id, metro_catchment_id FROM odft_app.reference_city_airports
      WHERE airport_id = ANY($1::text[]) ORDER BY airport_id, city_id`,
    [airportIds],
  );
  const links = result.rows.map((row) => ({
    cityId: row.city_id,
    airportId: row.airport_id,
    metroCatchmentId: row.metro_catchment_id,
    transferMinutes: 0,
    transferMode: "public_transport" as const,
    eligibleDestination: true,
    reviewed: true,
    evidenceRefs: [] as string[],
    distanceKm: 0,
  }));
  return resolveCatchmentPure(airportIds, links);
}

export interface CuratedLandmarksResult {
  readonly landmarks: Landmark[];
  readonly coverage: CoverageFlag;
}

export interface ReferenceCityRow {
  readonly id: string;
  readonly name: string;
  readonly countryKey: string;
  readonly lat: number;
  readonly lon: number;
  readonly coverageFlag: CoverageFlag;
}

/** The reference city row a discovery needs (name, center, coverage). */
export async function getReferenceCity(
  pool: Pick<PoolClient, "query">,
  cityId: string,
): Promise<ReferenceCityRow | undefined> {
  const result = await pool.query<{
    id: string;
    name: string;
    country_key: string;
    lat: number;
    lon: number;
    coverage_flag: CoverageFlag;
  }>(
    `SELECT id, name, country_key, lat, lon, coverage_flag
       FROM odft_app.reference_cities WHERE id = $1`,
    [cityId],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        name: row.name,
        countryKey: row.country_key,
        lat: row.lat,
        lon: row.lon,
        coverageFlag: row.coverage_flag,
      }
    : undefined;
}

/**
 * On-demand curation write (2026-10-13): persist Wikidata-discovered landmarks
 * for a city and mark it curated, in one transaction. Idempotent per landmark id
 * (`wikidata:Q<id>`), so a retried discovery inserts nothing new. Coordinates are
 * envelope-checked by the discovery client before they reach this write.
 */
export async function persistDiscoveredLandmarks(
  pool: Pool,
  input: {
    readonly cityId: string;
    readonly landmarks: readonly {
      readonly qid: string;
      readonly name: string;
      readonly lat: number;
      readonly lon: number;
    }[];
  },
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let inserted = 0;
    for (const landmark of input.landmarks) {
      const result = await client.query(
        `INSERT INTO odft_app.reference_landmarks
           (id, city_id, name, lat, lon, source, source_id, source_url, verified)
         VALUES ($1, $2, $3, $4, $5, 'wikidata', $6, $7, true)
         ON CONFLICT (id) DO NOTHING`,
        [
          `wikidata:${landmark.qid}`,
          input.cityId,
          landmark.name,
          landmark.lat,
          landmark.lon,
          landmark.qid,
          `https://www.wikidata.org/wiki/${landmark.qid}`,
        ],
      );
      inserted += result.rowCount ?? 0;
    }
    await client.query(
      `UPDATE odft_app.reference_cities
          SET coverage_flag = 'curated_landmarks', updated_at = now()
        WHERE id = $1`,
      [input.cityId],
    );
    await client.query("COMMIT");
    return inserted;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Mark a city's reference coverage (e.g. `insufficient_reference` after an empty discovery). */
export async function setReferenceCityCoverage(
  pool: Pool,
  cityId: string,
  coverage: CoverageFlag,
): Promise<void> {
  await pool.query(
    `UPDATE odft_app.reference_cities SET coverage_flag = $2, updated_at = now() WHERE id = $1`,
    [cityId, coverage],
  );
}

/** Curated landmarks for a city, plus its coverage flag. */
export async function getCuratedLandmarks(
  pool: Pick<PoolClient, "query">,
  cityId: string,
): Promise<CuratedLandmarksResult> {
  const cityResult = await pool.query<{ coverage_flag: CoverageFlag }>(
    `SELECT coverage_flag FROM odft_app.reference_cities WHERE id = $1`,
    [cityId],
  );
  const coverage = cityResult.rows[0]?.coverage_flag ?? "insufficient_reference";
  const result = await pool.query<{
    id: string;
    city_id: string;
    name: string;
    lat: number;
    lon: number;
    source: "wikidata";
    source_id: string;
    source_url: string;
  }>(`SELECT id, city_id, name, lat, lon, source, source_id, source_url FROM odft_app.reference_landmarks WHERE city_id = $1 ORDER BY name ASC`, [
    cityId,
  ]);
  const landmarks: Landmark[] = result.rows.map((row) => ({
    id: row.id,
    cityId: row.city_id,
    name: row.name,
    lat: row.lat,
    lon: row.lon,
    source: row.source,
    sourceId: row.source_id,
    sourceUrl: row.source_url,
    verified: true,
  }));
  return { landmarks, coverage };
}

export interface RouteEvidenceQuery {
  readonly kind?: RouteEvidence["kind"];
}

/** Read persisted route evidence (ground corridors, island exceptions, curated pairs). */
export async function listRouteEvidence(
  pool: Pool,
  query: RouteEvidenceQuery = {},
): Promise<RouteEvidence[]> {
  const result = await pool.query<{
    id: string;
    kind: RouteEvidence["kind"];
    origin_ref: string;
    destination_ref: string;
    minutes: number | null;
    details: string | null;
    evidence_refs: unknown;
  }>(
    `SELECT id, kind, origin_ref, destination_ref, minutes, details, evidence_refs
       FROM odft_app.reference_route_evidence
      WHERE ($1::text IS NULL OR kind = $1::text)
      ORDER BY id ASC`,
    [query.kind ?? null],
  );
  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    originRef: row.origin_ref,
    destinationRef: row.destination_ref,
    ...(row.minutes !== null ? { minutes: row.minutes } : {}),
    ...(row.details ? { details: row.details } : {}),
    evidenceRefs: Array.isArray(row.evidence_refs) ? (row.evidence_refs as string[]) : [],
  }));
}
