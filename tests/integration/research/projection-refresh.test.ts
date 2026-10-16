import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { snapshotContentSchema, tripPreferencesSchema, type DomainCommand } from "@odft/contracts";
import {
  admitOperation,
  getPendingDecisionForTrip,
  researchTripDomain,
  StaleFencingError,
} from "@odft/persistence";
import { buildTripProjection } from "../../../apps/web/src/lib/projection.js";
import { driveTripToReady, resolveProgramChoices } from "../ai/_setup.js";
import {
  armFault,
  claimNextOrFail,
  createGraphTestPool,
  createHarnessTrip,
  createTravelDriver,
  createWorkerPools,
  endWorkerPools,
  researchEvents,
  resetGraphDatabase,
  tripRevision,
  type WorkerPools,
} from "./_setup.js";

/**
 * CR-fix coverage (Phase 09):
 * - a category round-trip re-selects the artifact matching the CURRENT research
 *   fingerprint (never the newest row by time) and the projection renders the
 *   persisted ranked order;
 * - research/ranking writes verify the operation's fencing token;
 * - arming a fault after a successful research invalidates that domain only.
 */

const DISPLAY = { aiMode: "fixture", demoControlsEnabled: true, mapTileUrl: null } as const;

describe("projection refresh, artifact binding, and fencing (real PostgreSQL)", () => {
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

  async function runCommand(
    tripId: string,
    sessionId: string,
    command: DomainCommand,
  ): Promise<void> {
    const admitted = await admitOperation(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: await tripRevision(pool, tripId),
        command,
      },
    });
    expect("operationId" in admitted).toBe(true);
    await createTravelDriver(pools).runOperation(await claimNextOrFail(pools));
  }

  async function hotelArtifactFor(tripId: string, fingerprint: string): Promise<string[]> {
    const result = await pool.query<{ ranked_offers: unknown }>(
      `SELECT ranked_offers FROM odft_app.recommendation_artifacts
        WHERE trip_id = $1 AND service_key = 'hotel' AND input_fingerprint = $2`,
      [tripId, fingerprint],
    );
    const offers = result.rows[0]?.ranked_offers;
    return Array.isArray(offers)
      ? offers.filter((value): value is string => typeof value === "string")
      : [];
  }

  it("returns to an earlier category with the matching artifact and ranked order", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, tripId, sessionId);

    const tripRow = await pool.query<{
      preferences: unknown;
      adults: number;
      travel_variant: string;
    }>(`SELECT preferences, adults, travel_variant FROM odft_app.trips WHERE id = $1`, [tripId]);
    const preferences = tripPreferencesSchema.parse(tripRow.rows[0]?.preferences);
    const adults = tripRow.rows[0]?.adults ?? 1;
    const variant = tripRow.rows[0]?.travel_variant === "one_night" ? "one_night" : "two_nights";
    const standardLevel = preferences.serviceOverrides.hotel ?? preferences.defaultServiceLevel;

    // The baseline projection renders the persisted ranked order (P2: ranked
    // order was previously ignored).
    const baselineEvents = await researchEvents(pool, tripId);
    const baselineHotel = baselineEvents.find(
      (event) => event.domain === "hotel" && event.phase === "finished" && event.fingerprint,
    );
    expect(baselineHotel?.fingerprint).toBeDefined();
    const baselineArtifact = await hotelArtifactFor(tripId, baselineHotel?.fingerprint as string);
    expect(baselineArtifact.length).toBeGreaterThan(1);
    const baselineProjection = await buildTripProjection(pool, tripId, DISPLAY);
    expect(baselineProjection?.hotel.map((offer) => offer.id)).toEqual(baselineArtifact);

    // Pick another level that has compatible offers so the intermediate research
    // succeeds and writes a *newer* artifact row.
    const snapshot = await pool.query<{ inventory: unknown }>(
      `SELECT s.inventory FROM odft_app.scenario_snapshots s
         JOIN odft_app.trips t ON t.active_scenario_snapshot_id = s.id WHERE t.id = $1`,
      [tripId],
    );
    const content = snapshotContentSchema.parse(snapshot.rows[0]?.inventory);
    const otherLevel = content.hotels
      .filter(
        (offer) =>
          offer.level !== standardLevel &&
          offer.adults === adults &&
          offer.nights === (variant === "one_night" ? 1 : 2) &&
          (variant !== "one_night" || offer.luggageStorage),
      )
      .map((offer) => offer.level)[0];
    expect(otherLevel).toBeDefined();

    await runCommand(tripId, sessionId, {
      type: "set_service_override",
      service: "hotel",
      level: otherLevel as "budget" | "standard" | "luxury",
    });
    await resolveProgramChoices(pool, pools, tripId, sessionId);
    await runCommand(tripId, sessionId, {
      type: "set_service_override",
      service: "hotel",
      level: standardLevel,
    });

    const events = await researchEvents(pool, tripId);
    const latestHotel = events.find(
      (event) => event.domain === "hotel" && event.phase === "finished" && event.fingerprint,
    );
    const expectedArtifact = await hotelArtifactFor(tripId, latestHotel?.fingerprint as string);
    expect(expectedArtifact).toEqual(baselineArtifact);

    const projection = await buildTripProjection(pool, tripId, DISPLAY);
    expect(projection?.hotel.length).toBeGreaterThan(0);
    expect(projection?.hotel.map((offer) => offer.id)).toEqual(expectedArtifact);
    // The intermediate (newer-by-created_at) artifact must not win.
    const newerArtifact = await pool.query<{ ranked_offers: unknown }>(
      `SELECT ranked_offers FROM odft_app.recommendation_artifacts
        WHERE trip_id = $1 AND service_key = 'hotel' AND input_fingerprint <> $2
        ORDER BY created_at DESC LIMIT 1`,
      [tripId, latestHotel?.fingerprint],
    );
    const otherIds = Array.isArray(newerArtifact.rows[0]?.ranked_offers)
      ? newerArtifact.rows[0]?.ranked_offers
      : [];
    expect(projection?.hotel.map((offer) => offer.id)).not.toEqual(otherIds);
    expect(await getPendingDecisionForTrip(pools.operations, tripId)).not.toBeNull();
  }, 180_000);

  it("rejects a stale fencing token on a research write", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, tripId, sessionId);

    const operation = await pool.query<{ id: string; fencing_token: string }>(
      `SELECT id, fencing_token FROM odft_app.workflow_operations
        WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    );
    const op = operation.rows[0];
    expect(op).toBeDefined();
    const fingerprint = "a".repeat(64);
    const request = {
      tripId,
      operationId: op?.id as string,
      domain: "dinner" as const,
      attempt: 1,
      inputFingerprint: fingerprint,
    };

    const staleToken = String(BigInt(op?.fencing_token as string) + 1n);
    await expect(
      researchTripDomain(pool, request, {
        operationId: op?.id as string,
        tripId,
        fencingToken: staleToken,
      }),
    ).rejects.toBeInstanceOf(StaleFencingError);
    const noDinnerArtifact = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.recommendation_artifacts
        WHERE trip_id = $1 AND service_key = 'dinner' AND input_fingerprint = $2`,
      [tripId, fingerprint],
    );
    expect(noDinnerArtifact.rows[0]?.count).toBe("0");

    // The exact admitted token still writes: the guard is not over-broad.
    const outcome = await researchTripDomain(pool, request, {
      operationId: op?.id as string,
      tripId,
      fencingToken: op?.fencing_token as string,
    });
    expect(outcome.status).toBe("ok");
    const dinnerArtifact = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.recommendation_artifacts
        WHERE trip_id = $1 AND service_key = 'dinner' AND input_fingerprint = $2`,
      [tripId, fingerprint],
    );
    expect(dinnerArtifact.rows[0]?.count).toBe("1");
  }, 180_000);

  it("re-researches a domain when a fault is armed after a successful research", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, tripId, sessionId);

    const before = await buildTripProjection(pool, tripId, DISPLAY);
    expect(before?.hotel.length ?? 0).toBeGreaterThan(0);
    expect(before?.research?.domains.find((entry) => entry.domain === "hotel")?.status).toBe("ok");

    await armFault(pool, tripId, "hotels", "hotels_unavailable");
    const operationIdsBefore = new Set(
      (await researchEvents(pool, tripId)).map((e) => e.operationId),
    );
    // A retry control re-derives the current step through progress detection and
    // dispatches research by fingerprint diff — unlike a pace change, which now
    // re-plans the itinerary directly and never reaches research dispatch.
    await runCommand(tripId, sessionId, { type: "retry_failed_domains" });

    const refreshEvents = (await researchEvents(pool, tripId)).filter(
      (event) => !operationIdsBefore.has(event.operationId),
    );
    // Only the hotel domain is re-researched: the armed overlay is part of its
    // fingerprint, while the retry control changes no other domain's inputs.
    expect(refreshEvents.map((event) => event.domain)).toEqual(["hotel", "hotel"]);
    const hotelFinished = refreshEvents.find((event) => event.phase === "finished");
    expect(hotelFinished?.status).toBe("unavailable");
    expect(hotelFinished?.simulatedFailure).toBe(true);
    expect(hotelFinished?.reason).toContain("Simulated failure");

    const after = await buildTripProjection(pool, tripId, DISPLAY);
    // The unavailable domain renders empty (never the raw snapshot inventory),
    // while the siblings keep their valid results.
    expect(after?.hotel).toEqual([]);
    expect(after?.research?.domains.find((entry) => entry.domain === "hotel")?.status).toBe(
      "unavailable",
    );
    expect(after?.research?.domains.find((entry) => entry.domain === "breakfast")?.status).toBe(
      "ok",
    );
    expect(after?.meals.length ?? 0).toBeGreaterThan(0);
    const decision = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(decision?.kind).toBe("program_choices");
  }, 180_000);
});
