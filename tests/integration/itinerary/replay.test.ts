import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approveItineraryDraft, persistItineraryDraft } from "@odft/persistence";
import {
  itineraryCostsSchema,
  itineraryEventSchema,
  itineraryValidationSchema,
} from "@odft/contracts";
import {
  claimNextOrFail,
  createGraphTestPool,
  createHarnessTrip,
  createTestAiService,
  createWorkerPools,
  endWorkerPools,
  resetGraphDatabase,
  type Harness,
  type WorkerPools,
} from "./_setup.js";
import { createTravelPortsFactory } from "../../../apps/worker/src/travel/ports.js";

/**
 * Phase 10 persistence replay (T-IT-FLT-01 pattern): the append-only writes are
 * idempotent under the effect ledger and the fenced approval can never approve a
 * stale or superseded version.
 */

const VALIDATION = itineraryValidationSchema.parse({
  status: "valid",
  errors: [],
  warnings: [],
  metrics: {
    activityCount: 0,
    visitMinutes: 0,
    mealMinutes: 0,
    breakMinutes: 0,
    transferMinutes: 0,
    walkingMinutes: 0,
    walkingKm: 0,
    museumCount: 0,
    activityTagCounts: {},
    firstContentStartLocal: null,
    lastContentEndLocal: null,
    totalCostMinor: 0,
    budgetMinor: null,
    remainingBudgetMinor: null,
  },
  fingerprint: "a".repeat(64),
  sourceFingerprint: "b".repeat(64),
});

const COSTS = itineraryCostsSchema.parse({
  items: [],
  totalMinor: 0,
  dinnerExcluded: false,
  dinnerExcludedReason: null,
  excludedNotes: [],
});

describe("itinerary persistence replay (real PostgreSQL)", () => {
  let pool: Pool;
  let pools: WorkerPools;

  beforeAll(async () => {
    pool = createGraphTestPool();
    pools = createWorkerPools();
  });

  beforeEach(async () => {
    await resetGraphDatabase(pool);
  });

  afterAll(async () => {
    await endWorkerPools(pools);
    await pool.end();
  });

  it("appends exactly one draft per attempt and replays the stored version", async () => {
    const harness: Harness = await createHarnessTrip(pool);
    const claim = await claimNextOrFail(pools);
    const fence = {
      operationId: claim.operationId,
      tripId: claim.tripId,
      fencingToken: claim.fencingToken,
    };
    const input = {
      tripId: harness.tripId,
      operationId: claim.operationId,
      attempt: 1,
      sightseeingDate: "2026-12-01",
      zone: "Europe/Rome",
      adults: 1,
      pace: "moderate",
      travelVariant: "one_night",
      events: [],
      validation: VALIDATION,
      costs: COSTS,
      review: null,
      simulatedFailure: false,
      simulatedFailureNote: null,
    };
    const first = await persistItineraryDraft(pool, input, fence);
    const replay = await persistItineraryDraft(pool, input, fence);
    expect(replay).toEqual(first);
    const rows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.itineraries WHERE trip_id = $1`,
      [harness.tripId],
    );
    expect(rows.rows[0]?.count).toBe("1");
    // The next attempt appends a new immutable version.
    const second = await persistItineraryDraft(pool, { ...input, attempt: 2 }, fence);
    expect(second.version).toBe(first.version + 1);
  }, 120_000);

  it("approves idempotently and refuses stale or superseded versions", async () => {
    const harness: Harness = await createHarnessTrip(pool);
    const claim = await claimNextOrFail(pools);
    const fence = {
      operationId: claim.operationId,
      tripId: claim.tripId,
      fencingToken: claim.fencingToken,
    };
    const first = await persistItineraryDraft(
      pool,
      {
        tripId: harness.tripId,
        operationId: claim.operationId,
        attempt: 1,
        sightseeingDate: "2026-12-01",
        zone: "Europe/Rome",
        adults: 1,
        pace: "moderate",
        travelVariant: "one_night",
        events: [],
        validation: VALIDATION,
        costs: COSTS,
        review: null,
        simulatedFailure: false,
        simulatedFailureNote: null,
      },
      fence,
    );

    // A mismatched fingerprint is a typed stale conflict.
    await expect(
      approveItineraryDraft(
        pool,
        { tripId: harness.tripId, itineraryId: first.id, currentSourceFingerprint: "c".repeat(64) },
        fence,
      ),
    ).rejects.toMatchObject({ code: "STALE_ITINERARY" });

    const approved = await approveItineraryDraft(
      pool,
      { tripId: harness.tripId, itineraryId: first.id, currentSourceFingerprint: "b".repeat(64) },
      fence,
    );
    expect(approved).toEqual(first);
    // Replay is idempotent.
    const replayed = await approveItineraryDraft(
      pool,
      { tripId: harness.tripId, itineraryId: first.id, currentSourceFingerprint: "b".repeat(64) },
      fence,
    );
    expect(replayed).toEqual(first);

    // A newer draft supersedes the approved version only when it is approved.
    const second = await persistItineraryDraft(
      pool,
      {
        tripId: harness.tripId,
        operationId: claim.operationId,
        attempt: 2,
        sightseeingDate: "2026-12-01",
        zone: "Europe/Rome",
        adults: 1,
        pace: "moderate",
        travelVariant: "one_night",
        events: [],
        validation: VALIDATION,
        costs: COSTS,
        review: null,
        simulatedFailure: false,
        simulatedFailureNote: null,
      },
      fence,
    );
    await approveItineraryDraft(
      pool,
      { tripId: harness.tripId, itineraryId: second.id, currentSourceFingerprint: "b".repeat(64) },
      fence,
    );
    const statuses = await pool.query<{ version: number; status: string }>(
      `SELECT version, status FROM odft_app.itineraries WHERE trip_id = $1 ORDER BY version`,
      [harness.tripId],
    );
    expect(statuses.rows).toEqual([
      { version: first.version, status: "superseded" },
      { version: second.version, status: "approved" },
    ]);
    // A superseded version can never be approved again.
    await expect(
      approveItineraryDraft(
        pool,
        { tripId: harness.tripId, itineraryId: first.id, currentSourceFingerprint: "b".repeat(64) },
        fence,
      ),
    ).rejects.toMatchObject({ code: "ITINERARY_NOT_APPROVABLE" });
  }, 120_000);

  it("rejects an out-of-contract draft instead of corrupting the projection", async () => {
    const harness: Harness = await createHarnessTrip(pool);
    const claim = await claimNextOrFail(pools);
    const fence = {
      operationId: claim.operationId,
      tripId: claim.tripId,
      fencingToken: claim.fencingToken,
    };
    const event = itineraryEventSchema.parse({
      id: "00000000-0000-4000-8000-000000000001",
      kind: "break",
      title: "Break",
      localDate: "2026-12-01",
      startMinute: 600,
      endMinute: 620,
      startLocal: "10:00",
      endLocal: "10:20",
      startInstant: "2026-12-01T09:00:00Z",
      endInstant: "2026-12-01T09:20:00Z",
      zone: "Europe/Rome",
      durationMinutes: 20,
      refId: null,
      activityTags: [],
      provenance: ["Test"],
      physicalDemand: "low",
      costInclusionKey: null,
      costMinor: 0,
      location: null,
      locked: false,
      lockReason: null,
      simulated: false,
    });
    await expect(
      persistItineraryDraft(
        pool,
        {
          tripId: harness.tripId,
          operationId: claim.operationId,
          attempt: 1,
          sightseeingDate: "2026-12-01",
          zone: "Europe/Rome",
          adults: 1,
          pace: "moderate",
          travelVariant: "one_night",
          // 81 events exceed the persisted bound by construction.
          events: Array.from({ length: 81 }, () => event),
          validation: VALIDATION,
          costs: COSTS,
          review: null,
          simulatedFailure: false,
          simulatedFailureNote: null,
        },
        fence,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const rows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.itineraries WHERE trip_id = $1`,
      [harness.tripId],
    );
    expect(rows.rows[0]?.count).toBe("0");
  }, 120_000);

  it("refuses planning before a flight is confirmed with a typed conflict", async () => {
    const harness: Harness = await createHarnessTrip(pool);
    const claim = await claimNextOrFail(pools);
    const ports = createTravelPortsFactory(pool, createTestAiService(pools))({
      operationId: claim.operationId,
      tripId: claim.tripId,
      fencingToken: claim.fencingToken,
    });
    await expect(
      ports.planItinerary({
        tripId: harness.tripId,
        operationId: claim.operationId,
        attempt: 1,
        feedback: [],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const rows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.itineraries WHERE trip_id = $1`,
      [harness.tripId],
    );
    expect(rows.rows[0]?.count).toBe("0");
  }, 120_000);
});
