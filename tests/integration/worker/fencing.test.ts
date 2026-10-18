import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completeOperation, renewLease, StaleFencingError } from "@odft/persistence";
import { createFencedEventWriter, createFencedRunEffect } from "../../../apps/worker/src/driver.js";
import {
  claimNextOrFail,
  createTestPool,
  createFixtureTrip,
  createWorkerPools,
  endWorkerPools,
  resetDatabase,
  type WorkerPools,
} from "../_setup.js";

/**
 * T-IT-FLT-07 / T-IT-LIM-04: single-writer fencing. After a lease rotates the
 * fencing token, the old worker cannot append events, run fenced effects, or
 * complete the operation; the next claim owns the work. Phase 11 keeps these
 * guards for coordinator writes and removes only the legacy checkpoint writer.
 */

describe("worker lease fencing", () => {
  let pool: Pool;
  let pools: WorkerPools;

  beforeAll(async () => {
    pool = createTestPool();
    pools = createWorkerPools();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await endWorkerPools(pools);
    await pool.end();
  });

  async function expireLease(operationId: string): Promise<void> {
    await pools.operations.query(
      `UPDATE odft_app.workflow_operations
          SET lease_expires_at = now() - interval '5 seconds'
        WHERE id = $1`,
      [operationId],
    );
  }

  it("rejects a stale event write after the token rotates", async () => {
    const { tripId } = await createFixtureTrip(pool);
    const claimA = await claimNextOrFail(pools);
    await expireLease(claimA.operationId);
    const claimB = await claimNextOrFail(pools);

    expect(claimB.operationId).toBe(claimA.operationId);
    expect(BigInt(claimB.fencingToken)).toBeGreaterThan(BigInt(claimA.fencingToken));

    const before = await pools.operations.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.execution_events WHERE trip_id = $1`,
      [tripId],
    );
    const writeEvent = createFencedEventWriter(pools.operations);
    await writeEvent(
      { tripId, operationId: claimA.operationId, fencingToken: claimA.fencingToken },
      { type: "progress", payload: { message: "stale" } },
    );
    const after = await pools.operations.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.execution_events WHERE trip_id = $1`,
      [tripId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("fences lease renewal and completion for the old owner", async () => {
    await createFixtureTrip(pool);
    const claimA = await claimNextOrFail(pools);
    await expireLease(claimA.operationId);
    const claimB = await claimNextOrFail(pools);

    expect(await renewLease(pools.operations, claimA)).toBe(false);
    expect(
      await completeOperation(pools.operations, {
        operationId: claimA.operationId,
        fencingToken: claimA.fencingToken,
        status: "succeeded",
      }),
    ).toBe(false);

    // The current owner may still complete the same operation.
    expect(
      await completeOperation(pools.operations, {
        operationId: claimB.operationId,
        fencingToken: claimB.fencingToken,
        status: "succeeded",
      }),
    ).toBe(true);
  });

  it("a stale fenced effect runs no callback", async () => {
    await createFixtureTrip(pool);
    const claimA = await claimNextOrFail(pools);
    await expireLease(claimA.operationId);
    const claimB = await claimNextOrFail(pools);

    const effectsBefore = await pools.operations.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.workflow_effects WHERE operation_id = $1`,
      [claimA.operationId],
    );

    let ran = false;
    const runEffect = createFencedRunEffect(pools.operations, {
      operationId: claimA.operationId,
      tripId: claimA.tripId,
      fencingToken: claimA.fencingToken,
    });
    await expect(
      runEffect("stale-node", "scope", async () => {
        ran = true;
        return "stale";
      }),
    ).rejects.toBeInstanceOf(StaleFencingError);
    expect(ran).toBe(false);

    const effectsAfter = await pools.operations.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.workflow_effects WHERE operation_id = $1`,
      [claimA.operationId],
    );
    expect(effectsAfter.rows[0]?.count).toBe(effectsBefore.rows[0]?.count);

    // The current owner can still run the effect.
    const runCurrent = createFencedRunEffect(pools.operations, {
      operationId: claimB.operationId,
      tripId: claimB.tripId,
      fencingToken: claimB.fencingToken,
    });
    await expect(runCurrent("node", "scope", async () => "current")).resolves.toBe("current");
  });
});
