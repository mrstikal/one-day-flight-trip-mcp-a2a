import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { runMigrations, loadReferenceData } from "@odft/persistence";
import { ensureCityLandmarks } from "../../../apps/worker/src/travel/landmark-discovery.js";

/**
 * On-demand landmark curation (2026-10-13): the first trip to a generic-only city
 * fetches landmarks from Wikidata, stores them and marks the city curated; every
 * later trip reuses the stored rows without another lookup. An empty result is
 * remembered as `insufficient_reference`; a failed lookup stays generic and never
 * throws.
 */

function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL must be set for integration tests");
  }
  return url;
}

const HELSINKI = "geonames:658225";
const pool = new Pool({ connectionString: requireTestDatabaseUrl(), max: 4 });

function sparqlResponse(rows: readonly unknown[]): Response {
  return new Response(JSON.stringify({ results: { bindings: rows } }), { status: 200 });
}

function itemRow(qid: string, lat: number, lon: number, sitelinks = 50): unknown {
  return {
    item: { value: `http://www.wikidata.org/entity/${qid}` },
    coord: { value: `Point(${lon} ${lat})` },
    sitelinks: { value: String(sitelinks) },
  };
}

function labelRow(qid: string, label: string): unknown {
  return {
    item: { value: `http://www.wikidata.org/entity/${qid}` },
    itemLabel: { value: label },
  };
}

/** Stub that answers the items query and the label query separately. */
function stubFetch(
  items: readonly unknown[],
  labels: readonly unknown[],
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string, _init?: RequestInit) =>
    decodeURIComponent(String(url)).includes("itemLabel")
      ? sparqlResponse(labels)
      : sparqlResponse(items),
  );
}

beforeAll(async () => {
  await pool.query("DROP SCHEMA IF EXISTS odft_app CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS odft_checkpoint CASCADE");
  await runMigrations(pool);
  await loadReferenceData(pool);
});

beforeEach(async () => {
  await pool.query(`DELETE FROM odft_app.reference_landmarks WHERE city_id = $1`, [HELSINKI]);
  await pool.query(
    `UPDATE odft_app.reference_cities SET coverage_flag = 'generic_only' WHERE id = $1`,
    [HELSINKI],
  );
});

afterAll(async () => {
  await pool.end();
});

async function coverage(): Promise<string> {
  const result = await pool.query<{ coverage_flag: string }>(
    `SELECT coverage_flag FROM odft_app.reference_cities WHERE id = $1`,
    [HELSINKI],
  );
  return result.rows[0]?.coverage_flag ?? "";
}

async function storedLandmarks(): Promise<{ id: string; name: string }[]> {
  const result = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM odft_app.reference_landmarks WHERE city_id = $1 ORDER BY name`,
    [HELSINKI],
  );
  return result.rows;
}

describe("ensureCityLandmarks (real PostgreSQL)", () => {
  it("stores discovered landmarks once and marks the city curated", async () => {
    const fetchImpl = stubFetch(
      [itemRow("Q1", 60.1704, 24.9522, 90), itemRow("Q2", 60.145, 24.988, 70)],
      [labelRow("Q1", "Helsinki Cathedral"), labelRow("Q2", "Suomenlinna")],
    );
    await ensureCityLandmarks(pool, HELSINKI, { enabled: true, fetchImpl: fetchImpl as never });
    // Two lookups: the items query and the label query for the selected QIDs.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await coverage()).toBe("curated_landmarks");
    const landmarks = await storedLandmarks();
    expect(landmarks.map((row) => row.id)).toEqual(["wikidata:Q1", "wikidata:Q2"]);
    expect(landmarks.map((row) => row.name)).toContain("Suomenlinna");

    // A later trip (or discovery run) reuses the stored rows: no second lookup.
    const again = stubFetch([], []);
    await ensureCityLandmarks(pool, HELSINKI, { enabled: true, fetchImpl: again as never });
    expect(again).not.toHaveBeenCalled();
  });

  it("remembers an empty result as insufficient_reference and never retries", async () => {
    const empty = stubFetch([], []);
    await ensureCityLandmarks(pool, HELSINKI, { enabled: true, fetchImpl: empty as never });
    expect(await coverage()).toBe("insufficient_reference");
    expect(await storedLandmarks()).toEqual([]);

    const retry = stubFetch([itemRow("Q9", 60.17, 24.94)], [labelRow("Q9", "Late")]);
    await ensureCityLandmarks(pool, HELSINKI, { enabled: true, fetchImpl: retry as never });
    expect(retry).not.toHaveBeenCalled();
  });

  it("keeps the generic fallback and stays retryable when the lookup fails", async () => {
    const failing = vi.fn(async () => {
      throw new Error("network down");
    });
    const warnings: string[] = [];
    await ensureCityLandmarks(pool, HELSINKI, {
      enabled: true,
      fetchImpl: failing as never,
      logger: (record) => {
        if (record.level === "warn") {
          warnings.push(String(record.message));
        }
      },
    });
    expect(await coverage()).toBe("generic_only");
    expect(warnings.length).toBe(1);

    // The next trip retries and succeeds.
    await ensureCityLandmarks(pool, HELSINKI, {
      enabled: true,
      fetchImpl: stubFetch([itemRow("Q1", 60.1704, 24.9522)], [labelRow("Q1", "Helsinki Cathedral")]) as never,
    });
    expect(await coverage()).toBe("curated_landmarks");
  });

  it("does nothing when discovery is disabled", async () => {
    const fetchImpl = stubFetch([], []);
    await ensureCityLandmarks(pool, HELSINKI, { enabled: false, fetchImpl: fetchImpl as never });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await coverage()).toBe("generic_only");
  });
});