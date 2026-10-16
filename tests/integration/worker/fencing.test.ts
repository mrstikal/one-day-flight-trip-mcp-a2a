import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyCheckpoint } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  CHECKPOINT_SCHEMA,
  completeOperation,
  renewLease,
  StaleFencingError,
} from "@odft/persistence";
import { FencedSaver } from "../../../apps/worker/src/checkpointer/fenced-saver.js";
import {
  claimNextOrFail,
  createGraphTestPool,
  createHarnessDriver,
  createHarnessTrip,
  createWorkerPools,
  endWorkerPools,
  resetGraphDatabase,
  type WorkerPools,
} from "../graph/_setup.js";

/**
 * T-IT-FLT-07 / T-IT-LIM-04: single-writer fencing. After a lease rotates the
 * fencing token, the old worker cannot write graph state, events, or completion,
 * and the next claim completes the work instead.
 */

describe("worker lease fencing", () => {
  let pool: Pool;
  let pools: WorkerPools;

  beforeAll(async () => {
    pool = createGraphTestPool();
    pools = createWorkerPools();
    await resetGraphDatabase(pool);
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

  it("rejects a stale checkpoint write after the token rotates", async () => {
    const { tripId } = await createHarnessTrip(pool);
    const claimA = await claimNextOrFail(pools);
    await expireLease(claimA.operationId);
    const claimB = await claimNextOrFail(pools);

    expect(claimB.operationId).toBe(claimA.operationId);
    expect(BigInt(claimB.fencingToken)).toBeGreaterThan(BigInt(claimA.fencingToken));

    const staleSaver = new FencedSaver(
      new PostgresSaver(pools.saver, undefined, { schema: CHECKPOINT_SCHEMA }),
      pools.guard,
      {
        operationId: claimA.operationId,
        tripId,
        fencingToken: claimA.fencingToken,
      },
    );
    await expect(
      staleSaver.put(
        { configurable: { thread_id: tripId } },
        emptyCheckpoint(),
        { source: "input", step: 0, parents: {} },
        {},
      ),
    ).rejects.toBeInstanceOf(StaleFencingError);
  });

  it("fences lease renewal and completion for the old owner", async () => {
    await createHarnessTrip(pool);
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

  it("a stale worker attempt writes no events and no checkpoint", async () => {
    const { tripId } = await createHarnessTrip(pool);
    const driver = createHarnessDriver(pools);

    const claimA = await claimNextOrFail(pools);
    await expireLease(claimA.operationId);
    const claimB = await claimNextOrFail(pools);

    const before = await pools.operations.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.execution_events WHERE trip_id = $1`,
      [tripId],
    );
    const effectsBefore = await pools.operations.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.workflow_effects WHERE operation_id = $1`,
      [claimA.operationId],
    );

    // Simulate the old process finally running after losing the lease.
    await driver.runOperation(claimA);

    const after = await pools.operations.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.execution_events WHERE trip_id = $1`,
      [tripId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);

    // The fenced effect path also rejects the stale writer: no callback ran.
    const effectsAfter = await pools.operations.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.workflow_effects WHERE operation_id = $1`,
      [claimA.operationId],
    );
    expect(effectsAfter.rows[0]?.count).toBe(effectsBefore.rows[0]?.count);

    // The current owner can still drive the operation to a clean outcome.
    await driver.runOperation(claimB);
    const status = await pools.operations.query<{ status: string }>(
      `SELECT status FROM odft_app.workflow_operations WHERE id = $1`,
      [claimB.operationId],
    );
    expect(status.rows[0]?.status).toBe("waiting");
  });
});
