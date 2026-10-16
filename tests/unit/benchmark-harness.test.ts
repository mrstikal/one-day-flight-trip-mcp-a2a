import { describe, expect, it } from "vitest";
import {
  assertDisposableDatabaseUrl,
  BASELINE_CASES,
  completionRate,
  percentile,
  summarizeLatencies,
} from "../benchmarks/baseline-cases.js";

/**
 * Focused harness tests (Phase 01): the destructive-target guard and the result
 * calculation helpers. These are the only new executable logic of the harness
 * that is not the HTTP driver itself.
 */

describe("benchmark destructive-target guard", () => {
  it("accepts a dedicated disposable database and returns its name", () => {
    expect(
      assertDisposableDatabaseUrl("postgres://odft:secret@127.0.0.1:5442/odft_phase01_test"),
    ).toBe("odft_phase01_test");
  });

  it("refuses the application database name", () => {
    expect(() => assertDisposableDatabaseUrl("postgres://odft:secret@127.0.0.1:5442/odft")).toThrow(
      /Refusing to run the benchmark against non-test database "odft"/,
    );
  });

  it("refuses other non-test names, including near-miss suffixes", () => {
    for (const name of ["odft_dev", "odft_test_backup", "test", "odfttest"]) {
      expect(() =>
        assertDisposableDatabaseUrl(`postgres://odft:secret@127.0.0.1:5442/${name}`),
      ).toThrow(/non-test database/);
    }
  });

  it("refuses maintenance databases and malformed URLs", () => {
    expect(() =>
      assertDisposableDatabaseUrl("postgres://odft:secret@127.0.0.1:5442/postgres"),
    ).toThrow(/maintenance database/);
    expect(() =>
      assertDisposableDatabaseUrl("postgres://odft:secret@127.0.0.1:5442/template0"),
    ).toThrow(/maintenance database/);
    expect(() => assertDisposableDatabaseUrl("not a url")).toThrow(/not a valid connection URL/);
  });

  it("refuses a URL without a database name", () => {
    expect(() => assertDisposableDatabaseUrl("postgres://odft:secret@127.0.0.1:5442/")).toThrow(
      /must name a database/,
    );
  });
});

describe("benchmark latency calculation", () => {
  it("computes nearest-rank percentiles", () => {
    const values = [10, 20, 30, 40, 50];
    expect(percentile(values, 0)).toBe(10);
    expect(percentile(values, 0.5)).toBe(30);
    expect(percentile(values, 0.95)).toBe(50);
    expect(percentile([], 0.5)).toBeNull();
  });

  it("sorts a copy so the input order never matters", () => {
    const values = [50, 10, 40, 20, 30];
    expect(percentile(values, 0.5)).toBe(30);
    expect(values).toEqual([50, 10, 40, 20, 30]);
  });

  it("rejects an out-of-range p", () => {
    expect(() => percentile([1, 2], 1.5)).toThrow(/within 0\.\.1/);
  });

  it("summarizes count/min/max/mean/p50/p95", () => {
    expect(summarizeLatencies([100, 200, 300, 400, 1000])).toEqual({
      count: 5,
      min: 100,
      max: 1000,
      mean: 400,
      p50: 300,
      p95: 1000,
    });
  });

  it("returns null for an empty sample set", () => {
    expect(summarizeLatencies([])).toBeNull();
    expect(completionRate(0, 0)).toBeNull();
    expect(completionRate(3, 5)).toBe(0.6);
  });
});

describe("baseline case definitions", () => {
  it("defines exactly the six fixed cases with unique ids", () => {
    expect(BASELINE_CASES).toHaveLength(6);
    const ids = BASELINE_CASES.map((caseDef) => caseDef.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers each destination in both travel variants", () => {
    for (const cityId of ["geonames:3169070", "geonames:2988507", "geonames:3128760"]) {
      const variants = BASELINE_CASES.filter(
        (caseDef) => caseDef.destination.expectedCityId === cityId,
      ).map((caseDef) => caseDef.variant);
      expect(variants.sort()).toEqual(["one_night", "two_nights"]);
    }
  });
});
