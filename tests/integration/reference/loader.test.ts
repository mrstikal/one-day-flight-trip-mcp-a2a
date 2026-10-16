import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getCityAirports,
  getCuratedLandmarks,
  listRouteEvidence,
  loadReferenceData,
  resolveCatchment,
  runMigrations,
  searchAirports,
  searchCities,
  searchCountries,
  type LoadResult,
} from "@odft/persistence";

/** Phase 02 integration evidence: migration 0002 + idempotent loader + lookups. */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  throw new Error(
    "TEST_DATABASE_URL is required for integration tests. Start PostgreSQL " +
      "(docker compose up -d postgres) and provide TEST_DATABASE_URL.",
  );
}
if (process.env.DATABASE_URL && process.env.DATABASE_URL === TEST_DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL.");
}
const testDatabaseName = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "");
if (!testDatabaseName.endsWith("_test")) {
  throw new Error(
    `Refusing to run destructive integration tests against non-test database "${testDatabaseName}".`,
  );
}

const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });

const ROME = "geonames:3169070";
const PARIS = "geonames:2988507";
const FCO = "ourairports:4372";
const CIA = "ourairports:4370";
const CDG = "ourairports:4185";

let firstLoad: LoadResult;

beforeAll(async () => {
  await pool.query("DROP SCHEMA IF EXISTS odft_app CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS odft_checkpoint CASCADE");
  await runMigrations(pool);
  firstLoad = await loadReferenceData(pool);
});

afterAll(async () => {
  await pool.end();
});

describe("reference migration and loader", () => {
  it("creates the reference tables", async () => {
    for (const table of [
      "reference_countries",
      "reference_cities",
      "reference_airports",
      "reference_city_airports",
      "reference_landmarks",
      "reference_route_evidence",
      "reference_manifests",
    ]) {
      const result = await pool.query<{ present: boolean }>(
        "SELECT to_regclass($1) IS NOT NULL AS present",
        [`odft_app.${table}`],
      );
      expect(result.rows[0]?.present, table).toBe(true);
    }
  });

  it("loads assets and is idempotent on a second run", async () => {
    expect(firstLoad.cities).toBeGreaterThan(0);
    expect(firstLoad.airports).toBeGreaterThan(0);
    const before = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM odft_app.reference_cities");
    const secondLoad = await loadReferenceData(pool);
    const after = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM odft_app.reference_cities");
    expect(secondLoad).toEqual(firstLoad);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});

describe("read-only reference lookups", () => {
  it("searchCountries returns only admitted keys and flags XK", async () => {
    const kosovo = await searchCountries(pool, "kosovo");
    expect(kosovo.map((c) => c.countryKey)).toContain("XK");
    expect(kosovo.find((c) => c.countryKey === "XK")?.extension).toBe(true);
    const all = await searchCountries(pool, "", 50);
    expect(all.map((c) => c.countryKey)).not.toContain("GE");
    expect(all.length).toBeGreaterThan(0);
  });

  it("searchCities returns coverage flags and a dataset limitation for absent towns", async () => {
    const rome = await searchCities(pool, { countryKey: "IT", q: "rome", limit: 10 });
    expect(rome.items.some((city) => city.id === ROME && city.coverage === "curated_landmarks")).toBe(true);
    for (const city of rome.items) {
      expect(["curated_landmarks", "generic_only", "insufficient_reference"]).toContain(city.coverage);
    }
    const absent = await searchCities(pool, { countryKey: "IT", q: "zzzznotacity", limit: 10 });
    expect(absent.items).toEqual([]);
    expect(absent.datasetLimitation).toMatch(/cities15000/);
  });

  it("searchAirports rejects ineligible codes and admits PRG", async () => {
    const prague = await searchAirports(pool, { q: "prague", limit: 10, scope: "origin" });
    expect(prague.items.some((airport) => airport.iata === "PRG" && airport.eligibleOrigin)).toBe(true);
    const unknown = await searchAirports(pool, { q: "zzz", limit: 10, scope: "origin" });
    expect(unknown.items).toEqual([]);
  });

  it("getCityAirports shares Rome/Paris catchments and enforces limits", async () => {
    const rome = await getCityAirports(pool, ROME);
    expect(rome.limitation).toBeUndefined();
    const romeIds = rome.links.map((link) => link.airportId);
    expect(romeIds).toEqual(expect.arrayContaining([FCO, CIA]));
    expect(new Set(rome.links.map((link) => link.metroCatchmentId))).toEqual(new Set(["rome"]));

    const paris = await getCityAirports(pool, PARIS);
    const parisIds = paris.links.map((link) => link.airportId);
    expect(parisIds).toEqual(expect.arrayContaining([CDG, "ourairports:4189"]));

    expect(await resolveCatchment(pool, [FCO, CIA])).toEqual({ metroCatchmentId: "rome", sameCatchment: true });
    expect(await resolveCatchment(pool, [FCO, CDG])).toEqual({ metroCatchmentId: null, sameCatchment: false });
  });

  it("returns the BCN->PMI island and PRG->Ceske Budejovice ground evidence", async () => {
    const evidence = await listRouteEvidence(pool);
    const ground = evidence.find((row) => row.kind === "ground_corridor");
    expect(ground?.originRef).toBe("airport:PRG");
    expect(ground?.destinationRef).toBe("geonames:3077916");
    expect(ground?.minutes).toBe(180);
    const island = evidence.find((row) => row.kind === "island_exception");
    expect(island?.originRef).toBe("airport:BCN");
    expect(island?.destinationRef).toBe("airport:PMI");
  });

  it("returns at least eight verified landmarks for Rome", async () => {
    const result = await getCuratedLandmarks(pool, ROME);
    expect(result.coverage).toBe("curated_landmarks");
    expect(result.landmarks.length).toBeGreaterThanOrEqual(8);
    for (const landmark of result.landmarks) {
      expect(landmark.sourceId).toMatch(/^Q\d+$/);
      expect(landmark.verified).toBe(true);
    }
  });
});
