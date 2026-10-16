import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createGraphTestPool,
  createHarnessTrip,
  createWorkerPools,
  endWorkerPools,
  resetGraphDatabase,
  type WorkerPools,
} from "../graph/_setup.js";
import { runClaimLoop } from "../../../apps/worker/src/claim.js";
import { acquireTripLock, releaseTripLock } from "../../../apps/worker/src/trip-lock.js";
import { createShutdownController } from "../../../apps/worker/src/shutdown.js";
import type { OperationDriver } from "../../../apps/worker/src/driver.js";

/**
 * Worker lifecycle: a blocked run cannot hold the process past shutdown, and a
 * lost trip-lock connection does not crash the worker.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("worker lifecycle", () => {
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

  it("bounds shutdown even when an operation is blocked", async () => {
    const { tripId } = await createHarnessTrip(pool);
    const shutdown = createShutdownController(300);
    const hanging: OperationDriver = {
      runOperation: () => new Promise<void>(() => {}),
    };

    const loop = runClaimLoop({
      operationsPool: pools.operations,
      driver: hanging,
      shutdown,
      workerId: "test-worker",
      leaseMs: 30_000,
      concurrency: 1,
      pollIntervalMs: 50,
      graceMs: 300,
      logger: () => {},
    });

    // Wait until the hanging operation has been claimed.
    for (let i = 0; i < 100; i += 1) {
      const row = await pools.operations.query<{ status: string }>(
        `SELECT status FROM odft_app.workflow_operations WHERE trip_id = $1`,
        [tripId],
      );
      if (row.rows[0]?.status === "running") {
        break;
      }
      await sleep(20);
    }

    const started = Date.now();
    shutdown.requestStop("test");
    await Promise.race([
      loop,
      sleep(2_000).then(() => {
        throw new Error("claim loop did not stop within the grace window");
      }),
    ]);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("survives a lost trip-lock connection via onLost", async () => {
    const { tripId } = await createHarnessTrip(pool);
    let lostError: unknown;
    let resolveLost: () => void = () => {};
    const lost = new Promise<void>((resolve) => {
      resolveLost = resolve;
    });
    const lock = await acquireTripLock(pools.lock, tripId, {
      onLost: (error) => {
        lostError = error;
        resolveLost();
      },
    });
    expect(lock).toBeDefined();
    const held = lock as NonNullable<typeof lock>;
    const pid = (await held.client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
      ?.pid;
    await pool.query(`SELECT pg_terminate_backend($1)`, [pid]);
    await Promise.race([
      lost,
      sleep(3_000).then(() => {
        throw new Error("onLost was not called after the lock connection died");
      }),
    ]);
    expect(lostError).toBeDefined();
    // Releasing a dead lock must not throw.
    await releaseTripLock(held);
  });
});
