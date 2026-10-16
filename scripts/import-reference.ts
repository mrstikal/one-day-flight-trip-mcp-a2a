import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { find as findZone } from "geo-tz/all";
import {
  AdmissionManifest,
  deriveCityCoverage,
  haversineKm,
  isOriginCandidateType,
  loadCountryPolicy,
  normalizeSearchKey,
  resolveZone,
  withinEnvelope,
} from "@odft/data";

/**
 * Explicit maintenance importer for offline geographic reference data.
 *
 * Downloads upstream sources, applies admission/quality gates, resolves airport
 * IANA zones at import time, and writes filtered NDJSON assets plus manifest and
 * license evidence. NEVER runs at application startup; normal startup performs
 * no downloads.
 *
 * Usage: npm run reference:import -- --source <all|geonames|ourairports|zones|catchments|landmarks|manifests> [--refresh]
 */

const execFileAsync = promisify(execFile);
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(MODULE_DIR, "..");
const DATA_DIR = join(REPO_ROOT, "data", "reference");
const MANIFEST_DIR = join(REPO_ROOT, "data", "manifests");
const CACHE_DIR = join(REPO_ROOT, ".cache", "reference-import");

let RETRIEVED_AT = new Date().toISOString().slice(0, 10);
const TRANSFORM_VERSION = "reference-import-v1";

const SOURCES = {
  geonamesCities: "https://download.geonames.org/export/dump/cities15000.zip",
  geonamesCountryInfo: "https://download.geonames.org/export/dump/countryInfo.txt",
  // ourairports.com/data was unreachable from the import environment; the
  // official OurAirports data mirror publishes byte-identical CSV files.
  ourairports: "https://davidmegginson.github.io/ourairports-data/airports.csv",
  ourairportsCountries: "https://davidmegginson.github.io/ourairports-data/countries.csv",
  ourairportsRegions: "https://davidmegginson.github.io/ourairports-data/regions.csv",
  geo_tz: "https://github.com/evansiroky/node-geo-tz",
  tzBoundary: "https://github.com/evansiroky/timezone-boundary-builder",
} as const;

const COUNTRY_NAME_FALLBACK: Record<string, string> = { XK: "Kosovo" };

const REVIEWED_METRO: Record<string, { metroCatchmentId: string; transferMinutes: number }> = {
  FCO: { metroCatchmentId: "rome", transferMinutes: 45 },
  CIA: { metroCatchmentId: "rome", transferMinutes: 40 },
  CDG: { metroCatchmentId: "paris", transferMinutes: 55 },
  ORY: { metroCatchmentId: "paris", transferMinutes: 45 },
  PRG: { metroCatchmentId: "prague", transferMinutes: 40 },
  BCN: { metroCatchmentId: "barcelona", transferMinutes: 35 },
  PMI: { metroCatchmentId: "palma", transferMinutes: 20 },
};

const REVIEWED_CITY_AIRPORTS: ReadonlyArray<{ city: string; country: string; iata: string }> = [
  { city: "Rome", country: "IT", iata: "FCO" },
  { city: "Rome", country: "IT", iata: "CIA" },
  { city: "Paris", country: "FR", iata: "CDG" },
  { city: "Paris", country: "FR", iata: "ORY" },
  { city: "Prague", country: "CZ", iata: "PRG" },
  { city: "Barcelona", country: "ES", iata: "BCN" },
  { city: "Palma", country: "ES", iata: "PMI" },
];

interface CityRow {
  id: string;
  countryKey: string;
  name: string;
  asciiName: string;
  lat: number;
  lon: number;
  zone: string;
  coverage: "curated_landmarks" | "generic_only" | "insufficient_reference";
  population: number;
  searchKey: string;
}

interface AirportBaseRow {
  id: string;
  iata: string;
  icao?: string;
  name: string;
  countryKey: string;
  municipality?: string;
  lat: number;
  lon: number;
  airportType: string;
  scheduledService: boolean;
  searchKey: string;
}

type RejectedReport = Map<string, number>;

function reject(report: RejectedReport, reason: string): void {
  report.set(reason, (report.get(reason) ?? 0) + 1);
}

function reportToRows(report: RejectedReport): { reason: string; count: number }[] {
  return [...report.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([reason, count]) => ({ reason, count }));
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function ensureDirs(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(MANIFEST_DIR, { recursive: true });
  await mkdir(CACHE_DIR, { recursive: true });
}

async function download(url: string, fileName: string, refresh: boolean): Promise<string> {
  const dest = join(CACHE_DIR, fileName);
  if (!refresh && existsSync(dest)) {
    return sha256File(dest);
  }
  const response = await fetch(url, {
    headers: { "user-agent": "odft-reference-importer/1.0 (demo project)" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
  return sha256File(dest);
}

async function* readLines(path: string): AsyncGenerator<string> {
  const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    yield line;
  }
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      out.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  out.push(current);
  return out;
}

function headerIndex(header: string[]): Map<string, number> {
  return new Map(header.map((name, index) => [name, index]));
}

async function writeNdjson(path: string, rows: Iterable<unknown>): Promise<number> {
  let count = 0;
  const stream = createWriteStream(path, "utf8");
  let streamError: Error | undefined;
  stream.on("error", (error: Error) => {
    streamError = error;
  });
  for (const row of rows) {
    stream.write(`${JSON.stringify(row)}\n`);
    count += 1;
  }
  await new Promise<void>((resolve, reject) => {
    stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
  });
  if (streamError) {
    throw streamError;
  }
  return count;
}

async function readNdjson<T>(path: string): Promise<T[]> {
  const rows: T[] = [];
  for await (const line of readLines(path)) {
    if (line.trim().length > 0) {
      rows.push(JSON.parse(line) as T);
    }
  }
  return rows;
}

async function writeManifest(name: string, manifest: unknown): Promise<void> {
  await writeFile(join(MANIFEST_DIR, `${name}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
}

// --- geonames ---------------------------------------------------------------

async function runGeonames(refresh: boolean): Promise<void> {
  const manifest = new AdmissionManifest(loadCountryPolicy());
  const zipSha = await download(SOURCES.geonamesCities, "cities15000.zip", refresh);
  const countryInfoSha = await download(SOURCES.geonamesCountryInfo, "countryInfo.txt", refresh);

  const zipPath = join(CACHE_DIR, "cities15000.zip");
  await execFileAsync("unzip", ["-o", zipPath, "-d", CACHE_DIR]);
  const citiesPath = join(CACHE_DIR, "cities15000.txt");

  const countryNames = new Map<string, string>();
  for await (const line of readLines(join(CACHE_DIR, "countryInfo.txt"))) {
    if (line.startsWith("#") || line.trim() === "") continue;
    const cols = line.split("\t");
    const code = cols[0];
    const name = cols[4];
    if (code && name) countryNames.set(code, name);
  }

  const curated = new Map(
    loadCountryPolicy().curatedCities.map((city) => [`${city.countryKey}:${city.name.toLowerCase()}`, city]),
  );
  const rejected: RejectedReport = new Map();
  const cities: CityRow[] = [];
  const emittedCountries = new Set<string>();

  for await (const line of readLines(citiesPath)) {
    if (line.trim() === "") continue;
    const cols = line.split("\t");
    const geonameId = cols[0];
    const name = cols[1];
    const asciiName = cols[2];
    const lat = Number(cols[4]);
    const lon = Number(cols[5]);
    const countryKey = cols[8];
    const population = Number(cols[14]) || 0;
    const zone = cols[17] ?? "";
    if (!geonameId || !name || !countryKey) {
      reject(rejected, "missing_required_field");
      continue;
    }
    if (!manifest.isAdmittedCountry(countryKey)) {
      reject(rejected, "out_of_scope_country");
      continue;
    }
    if (!manifest.isAdmittedCity(countryKey, name)) {
      reject(rejected, "partial_admission_city_excluded");
      continue;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      reject(rejected, "coordinates_out_of_range");
      continue;
    }
    const key = `${countryKey}:${name.toLowerCase()}`;
    const curatedMatch = curated.get(key);
    const coverage = deriveCityCoverage(Boolean(curatedMatch), zone);
    cities.push({
      id: `geonames:${geonameId}`,
      countryKey,
      name,
      asciiName: asciiName || name,
      lat,
      lon,
      zone,
      coverage,
      population,
      searchKey: normalizeSearchKey(name),
    });
    emittedCountries.add(countryKey);
  }

  const countries = [...emittedCountries]
    .sort()
    .map((countryKey) => {
      const note = manifest.extensionNote(countryKey) ?? manifest.partialAdmission(countryKey)?.note;
      return {
        countryKey,
        name: countryNames.get(countryKey) ?? COUNTRY_NAME_FALLBACK[countryKey] ?? countryKey,
        admitted: true as const,
        extension: countryKey === "XK",
        ...(note ? { policyNote: note } : {}),
      };
    });

  const cityCount = await writeNdjson(join(DATA_DIR, "cities.ndjson"), cities);
  await writeNdjson(join(DATA_DIR, "countries.ndjson"), countries);

  await writeManifest("geonames", {
    source: "geonames",
    url: SOURCES.geonamesCities,
    retrievedAt: RETRIEVED_AT,
    revision: `${RETRIEVED_AT}-cities15000`,
    sha256: zipSha,
    license: "CC BY 4.0 (GeoNames); attribution and transformation notice in data/manifests/licenses/geonames-cc-by.txt",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    transformVersion: TRANSFORM_VERSION,
    hashTarget: "downloaded cities15000.zip (upstream GeoNames artifact)",
    recordCount: cityCount,
    rejectedCount: reportToRows(rejected).reduce((sum, row) => sum + row.count, 0),
    rejectedReport: reportToRows(rejected),
    attribution: "Contains data from GeoNames (https://www.geonames.org/), licensed under CC BY 4.0.",
  });
  process.stdout.write(`geonames: ${cityCount} cities, ${countries.length} countries (countryInfo sha ${countryInfoSha.slice(0, 12)})\n`);
}

// --- ourairports + zones ----------------------------------------------------

async function loadCitiesAndAirports(): Promise<{ cities: CityRow[]; airports: AirportBaseRow[] }> {
  const cities = await readNdjson<CityRow>(join(DATA_DIR, "cities.ndjson"));
  const airports = await readNdjson<AirportBaseRow>(join(DATA_DIR, "airports.ndjson"));
  return { cities, airports };
}

function nearestCityZone(airport: AirportBaseRow, cities: CityRow[]): string | undefined {
  let best: { zone: string; distance: number } | undefined;
  for (const city of cities) {
    if (city.countryKey !== airport.countryKey) continue;
    const distance = haversineKm(airport, city);
    if (distance <= 75 && (!best || distance < best.distance)) {
      best = { zone: city.zone, distance };
    }
  }
  return best?.zone;
}

async function loadZoneOverrides(): Promise<Map<string, { zone: string; reason: string }>> {
  const path = join(DATA_DIR, "airport-zone-overrides.json");
  if (!existsSync(path)) return new Map();
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    overrides?: { iata: string; zone: string; reason: string }[];
  };
  return new Map((raw.overrides ?? []).map((o) => [o.iata, { zone: o.zone, reason: o.reason }]));
}

async function resolveAirportZones(): Promise<{
  airports: (AirportBaseRow & {
    zone: string;
    zoneSource: string;
    zoneEvidence: string;
    zoneOverrideReason?: string;
    eligibleOrigin: boolean;
  })[];
}> {
  const { cities, airports } = await loadCitiesAndAirports();
  const overrides = await loadZoneOverrides();

  const resolved = airports.map((airport) => {
    const candidates = findZone(airport.lat, airport.lon);
    const cityZone = nearestCityZone(airport, cities);
    const zone = resolveZone(candidates, airport.lat, airport.lon, cityZone, overrides.get(airport.iata));
    const eligibleOrigin =
      isOriginCandidateType(airport.airportType) &&
      zone.eligibleOrigin &&
      (airport.airportType === "large_airport" || airport.scheduledService);
    // Build a clean object so a removed override cannot leave stale zone fields.
    return {
      id: airport.id,
      iata: airport.iata,
      ...(airport.icao ? { icao: airport.icao } : {}),
      name: airport.name,
      countryKey: airport.countryKey,
      ...(airport.municipality ? { municipality: airport.municipality } : {}),
      lat: airport.lat,
      lon: airport.lon,
      airportType: airport.airportType,
      scheduledService: airport.scheduledService,
      searchKey: airport.searchKey,
      zone: zone.zone,
      zoneSource: zone.zoneSource,
      zoneEvidence: zone.zoneEvidence,
      ...(zone.zoneOverrideReason ? { zoneOverrideReason: zone.zoneOverrideReason } : {}),
      eligibleOrigin,
    };
  });
  return { airports: resolved };
}

async function runOurairports(refresh: boolean): Promise<void> {
  const manifest = new AdmissionManifest(loadCountryPolicy());
  const airportsSha = await download(SOURCES.ourairports, "airports.csv", refresh);
  const countriesSha = await download(SOURCES.ourairportsCountries, "oa-countries.csv", refresh).catch(() => "");
  const regionsSha = await download(SOURCES.ourairportsRegions, "oa-regions.csv", refresh).catch(() => "");
  void regionsSha;

  const rejected: RejectedReport = new Map();
  const rows: AirportBaseRow[] = [];
  const seenIata = new Map<string, number>();
  const airportsPath = join(CACHE_DIR, "airports.csv");

  let index: Map<string, number> | undefined;
  for await (const line of readLines(airportsPath)) {
    if (!index) {
      index = headerIndex(parseCsvLine(line));
      continue;
    }
    if (line.trim() === "") continue;
    const cols = parseCsvLine(line);
    const get = (name: string): string => cols[index?.get(name) ?? -1] ?? "";
    const countryKey = get("iso_country");
    const iata = get("iata_code").toUpperCase();
    const type = get("type");
    const ident = get("ident");

    if (!/^[A-Z]{2}$/.test(countryKey)) {
      reject(rejected, "missing_country_key");
      continue;
    }
    if (!manifest.isAdmittedCountry(countryKey)) {
      reject(rejected, "out_of_scope_country");
      continue;
    }
    if (iata.length !== 3 || !/^[A-Z]{3}$/.test(iata)) {
      reject(rejected, "missing_or_invalid_iata");
      continue;
    }
    if (!manifest.isAdmittedAirport(countryKey, iata)) {
      reject(rejected, "partial_admission_airport_excluded");
      continue;
    }
    if (!isOriginCandidateType(type)) {
      reject(rejected, `ineligible_type:${type || "unknown"}`);
      continue;
    }
    const lat = Number(get("latitude_deg"));
    const lon = Number(get("longitude_deg"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      reject(rejected, "coordinates_out_of_range");
      continue;
    }
    const idNum = get("id");
    if (!/^\d+$/.test(idNum)) {
      reject(rejected, "missing_source_id");
      continue;
    }
    const name = get("name");
    const municipality = get("municipality");
    seenIata.set(iata, (seenIata.get(iata) ?? 0) + 1);
    rows.push({
      id: `ourairports:${idNum}`,
      iata,
      ...(ident && /^[A-Z0-9]{4}$/.test(ident) ? { icao: ident } : {}),
      name,
      countryKey,
      ...(municipality ? { municipality } : {}),
      lat,
      lon,
      airportType: type,
      scheduledService: get("scheduled_service").toLowerCase() === "yes",
      searchKey: normalizeSearchKey(`${name} ${municipality} ${iata}`),
    });
  }

  // Reject duplicate conflicting IATA codes entirely (report, never silently drop).
  const duplicates = new Set([...seenIata.entries()].filter(([, count]) => count > 1).map(([iata]) => iata));
  const kept = rows.filter((row) => {
    if (duplicates.has(row.iata)) {
      reject(rejected, `duplicate_iata:${row.iata}`);
      return false;
    }
    return true;
  });
  kept.sort((a, b) => a.id.localeCompare(b.id));

  await writeFile(
    join(CACHE_DIR, "airports.base.ndjson"),
    kept.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const count = await writeNdjson(join(DATA_DIR, "airports.ndjson"), kept);

  await writeManifest("ourairports", {
    source: "ourairports",
    url: SOURCES.ourairports,
    retrievedAt: RETRIEVED_AT,
    revision: `${RETRIEVED_AT}-ourairports`,
    sha256: airportsSha,
    license: "Public domain (OurAirports); credit retained voluntarily.",
    licenseUrl: "https://ourairports.com/data/",
    transformVersion: TRANSFORM_VERSION,
    hashTarget: "downloaded airports.csv (upstream OurAirports artifact)",
    recordCount: count,
    rejectedCount: reportToRows(rejected).reduce((sum, row) => sum + row.count, 0),
    rejectedReport: reportToRows(rejected),
    attribution: "Airport data from OurAirports (https://ourairports.com/data/), public domain.",
  });
  process.stdout.write(
    `ourairports: ${count} airports (countries sha ${countriesSha.slice(0, 12)})\n`,
  );
}

async function runZones(): Promise<void> {
  const { airports } = await resolveAirportZones();
  const count = await writeNdjson(join(DATA_DIR, "airports.ndjson"), airports);
  const airportsSha = await sha256File(join(DATA_DIR, "airports.ndjson"));
  const odblSha = await sha256File(join(MANIFEST_DIR, "licenses", "odbl-timezone.txt"));

  await writeManifest("geo-tz", {
    source: "geo-tz",
    url: SOURCES.geo_tz,
    retrievedAt: RETRIEVED_AT,
    revision: "8.1.9",
    sha256: airportsSha,
    license: "geo-tz code MIT; underlying boundary data ODbL (see data/manifests/licenses/odbl-timezone.txt).",
    licenseUrl: "https://github.com/evansiroky/node-geo-tz",
    transformVersion: TRANSFORM_VERSION,
    hashTarget: "derived data/reference/airports.ndjson zone-resolution output",
    recordCount: count,
    rejectedCount: 0,
    rejectedReport: [],
    attribution: "Airport zones resolved at import time with geo-tz 8.1.9 (ODbL boundary data).",
  });
  await writeManifest("tz-boundary-odbl", {
    source: "tz-boundary-odbl",
    url: SOURCES.tzBoundary,
    retrievedAt: RETRIEVED_AT,
    revision: "paired-with-geo-tz-8.1.9",
    sha256: odblSha,
    license: "ODbL v1.0 (boundary data). Not redistributed; only derived zone lookups and this notice are committed.",
    licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
    transformVersion: TRANSFORM_VERSION,
    hashTarget: "data/manifests/licenses/odbl-timezone.txt (committed license notice)",
    recordCount: 0,
    rejectedCount: 0,
    rejectedReport: [],
    attribution: "Contains data derived from OpenStreetMap contributors and timezone-boundary-builder, licensed under ODbL.",
  });
  process.stdout.write(`zones: resolved ${count} airports\n`);
}

// --- catchments -------------------------------------------------------------

async function runCatchments(): Promise<void> {
  const cities = await readNdjson<CityRow>(join(DATA_DIR, "cities.ndjson"));
  const airports = await readNdjson<AirportBaseRow & { zone: string; eligibleOrigin: boolean }>(
    join(DATA_DIR, "airports.ndjson"),
  );
  const byIata = new Map(airports.map((airport) => [airport.iata, airport]));
  const cityByNameCountry = new Map(
    cities.map((city) => [`${city.countryKey}:${normalizeSearchKey(city.name)}`, city]),
  );
  const evidenceRefs = (label: string): string[] => [`reviewed:${label}`];

  const links: Record<string, unknown>[] = [];
  for (const seed of REVIEWED_CITY_AIRPORTS) {
    const city = cityByNameCountry.get(`${seed.country}:${normalizeSearchKey(seed.city)}`);
    const airport = byIata.get(seed.iata);
    const metro = REVIEWED_METRO[seed.iata];
    if (!city || !airport || !metro) {
      throw new Error(`Reviewed link seed missing reference: ${seed.city}/${seed.iata}`);
    }
    const distanceKm = haversineKm(city, airport);
    if (distanceKm > 150 || airport.zone.startsWith("Etc/")) {
      throw new Error(
        `Reviewed link ${seed.city}/${seed.iata} is not defensible ` +
          `(distance ${distanceKm.toFixed(1)} km, zone ${airport.zone}).`,
      );
    }
    links.push({
      cityId: city.id,
      airportId: airport.id,
      metroCatchmentId: metro.metroCatchmentId,
      transferMinutes: metro.transferMinutes,
      transferMode: "public_transport",
      eligibleDestination: true,
      reviewed: true,
      evidenceRefs: evidenceRefs(`metro:${metro.metroCatchmentId}`),
    });
  }
  links.sort((a, b) => `${a.cityId}${a.airportId}`.localeCompare(`${b.cityId}${b.airportId}`));
  const linkCount = await writeNdjson(join(DATA_DIR, "city-airports.ndjson"), links);

  const budejovice = cityByNameCountry.get(`CZ:${normalizeSearchKey("České Budějovice")}`);
  if (!budejovice) {
    throw new Error("Ground-corridor evidence requires the reference city České Budějovice.");
  }
  const routeEvidence: Record<string, unknown>[] = [
    {
      id: "ground-corridor:prg-ceske-budejovice",
      kind: "ground_corridor",
      originRef: "airport:PRG",
      destinationRef: budejovice.id,
      minutes: 180,
      details:
        "Reviewed road/rail connected corridor. Conservative 180-minute ground estimate including access; not a current timetable.",
      evidenceRefs: evidenceRefs("ground-corridor:prg-cb"),
    },
    {
      id: "island-exception:bcn-pmi",
      kind: "island_exception",
      originRef: "airport:BCN",
      destinationRef: "airport:PMI",
      details:
        "Sea separation with no fixed road/rail link; reviewed plausible air connection despite ~202 km great-circle distance.",
      evidenceRefs: evidenceRefs("island:bcn-pmi"),
    },
  ];
  for (const [origin, destination] of loadCountryPolicy().curatedDirectPairs) {
    routeEvidence.push({
      id: `curated-direct:${origin}-${destination}`,
      kind: "curated_direct",
      originRef: `airport:${origin}`,
      destinationRef: `airport:${destination}`,
      evidenceRefs: evidenceRefs("curated-direct-pair"),
    });
  }
  await writeNdjson(join(DATA_DIR, "route-evidence.ndjson"), routeEvidence);
  process.stdout.write(`catchments: ${linkCount} reviewed links, ${routeEvidence.length} evidence records\n`);
}

// --- landmarks --------------------------------------------------------------

interface LandmarkSeed {
  name: string;
  qid: string;
  lat?: number;
  lon?: number;
}

/**
 * Reviewed landmark seeds. QIDs and coordinates were verified against Wikidata
 * (P625) and the reviewed city envelope when this importer was authored; the
 * importer re-verifies the coordinates against the envelope on every run and
 * only falls back to the live Wikidata API for seeds without coordinates.
 */
const LANDMARK_SEEDS: Record<string, LandmarkSeed[]> = {
  rome: [
    { name: "Colosseum", qid: "Q10285", lat: 41.890277777778, lon: 12.492222222222 },
    { name: "Trevi Fountain", qid: "Q185382", lat: 41.900932251961315, lon: 12.48331263850277 },
    { name: "Pantheon", qid: "Q99309", lat: 41.89861111111111, lon: 12.476944444444445 },
    { name: "Roman Forum", qid: "Q180212", lat: 41.8922, lon: 12.4852 },
    { name: "Galleria Borghese", qid: "Q841506", lat: 41.91421, lon: 12.492144 },
    { name: "Capitoline Museums", qid: "Q333906", lat: 41.893055555555556, lon: 12.482777777777777 },
    { name: "Villa Borghese gardens", qid: "Q678313", lat: 41.913647, lon: 12.485104 },
    { name: "Piazza Navona", qid: "Q463400", lat: 41.89871, lon: 12.47316 },
  ],
  paris: [
    { name: "Eiffel Tower", qid: "Q243", lat: 48.858296, lon: 2.294479 },
    { name: "Louvre Museum", qid: "Q19675", lat: 48.861111, lon: 2.335833 },
    { name: "Notre-Dame de Paris", qid: "Q2981", lat: 48.853, lon: 2.3498 },
    { name: "Musée d'Orsay", qid: "Q23402", lat: 48.859972, lon: 2.326527 },
    { name: "Musée de l'Orangerie", qid: "Q726781", lat: 48.86384535145145, lon: 2.322538337460585 },
    { name: "Jardin du Luxembourg", qid: "Q309458", lat: 48.846944444444446, lon: 2.337222222222222 },
    { name: "Tuileries Garden", qid: "Q818517", lat: 48.863888888889, lon: 2.3261111111111 },
    { name: "Banks of the Seine", qid: "Q2233532", lat: 48.85, lon: 2.35889 },
  ],
  barcelona: [
    { name: "Sagrada Família", qid: "Q48435", lat: 41.40369, lon: 2.17433 },
    { name: "Park Güell", qid: "Q212867", lat: 41.41361111111111, lon: 2.1527777777777777 },
    { name: "Casa Batlló", qid: "Q461371", lat: 41.39158, lon: 2.16492 },
    { name: "Museu Picasso", qid: "Q1050032", lat: 41.385216, lon: 2.180893 },
    { name: "Museu Nacional d'Art de Catalunya", qid: "Q861252", lat: 41.368333333333, lon: 2.1533055555556 },
    { name: "Barceloneta", qid: "Q591874", lat: 41.3824734, lon: 2.1856404 },
    { name: "Parc de la Ciutadella", qid: "Q301135", lat: 41.388111, lon: 2.187517 },
    { name: "Gothic Quarter", qid: "Q17154", lat: 41.382777777778, lon: 2.1769444444444 },
  ],
};

let lastWdRequest = 0;

async function wdFetch(url: string): Promise<unknown | undefined> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const wait = Math.max(0, 320 - (Date.now() - lastWdRequest));
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastWdRequest = Date.now();
    const response = await fetch(url, {
      headers: { "user-agent": "odft-reference-importer/1.0 (demo project)" },
    });
    if (response.ok) {
      return response.json();
    }
    if (response.status === 429 || response.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      continue;
    }
    return undefined;
  }
  return undefined;
}

async function wikidataSearch(name: string): Promise<string[]> {
  const url =
    "https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&type=item&limit=5&search=" +
    encodeURIComponent(name);
  const data = (await wdFetch(url)) as { search?: { id: string }[] } | undefined;
  return (data?.search ?? []).map((entry) => entry.id);
}

async function wikidataCoordinates(qid: string): Promise<{ lat: number; lon: number; label?: string } | undefined> {
  const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims|labels&languages=en&ids=${qid}`;
  const data = (await wdFetch(url)) as
    | {
        entities?: Record<
          string,
          {
            labels?: Record<string, { value: string }>;
            claims?: { P625?: { mainsnak?: { datavalue?: { value?: { latitude: number; longitude: number } } } }[] };
          }
        >;
      }
    | undefined;
  const entity = data?.entities?.[qid];
  const value = entity?.claims?.P625?.[0]?.mainsnak?.datavalue?.value;
  if (!value) return undefined;
  return { lat: value.latitude, lon: value.longitude, label: entity?.labels?.en?.value };
}

async function runLandmarks(): Promise<void> {
  const cities = await readNdjson<CityRow>(join(DATA_DIR, "cities.ndjson"));
  const policy = loadCountryPolicy();
  const rejected: RejectedReport = new Map();
  const landmarks: Record<string, unknown>[] = [];
  const perCity: Record<string, number> = {};

  for (const curated of policy.curatedCities) {
    const city = cities.find(
      (candidate) => candidate.countryKey === curated.countryKey && candidate.name.toLowerCase() === curated.name.toLowerCase(),
    );
    if (!city) {
      throw new Error(`Curated city not found in cities.ndjson: ${curated.name}`);
    }
    const seeds = LANDMARK_SEEDS[curated.cityKey] ?? [];
    const envelope = {
      lat: curated.center.lat,
      lon: curated.center.lon,
      envelopeRadiusKm: curated.envelopeRadiusKm,
    };
    for (const seed of seeds) {
      let qid: string | undefined = seed.qid;
      let point: { lat: number; lon: number } | undefined =
        seed.lat !== undefined && seed.lon !== undefined ? { lat: seed.lat, lon: seed.lon } : undefined;
      if (!point) {
        for (const candidate of await wikidataSearch(seed.name)) {
          const coords = await wikidataCoordinates(candidate);
          if (coords && withinEnvelope(coords, envelope)) {
            qid = candidate;
            point = { lat: coords.lat, lon: coords.lon };
            break;
          }
        }
      }
      if (!qid || !point) {
        reject(rejected, `landmark_unresolved:${seed.name}`);
        continue;
      }
      if (!withinEnvelope(point, envelope)) {
        reject(rejected, `landmark_outside_envelope:${seed.name}`);
        continue;
      }
      landmarks.push({
        id: `wikidata:${qid}`,
        cityId: city.id,
        name: seed.name,
        lat: point.lat,
        lon: point.lon,
        source: "wikidata",
        sourceId: qid,
        sourceUrl: `https://www.wikidata.org/wiki/${qid}`,
        verified: true,
      });
      perCity[curated.cityKey] = (perCity[curated.cityKey] ?? 0) + 1;
    }
  }

  const count = await writeNdjson(join(DATA_DIR, "landmarks.ndjson"), landmarks);
  const landmarksSha = await sha256File(join(DATA_DIR, "landmarks.ndjson"));
  await writeManifest("wikidata-landmarks", {
    source: "wikidata-landmarks",
    url: "https://www.wikidata.org/",
    retrievedAt: RETRIEVED_AT,
    revision: `${RETRIEVED_AT}-wikidata`,
    sha256: landmarksSha,
    license: "CC0 1.0 (Wikidata structured data); source QIDs retained.",
    licenseUrl: "https://www.wikidata.org/wiki/Wikidata:Licensing",
    transformVersion: TRANSFORM_VERSION,
    hashTarget: "derived data/reference/landmarks.ndjson (reviewed, pinned QIDs and coordinates)",
    recordCount: count,
    rejectedCount: reportToRows(rejected).reduce((sum, row) => sum + row.count, 0),
    rejectedReport: reportToRows(rejected),
    attribution:
      "Landmark identity and coordinates from Wikidata (CC0 1.0). QIDs are reviewed and pinned in the importer; no network lookup is required to reproduce this asset.",
  });
  process.stdout.write(`landmarks: ${count} (${JSON.stringify(perCity)})\n`);
}

// --- manifests --------------------------------------------------------------

async function runManifests(): Promise<void> {
  const names = await readdir(MANIFEST_DIR);
  const jsonNames = names.filter((name) => name.endsWith(".json") && name !== "index.json").sort();
  const combined: Record<string, unknown> = {};
  for (const name of jsonNames) {
    combined[name.replace(/\.json$/, "")] = JSON.parse(
      await readFile(join(MANIFEST_DIR, name), "utf8"),
    ) as unknown;
  }
  await writeFile(join(MANIFEST_DIR, "index.json"), `${JSON.stringify(combined, null, 2)}\n`);
  process.stdout.write(`manifests: wrote index for ${jsonNames.length} manifests\n`);
}

// --- main -------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sourceIndex = args.indexOf("--source");
  const source = sourceIndex >= 0 ? args[sourceIndex + 1] : "all";
  const refresh = args.includes("--refresh");
  const retrievedIndex = args.indexOf("--retrieved-at");
  if (retrievedIndex >= 0 && args[retrievedIndex + 1]) {
    RETRIEVED_AT = args[retrievedIndex + 1] as string;
  }

  await ensureDirs();
  const runAll = source === "all";
  if (runAll || source === "geonames") await runGeonames(refresh);
  if (runAll || source === "ourairports") await runOurairports(refresh);
  if (runAll || source === "zones") await runZones();
  if (runAll || source === "catchments") await runCatchments();
  if (runAll || source === "landmarks") await runLandmarks();
  if (runAll || source === "manifests") await runManifests();
}

await main();
