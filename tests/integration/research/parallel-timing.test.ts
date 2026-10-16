import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RESEARCH_DOMAINS } from "@odft/contracts";
import { getPendingDecisionForTrip } from "@odft/persistence";
import {
  createGraphTestPool,
  createHarnessTrip,
  createWorkerPools,
  driveToFlightConfirmed,
  endWorkerPools,
  nodeRunCount,
  readTravelState,
  researchEvents,
  resetGraphDatabase,
  type WorkerPools,
} from "./_setup.js";

/**
 * T-IT-PAR-01/02 (Phase 09): the initial research run fans out all six domains
 * as overlapping `Send` tasks, completes them in one superstep barrier with
 * exactly one join, and prepares the hotel decision from the ranked results.
 */

describe("parallel research fan-out (real PostgreSQL)", () => {
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

  it("researches all six domains with overlapping timing and one join", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await driveToFlightConfirmed(pool, pools, tripId, sessionId);

    const events = await researchEvents(pool, tripId);
    const finished = events.filter((event) => event.phase === "finished");
    expect(finished.map((event) => event.domain).sort()).toEqual([...RESEARCH_DOMAINS].sort());
    expect(finished.every((event) => event.status === "ok")).toBe(true);
    expect(finished.every((event) => event.attempt === 1)).toBe(true);
    // Every finished event belongs to the same operation and the same run scope.
    const operationIds = new Set(events.map((event) => event.operationId));
    expect(operationIds.size).toBe(1);

    // Overlapping execution: with an idle pool the six fan-out tasks start
    // immediately, so at least four of them started before the first finished
    // (a serial run would yield one).
    const intervals = RESEARCH_DOMAINS.map((domain) => {
      const started = events.find(
        (event) => event.domain === domain && event.phase === "started",
      )?.createdAt;
      const done = events.find(
        (event) => event.domain === domain && event.phase === "finished",
      )?.createdAt;
      return { domain, started: started?.getTime() ?? 0, done: done?.getTime() ?? 0 };
    });
    expect(intervals.every((interval) => interval.done >= interval.started)).toBe(true);
    const firstFinish = Math.min(...intervals.map((interval) => interval.done));
    const startedBeforeFirstFinish = intervals.filter(
      (interval) => interval.started < firstFinish,
    ).length;
    expect(startedBeforeFirstFinish).toBeGreaterThanOrEqual(4);

    // One join per superstep and one ranking pass; the six tasks share one node.
    expect(await nodeRunCount(pool, tripId, "join_research")).toBe(1);
    expect(await nodeRunCount(pool, tripId, "rank_recommendations")).toBe(1);
    expect(await nodeRunCount(pool, tripId, "research_domain")).toBeGreaterThanOrEqual(1);

    const state = await readTravelState(pools, tripId);
    expect(state.values.researchStatus).toBe("ok");
    expect(state.values.researchRound).toBe(1);
    const results = state.values.researchResults as Record<string, { status: string }>;
    expect(Object.keys(results)).toHaveLength(6);
    expect(Object.values(results).every((result) => result.status === "ok")).toBe(true);

    const decision = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(decision?.kind).toBe("hotel_choice");
    expect((decision?.allowedOfferIds ?? []).length).toBeGreaterThanOrEqual(1);
    expect(state.values.gate).toBe("hotels_ready");
  }, 90_000);

  it("keeps exactly one recommendation artifact per researched service", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await driveToFlightConfirmed(pool, pools, tripId, sessionId);

    const artifacts = await pool.query<{ service_key: string; count: string }>(
      `SELECT service_key, count(*)::text AS count FROM odft_app.recommendation_artifacts
        WHERE trip_id = $1 GROUP BY service_key ORDER BY service_key`,
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
    expect(artifacts.rows.every((row) => row.count === "1")).toBe(true);
  }, 90_000);
});
