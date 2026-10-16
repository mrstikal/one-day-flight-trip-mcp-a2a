import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tripPreferencesSchema } from "@odft/contracts";
import { admitOperation, getPendingDecisionForTrip } from "@odft/persistence";
import { driveTripToReady } from "../ai/_setup.js";
import {
  createGraphTestPool,
  createHarnessTrip,
  createTravelDriver,
  createWorkerPools,
  endWorkerPools,
  readTravelState,
  researchEvents,
  resetGraphDatabase,
  snapshotManifest,
  tripRevision,
  claimNextOrFail,
  type WorkerPools,
} from "./_setup.js";

/**
 * T-IT-RED-01/02 (Phase 09): a dinner-only override re-researches only dinner.
 * The other domains keep their retained results and their snapshot domain hashes
 * unchanged, and the new scope's keys coexist with the retained ones.
 */

describe("keyed research reducer refresh scope (real PostgreSQL)", () => {
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

  it("reruns only the overridden dinner domain and retains the siblings", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, tripId, sessionId);

    const before = await snapshotManifest(pool, tripId);
    const eventsBefore = await researchEvents(pool, tripId);
    expect(eventsBefore.filter((event) => event.phase === "finished")).toHaveLength(6);
    const stateBefore = await readTravelState(pools, tripId);
    const resultsBefore = stateBefore.values.researchResults as Record<
      string,
      { domain: string; fingerprint: string }
    >;
    const beforeDinnerFingerprint = Object.values(resultsBefore).find(
      (result) => result.domain === "dinner",
    )?.fingerprint;

    const preferencesRow = await pool.query<{ preferences: unknown }>(
      `SELECT preferences FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    const preferences = tripPreferencesSchema.parse(preferencesRow.rows[0]?.preferences);
    const currentDinner = preferences.serviceOverrides.dinner ?? preferences.defaultServiceLevel;
    const nextDinner = currentDinner === "luxury" ? "budget" : "luxury";

    const admitted = await admitOperation(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: await tripRevision(pool, tripId),
        command: { type: "set_service_override", service: "dinner", level: nextDinner },
      },
    });
    expect("operationId" in admitted).toBe(true);
    await createTravelDriver(pools).runOperation(await claimNextOrFail(pools));

    const eventsAfter = await researchEvents(pool, tripId);
    const beforeIds = new Set(eventsBefore.map((event) => event.operationId));
    const refreshEvents = eventsAfter.filter((event) => !beforeIds.has(event.operationId));
    expect(refreshEvents.map((event) => event.domain)).toEqual(["dinner", "dinner"]);
    expect(refreshEvents.filter((event) => event.phase === "finished")).toHaveLength(1);

    const after = await snapshotManifest(pool, tripId);
    expect(after.snapshotCount).toBe(before.snapshotCount);
    expect(after.snapshotId).toBe(before.snapshotId);
    expect(after.domainHashes).toEqual(before.domainHashes);

    const state = await readTravelState(pools, tripId);
    const results = state.values.researchResults as Record<
      string,
      { domain: string; status: string; fingerprint: string }
    >;
    expect(Object.keys(results)).toHaveLength(6);
    // The serial join prunes the stale dinner scope: exactly the refreshed
    // dinner result (and the five retained siblings) remain.
    const dinnerKeys = Object.keys(results).filter((key) => key.endsWith(":dinner"));
    expect(dinnerKeys).toHaveLength(1);
    expect(dinnerKeys[0]?.endsWith(":r1:dinner")).toBe(true);
    expect(Object.values(results).every((result) => result.status === "ok")).toBe(true);
    expect(state.values.researchStatus).toBe("ok");
    expect(state.values.requiredDomains).toEqual(["dinner"]);
    const dinnerResult = Object.values(results).find((result) => result.domain === "dinner");
    expect(dinnerResult?.fingerprint).not.toBe(beforeDinnerFingerprint);

    const artifacts = await pool.query<{ service_key: string; input_fingerprint: string }>(
      `SELECT DISTINCT ON (service_key) service_key, input_fingerprint
         FROM odft_app.recommendation_artifacts
        WHERE trip_id = $1 AND service_key IN ('dinner','breakfast')
        ORDER BY service_key, created_at DESC, id DESC`,
      [tripId],
    );
    const byService = new Map(artifacts.rows.map((row) => [row.service_key, row]));
    const breakfastResult = Object.values(results).find((result) => result.domain === "breakfast");
    expect(byService.get("dinner")?.input_fingerprint).toBe(dinnerResult?.fingerprint);
    expect(byService.get("breakfast")?.input_fingerprint).toBe(breakfastResult?.fingerprint);

    const decision = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(decision?.kind).toBe("program_choices");
    expect((decision?.allowedOfferIds ?? []).length).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
