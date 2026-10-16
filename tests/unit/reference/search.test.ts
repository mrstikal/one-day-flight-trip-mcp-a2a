import { describe, expect, it } from "vitest";
import {
  deriveCityCoverage,
  isOriginCandidateType,
  normalizeSearchKey,
  paginate,
  rankByQuery,
  resolveCityAirports,
  resolveCatchment,
  type CatchmentAirport,
} from "@odft/data";

/** T-UT-REF-02 (FR-REF-1): search key normalization, coverage flags, pagination. */
/** T-UT-REF-03 (FR-REF-2): origin-airport eligibility. */
/** T-UT-REF-04 (FR-REF-3): destination airport resolution and catchments. */

describe("T-UT-REF-02 search and coverage", () => {
  it("normalizes diacritics, case, and punctuation deterministically", () => {
    expect(normalizeSearchKey("  České Budějovice ")).toBe("ceske budejovice");
    expect(normalizeSearchKey("München")).toBe("munchen");
    expect(normalizeSearchKey("A Coruña / A Coruña")).toBe("a coruna a coruna");
    expect(normalizeSearchKey("")).toBe("");
  });

  it("ranks prefix matches before infix matches, then by population", () => {
    const items = [
      { name: "Blagnac", searchKey: "blagnac", population: 100 },
      { name: "Paris", searchKey: "paris", population: 2000000 },
      { name: "Paros", searchKey: "paros", population: 5000 },
      { name: "Nea Paris", searchKey: "nea paris", population: 1000 },
    ];
    const ranked = rankByQuery(items, "par");
    expect(ranked.map((item) => item.name)).toEqual(["Paris", "Paros", "Nea Paris"]);
  });

  it("assigns exactly one coverage flag", () => {
    expect(deriveCityCoverage(true, "Europe/Rome")).toBe("curated_landmarks");
    expect(deriveCityCoverage(false, "Europe/Rome")).toBe("generic_only");
    expect(deriveCityCoverage(false, "Etc/GMT+1")).toBe("insufficient_reference");
    expect(deriveCityCoverage(false, "")).toBe("insufficient_reference");
  });

  it("paginates deterministically with an opaque cursor", () => {
    const items = ["a", "b", "c", "d", "e"];
    const first = paginate(items, undefined, 2);
    expect(first.items).toEqual(["a", "b"]);
    expect(first.nextCursor).toBe("2");
    const second = paginate(items, first.nextCursor, 2);
    expect(second.items).toEqual(["c", "d"]);
    const third = paginate(items, second.nextCursor, 2);
    expect(third.items).toEqual(["e"]);
    expect(third.nextCursor).toBeUndefined();
  });
});

describe("T-UT-REF-03 origin-airport eligibility", () => {
  it("accepts only large/medium airports, rejecting closed/heliport/seaplane/unknown", () => {
    expect(isOriginCandidateType("large_airport")).toBe(true);
    expect(isOriginCandidateType("medium_airport")).toBe(true);
    for (const rejected of ["closed", "heliport", "seaplane_base", "balloonport", "small_airport", "unknown", ""]) {
      expect(isOriginCandidateType(rejected), rejected).toBe(false);
    }
  });
});

describe("T-UT-REF-04 destination airport resolution", () => {
  const rome = { id: "geonames:3169070", lat: 41.9028, lon: 12.4964 };
  const airports: CatchmentAirport[] = [
    { id: "ourairports:4372", lat: 41.804532, lon: 12.251998, zone: "Europe/Rome", scheduledService: true }, // FCO
    { id: "ourairports:4370", lat: 41.798769, lon: 12.595331, zone: "Europe/Rome", scheduledService: true }, // CIA
    { id: "ourairports:9999", lat: 41.9, lon: 12.5, zone: "Etc/GMT+1", scheduledService: true }, // placeholder zone
    { id: "ourairports:8888", lat: 44.0, lon: 12.5, zone: "Europe/Rome", scheduledService: true }, // > 150 km away
    { id: "ourairports:7777", lat: 41.91, lon: 12.51, zone: "Europe/Rome", scheduledService: false }, // no scheduled service
  ];

  it("prefers reviewed metro links and shares the catchment", () => {
    const reviewed = [
      { airportId: "ourairports:4372", metroCatchmentId: "rome", transferMinutes: 45, transferMode: "public_transport" as const, eligibleDestination: true, evidenceRefs: ["reviewed:metro:rome"] },
      { airportId: "ourairports:4370", metroCatchmentId: "rome", transferMinutes: 40, transferMode: "public_transport" as const, eligibleDestination: true, evidenceRefs: ["reviewed:metro:rome"] },
    ];
    const { links, limitation } = resolveCityAirports(rome, airports, reviewed);
    expect(limitation).toBeUndefined();
    expect(links.map((link) => link.airportId).sort()).toEqual(["ourairports:4370", "ourairports:4372"]);
    expect(new Set(links.map((link) => link.metroCatchmentId))).toEqual(new Set(["rome"]));
    const catchment = resolveCatchment(["ourairports:4372", "ourairports:4370"], links);
    expect(catchment).toEqual({ metroCatchmentId: "rome", sameCatchment: true });
  });

  it("enforces the 150 km radius, placeholder-zone rejection, scheduled service, and the 3-airport cap", () => {
    const { links } = resolveCityAirports(rome, airports);
    const ids = links.map((link) => link.airportId);
    expect(ids).not.toContain("ourairports:8888"); // too far
    expect(ids).not.toContain("ourairports:9999"); // Etc/GMT placeholder
    expect(ids).not.toContain("ourairports:7777"); // no scheduled service
    expect(ids.length).toBeLessThanOrEqual(3);
  });

  it("returns a structured limitation when no defensible airport exists", () => {
    const { links, limitation } = resolveCityAirports(rome, [airports[3] as CatchmentAirport]);
    expect(links).toEqual([]);
    expect(limitation).toMatch(/NO_DEFENSIBLE_AIRPORT/);
  });

  it("reports different catchments for different metros", () => {
    const links = [
      { cityId: "geonames:1", airportId: "FCO", metroCatchmentId: "rome", transferMinutes: 45, transferMode: "public_transport" as const, eligibleDestination: true, reviewed: true, evidenceRefs: [], distanceKm: 20 },
      { cityId: "geonames:2", airportId: "CDG", metroCatchmentId: "paris", transferMinutes: 55, transferMode: "public_transport" as const, eligibleDestination: true, reviewed: true, evidenceRefs: [], distanceKm: 25 },
    ];
    expect(resolveCatchment(["FCO", "CDG"], links)).toEqual({ metroCatchmentId: null, sameCatchment: false });
    expect(resolveCatchment(["FCO"], links)).toEqual({ metroCatchmentId: "rome", sameCatchment: false });
    expect(resolveCatchment([], links)).toEqual({ metroCatchmentId: null, sameCatchment: false });
  });
});
