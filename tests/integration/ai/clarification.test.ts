import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tripPreferencesSchema } from "@odft/contracts";
import { admitOperation, admitResume, getPendingDecisionForTrip } from "@odft/persistence";
import {
  createGraphTestPool,
  createHarnessTrip,
  createTravelDriver,
  createWorkerPools,
  driveTripToReady,
  endWorkerPools,
  resetGraphDatabase,
  sendChat,
  tripRevision,
  type WorkerPools,
} from "./_setup.js";
import { claimNextOrFail } from "../graph/_setup.js";

/**
 * AC-08-2 / clarification binding: a chosen option applies exactly its stored
 * command list, and a free-text follow-up re-enters through the internal
 * `modify` branch of the current clarification interrupt.
 */

describe("clarification binding (real PostgreSQL)", () => {
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

  async function preferences(tripId: string) {
    const result = await pool.query<{ preferences: unknown }>(
      `SELECT preferences FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    return tripPreferencesSchema.parse(result.rows[0]?.preferences);
  }

  it("applies exactly the chosen option's stored commands", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, tripId, sessionId);

    await sendChat(pool, pools, tripId, sessionId, "A relaxed day with six museums");

    const decision = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(decision?.kind).toBe("clarification");
    const optionIds = decision?.allowedOptionIds ?? [];
    expect(optionIds.length).toBeGreaterThanOrEqual(2);

    // Choose the first option (keep the relaxed pace with 2 museums).
    const chosen = await admitResume(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: await tripRevision(pool, tripId),
        decisionId: decision?.id ?? "",
        response: { action: "choose_option", optionId: optionIds[0] as string },
      },
    });
    expect("operationId" in chosen).toBe(true);
    await createTravelDriver(pools).runOperation(await claimNextOrFail(pools));

    const prefs = await preferences(tripId);
    expect(prefs.activityPace).toBe("relaxed");
    expect(prefs.minimumActivityCounts.museum).toBe(2);

    // The chosen commands (the reduced museum minimum) replan directly: the
    // applied program stays authoritative and the program step is never
    // re-opened (2026-10-14).
    const followUp = await getPendingDecisionForTrip(pools.operations, tripId);
    // The planned museums fit, but the pinned landmark (plus two museums) exceeds
    // the relaxed visit-time cap, so the trip asks with concrete options instead
    // of silently dropping the pin or the minimum.
    expect(followUp?.kind).toBe("clarification");
    expect(followUp?.allowedOptionIds).toEqual(
      expect.arrayContaining(["denser_pace_moderate", "review_program"]),
    );
  }, 90_000);

  it("routes a free-text follow-up through the internal modify branch", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, tripId, sessionId);

    await sendChat(pool, pools, tripId, sessionId, "A relaxed day with six museums");
    const clarification = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(clarification?.kind).toBe("clarification");

    // A new chat operation while the clarification is pending must resume the
    // interrupt with a worker-built `modify`, not conflict.
    const followUp = await admitOperation(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: await tripRevision(pool, tripId),
        chat: "Actually make it an intensive day",
      },
    });
    expect("operationId" in followUp).toBe(true);
    await createTravelDriver(pools).runOperation(await claimNextOrFail(pools));

    const prefs = await preferences(tripId);
    expect(prefs.activityPace).toBe("intensive");

    // The answered clarification is no longer pending and the trip moved on: the
    // pace change replans directly into a fresh itinerary approval (2026-10-14).
    const pending = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(pending?.kind).toBe("itinerary_approval");
    const superseded = await pool.query<{ status: string }>(
      `SELECT status FROM odft_app.pending_decisions WHERE id = $1`,
      [clarification?.id ?? ""],
    );
    expect(superseded.rows[0]?.status).not.toBe("pending");
  }, 90_000);
});
