import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RESEARCH_DOMAINS } from "@odft/contracts";
import { getPendingDecisionForTrip } from "@odft/persistence";
import {
  armFault,
  createGraphTestPool,
  createHarnessTrip,
  createWorkerPools,
  driveToFlightConfirmed,
  endWorkerPools,
  readTravelState,
  researchEvents,
  resetGraphDatabase,
  snapshotManifest,
  type WorkerPools,
} from "./_setup.js";

/**
 * T-IT-RET-01 (Phase 09, scenario D): a transient provider failure on the hotel
 * domain is contained as a tagged result, the automatic retry opens a new run
 * scope and sends only the failed domain, total provider attempts stay <= 2, and
 * the sibling domains keep their hashes and single attempts.
 */

describe("failed-subset retry (real PostgreSQL)", () => {
  let pool: Pool;
  let pools: WorkerPools;

  beforeAll(async () => {
    pool = createGraphTestPool();
    pools = createWorkerPools(8);
  });

  beforeEach(async () => {
    await resetGraphDatabase(pool);
  });

  afterAll(async () => {
    await endWorkerPools(pools);
    await pool.end();
  });

  it("retries only the transiently failed hotel domain within two attempts", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await armFault(pool, tripId, "hotels", "provider_failure");

    await driveToFlightConfirmed(pool, pools, tripId, sessionId);

    const events = await researchEvents(pool, tripId);
    const finished = events.filter((event) => event.phase === "finished");
    const hotelFinished = finished.filter((event) => event.domain === "hotel");
    expect(hotelFinished.map((event) => event.attempt)).toEqual([1, 2]);
    expect(hotelFinished[0]?.status).toBe("retryable_error");
    expect(hotelFinished[0]?.simulatedFailure).toBe(true);
    expect(hotelFinished[0]?.reason).toContain("Simulated failure");
    expect(hotelFinished[1]?.status).toBe("ok");

    for (const domain of RESEARCH_DOMAINS.filter((entry) => entry !== "hotel")) {
      const domainFinished = finished.filter((event) => event.domain === domain);
      expect(domainFinished).toHaveLength(1);
      expect(domainFinished[0]?.attempt).toBe(1);
      expect(domainFinished[0]?.status).toBe("ok");
    }
    // No domain exceeded the bounded attempt budget.
    for (const domain of RESEARCH_DOMAINS) {
      const attempts = finished
        .filter((event) => event.domain === domain)
        .map((event) => event.attempt);
      expect(Math.max(0, ...attempts)).toBeLessThanOrEqual(2);
    }

    const counters = await pool.query<{ counters: Record<string, number> }>(
      `SELECT counters FROM odft_app.simulation_faults
        WHERE trip_id = $1 AND domain = 'hotels' AND fault = 'provider_failure'
        ORDER BY updated_at DESC LIMIT 1`,
      [tripId],
    );
    expect(counters.rows[0]?.counters["attempts"]).toBe(2);
    expect(counters.rows[0]?.counters["injected"]).toBe(1);

    // The retry used a second scope containing only the hotel key; the join
    // pruned the failed first-scope entry and kept the six current results.
    const state = await readTravelState(pools, tripId);
    const results = state.values.researchResults as Record<
      string,
      { domain: string; status: string; attempt: number }
    >;
    const scopeKeys = Object.keys(results);
    expect(scopeKeys).toHaveLength(6);
    expect(scopeKeys.some((key) => key.endsWith(":r2:hotel"))).toBe(true);
    expect(scopeKeys.some((key) => key.endsWith(":r1:hotel"))).toBe(false);
    expect(scopeKeys.some((key) => key.endsWith(":r2:breakfast"))).toBe(false);
    expect(state.values.researchRound).toBe(2);
    expect(state.values.researchStatus).toBe("ok");
    const hotelResult = Object.values(results).find((result) => result.domain === "hotel");
    expect(hotelResult?.status).toBe("ok");
    expect(hotelResult?.attempt).toBe(2);

    // No snapshot re-extension happened for the retry: exactly the flight
    // snapshot plus the one-time domain extension, with all seven domain hashes
    // (flights + six researched domains) serving the siblings and the retry.
    const manifest = await snapshotManifest(pool, tripId);
    expect(manifest.snapshotCount).toBe(2);
    expect(Object.keys(manifest.domainHashes)).toHaveLength(7);

    const decision = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(decision?.kind).toBe("hotel_choice");
    expect((decision?.allowedOfferIds ?? []).length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("contains the failure without touching a sibling domain's results", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await armFault(pool, tripId, "hotels", "provider_failure");
    await driveToFlightConfirmed(pool, pools, tripId, sessionId);

    const state = await readTravelState(pools, tripId);
    const results = state.values.researchResults as Record<
      string,
      { domain: string; status: string; attempt: number }
    >;
    const breakfast = Object.values(results).find((result) => result.domain === "breakfast");
    expect(breakfast?.status).toBe("ok");
    expect(breakfast?.attempt).toBe(1);
    expect(Object.values(results).filter((result) => result.domain === "breakfast")).toHaveLength(1);

    const artifacts = await pool.query<{ service_key: string }>(
      `SELECT service_key FROM odft_app.recommendation_artifacts
        WHERE trip_id = $1 ORDER BY service_key`,
      [tripId],
    );
    expect(artifacts.rows.map((row) => row.service_key)).toEqual([
      "activities",
      "breakfast",
      "dinner",
      "events",
      "hotel",
      "lunch",
    ]);
  }, 120_000);
});
