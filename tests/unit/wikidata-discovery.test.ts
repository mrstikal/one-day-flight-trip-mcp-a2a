import { describe, expect, it, vi } from "vitest";
import {
  discoverCityLandmarks,
  landmarkDiscoveryQuery,
  landmarkLabelQuery,
} from "../../packages/data/src/reference/wikidata-discovery.js";

/**
 * On-demand landmark discovery (2026-10-13): the client pins the exact SPARQL
 * shape of both queries, keeps only labeled in-envelope attractions and never
 * presents a fabricated venue out of a malformed response.
 */

const CENTER = { lat: 60.1699, lon: 24.9384 };

function sparqlResponse(rows: readonly unknown[]): Response {
  return new Response(JSON.stringify({ results: { bindings: rows } }), { status: 200 });
}

function itemRow(qid: string, lat: number, lon: number, sitelinks: number): unknown {
  return {
    item: { value: `http://www.wikidata.org/entity/${qid}` },
    coord: { value: `Point(${lon} ${lat})` },
    sitelinks: { value: String(sitelinks) },
  };
}

function labelRow(qid: string, label: string | null): unknown {
  return {
    item: { value: `http://www.wikidata.org/entity/${qid}` },
    ...(label === null ? {} : { itemLabel: { value: label } }),
  };
}

/** Stub that answers the items query and the label query separately. */
function stubFetch(items: readonly unknown[], labels: readonly unknown[]) {
  return vi.fn(async (url: string, _init?: RequestInit) =>
    decodeURIComponent(url).includes("itemLabel") ? sparqlResponse(labels) : sparqlResponse(items),
  );
}

describe("discoverCityLandmarks", () => {
  it("pins both query shapes (around + classes + group by; label lookup by QID)", () => {
    const items = landmarkDiscoveryQuery({ center: CENTER, radiusKm: 10, limit: 24 });
    expect(items).toContain('"Point(24.9384 60.1699)"^^geo:wktLiteral');
    expect(items).toContain('wikibase:radius "10"');
    expect(items).toContain("wd:Q570116"); // tourist attraction
    expect(items).toContain("GROUP BY ?item");
    expect(items).toContain("ORDER BY DESC(?sitelinks)");
    expect(items).toContain("LIMIT 24");
    const labels = landmarkLabelQuery({ qids: ["Q1", "Q2"], language: "en" });
    expect(labels).toContain("VALUES ?item { wd:Q1 wd:Q2 }");
    expect(labels).toContain('bd:serviceParam wikibase:language "en"');
  });

  it("keeps labeled in-envelope landmarks, drops junk, and orders by notability", async () => {
    const fetchImpl = stubFetch(
      [
        itemRow("Q1", 60.1704, 24.9522, 80),
        // 350 km away: outside the 10 km envelope.
        itemRow("Q4", 60.435, 22.229, 60),
        itemRow("Q5", 60.145, 24.988, 70),
        itemRow("Q1", 60.1704, 24.9522, 80),
      ],
      [labelRow("Q1", "Helsinki Cathedral"), labelRow("Q4", "Turku Castle"), labelRow("Q5", null)],
    );
    const landmarks = await discoverCityLandmarks({
      center: CENTER,
      envelopeRadiusKm: 10,
      fetchImpl: fetchImpl as never,
    });
    // Turku is out of the envelope; Q5 arrived without a label in this stub.
    expect(landmarks.map((landmark) => landmark.qid)).toEqual(["Q1"]);
    expect(landmarks[0]?.name).toBe("Helsinki Cathedral");
    expect(landmarks[0]?.lat).toBeCloseTo(60.1704);
    expect(landmarks[0]?.sitelinks).toBe(80);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("query.wikidata.org/sparql");
  });

  it("skips the label lookup when the items query returns nothing", async () => {
    const fetchImpl = stubFetch([], []);
    const landmarks = await discoverCityLandmarks({
      center: CENTER,
      envelopeRadiusKm: 10,
      fetchImpl: fetchImpl as never,
    });
    expect(landmarks).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails closed on an unexpected response shape", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ unexpected: true })));
    await expect(
      discoverCityLandmarks({ center: CENTER, envelopeRadiusKm: 10, fetchImpl: fetchImpl as never }),
    ).rejects.toThrow(/unexpected response shape/);
  });

  it("surfaces a non-OK HTTP status", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 502 }));
    await expect(
      discoverCityLandmarks({ center: CENTER, envelopeRadiusKm: 10, fetchImpl: fetchImpl as never }),
    ).rejects.toThrow(/HTTP 502/);
  });
});