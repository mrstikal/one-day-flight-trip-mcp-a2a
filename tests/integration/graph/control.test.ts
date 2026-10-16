import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  admitOperation,
  claimNextOperation,
  reapExhaustedOperations,
  retryOperation,
} from "@odft/persistence";
import {
  claimNextOrFail,
  createAlwaysFailingDriver,
  createGraphTestPool,
  createHarnessDriver,
  createHarnessTrip,
  createWorkerPools,
  endWorkerPools,
  resetGraphDatabase,
  retryFailedOperation,
  type WorkerPools,
} from "./_setup.js";

/**
 * T-IT-LIM-04 / T-IT-INV-09: three automatic claims per recovery round, then the
 * owner's explicit technical retry only. Total claim/round counters stay
 * monotonic and a retry never changes `trip.revision`.
 */

describe("driver automatic-claim bounds and technical retry", () => {
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

  it("bounds automatic claims at 3 and requeues only via technical retry", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    const failing = createAlwaysFailingDriver(pools);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await failing.runOperation(await claimNextOrFail(pools));
      const row = await pools.operations.query<{ status: string; attempts: number }>(
        `SELECT status, attempts FROM odft_app.workflow_operations
          WHERE trip_id = $1 AND kind = 'creation'`,
        [tripId],
      );
      expect(row.rows[0]?.attempts).toBe(attempt);
      if (attempt < 3) {
        expect(row.rows[0]?.status).toBe("queued");
      }
    }

    const exhausted = await pools.operations.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM odft_app.workflow_operations
        WHERE trip_id = $1 AND kind = 'creation'`,
      [tripId],
    );
    expect(exhausted.rows[0]?.status).toBe("failed");

    // Not claimable again until the owner retries.
    const none = await claimNextOperation(pools.operations, { workerId: "test-worker" });
    expect(none).toBeNull();

    // Ordinary command is rejected with RECOVERY_REQUIRED.
    const command = await admitOperation(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: 1,
        command: { type: "retry_failed_domains" },
      },
    });
    expect("code" in command && command.code).toBe("RECOVERY_REQUIRED");

    // Explicit technical retry requeues the same operation without bumping revision.
    const retry = await retryFailedOperation(pool, {
      tripId,
      sessionId,
      operationId: (await pools.operations.query<{ id: string }>(
        `SELECT id FROM odft_app.workflow_operations WHERE trip_id = $1 AND kind = 'creation'`,
        [tripId],
      )).rows[0]?.id ?? "",
      expectedRevision: 1,
    });
    expect("status" in retry && retry.status).toBe("accepted");

    const revision = await pools.operations.query<{ revision: number; recovery_required: boolean }>(
      `SELECT revision, recovery_required FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    expect(revision.rows[0]?.revision).toBe(1);
    expect(revision.rows[0]?.recovery_required).toBe(false);

    // A new recovery round permits automatic claims again; counters stay monotonic.
    const healthy = createHarnessDriver(pools);
    await healthy.runOperation(await claimNextOrFail(pools));
    const final = await pools.operations.query<{
      status: string;
      attempts: number;
      recovery_rounds: number;
    }>(
      `SELECT status, attempts, recovery_rounds FROM odft_app.workflow_operations
        WHERE trip_id = $1 AND kind = 'creation'`,
      [tripId],
    );
    expect(final.rows[0]?.status).toBe("waiting");
    expect(final.rows[0]?.attempts).toBe(4);
    expect(final.rows[0]?.recovery_rounds).toBe(1);
  });

  it("reaps an operation that crashed after exhausting its claim budget", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    // Simulate SIGKILL after the third claim: still `running`, expired, budget spent.
    await pools.operations.query(
      `UPDATE odft_app.workflow_operations
          SET status = 'running', auto_claims = 3, attempts = 3,
              lease_expires_at = now() - interval '5 seconds'
        WHERE trip_id = $1`,
      [tripId],
    );

    const reaped = await reapExhaustedOperations(pools.operations);
    expect(reaped).toBe(1);

    const row = await pools.operations.query<{ status: string }>(
      `SELECT status FROM odft_app.workflow_operations WHERE trip_id = $1`,
      [tripId],
    );
    expect(row.rows[0]?.status).toBe("failed");

    const trip = await pools.operations.query<{ recovery_required: boolean }>(
      `SELECT recovery_required FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    expect(trip.rows[0]?.recovery_required).toBe(true);

    // The owner can now recover the same operation.
    const retry = await retryFailedOperation(pool, {
      tripId,
      sessionId,
      operationId: (await pools.operations.query<{ id: string }>(
        `SELECT id FROM odft_app.workflow_operations WHERE trip_id = $1`,
        [tripId],
      )).rows[0]?.id ?? "",
      expectedRevision: 1,
    });
    expect("status" in retry && retry.status).toBe("accepted");
  });

  it("retries a crashed `running` operation whose lease expired", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await pools.operations.query(
      `UPDATE odft_app.workflow_operations
          SET status = 'running', auto_claims = 1, attempts = 1,
              lease_expires_at = now() - interval '5 seconds'
        WHERE trip_id = $1`,
      [tripId],
    );
    const operationId = (await pools.operations.query<{ id: string }>(
      `SELECT id FROM odft_app.workflow_operations WHERE trip_id = $1`,
      [tripId],
    )).rows[0]?.id as string;
    const retry = await retryFailedOperation(pool, {
      tripId,
      sessionId,
      operationId,
      expectedRevision: 1,
    });
    expect("status" in retry && retry.status).toBe("accepted");
  });

  it("refuses to retry when a newer operation exists (any status)", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    const created = await pools.operations.query<{ id: string }>(
      `SELECT id FROM odft_app.workflow_operations WHERE trip_id = $1`,
      [tripId],
    );
    const olderId = created.rows[0]?.id as string;
    await pools.operations.query(
      `UPDATE odft_app.workflow_operations SET status = 'failed', auto_claims = 3 WHERE id = $1`,
      [olderId],
    );
    // A newer already-succeeded operation must block retrying the older failure.
    await pools.operations.query(
      `INSERT INTO odft_app.workflow_operations
         (id, trip_id, request_id, payload_hash, accepted_revision, status, kind, payload, created_at)
       VALUES ($1, $2, $3, repeat('a', 64), 1, 'succeeded', 'decision', '{}'::jsonb, now() + interval '1 second')`,
      [randomUUID(), tripId, randomUUID()],
    );
    const retry = await retryFailedOperation(pool, {
      tripId,
      sessionId,
      operationId: olderId,
      expectedRevision: 1,
    });
    expect("code" in retry && retry.code).toBe("CONFLICT");
  });

  it("validates ownership and payload on the dedupe path", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    const operationId = (await pools.operations.query<{ id: string }>(
      `SELECT id FROM odft_app.workflow_operations WHERE trip_id = $1`,
      [tripId],
    )).rows[0]?.id as string;
    await pools.operations.query(
      `UPDATE odft_app.workflow_operations SET status = 'failed', auto_claims = 3 WHERE id = $1`,
      [operationId],
    );
    const controlRequestId = randomUUID();
    const first = await retryOperation(pool, {
      tripId,
      sessionId,
      operationId,
      controlRequestId,
      expectedRevision: 1,
    });
    expect("status" in first && first.status).toBe("accepted");

    // Replaying the same control key returns the stored result (idempotent).
    const replay = await retryOperation(pool, {
      tripId,
      sessionId,
      operationId,
      controlRequestId,
      expectedRevision: 1,
    });
    expect("deduped" in replay && replay.deduped).toBe(true);

    // A foreign session replaying a known key gets a uniform NOT_FOUND.
    const foreign = await retryOperation(pool, {
      tripId,
      sessionId: randomUUID(),
      operationId,
      controlRequestId,
      expectedRevision: 1,
    });
    expect("code" in foreign && foreign.code).toBe("NOT_FOUND");

    // Reusing the key with a changed payload is a conflict.
    const changed = await retryOperation(pool, {
      tripId,
      sessionId,
      operationId,
      controlRequestId,
      expectedRevision: 2,
    });
    expect("code" in changed && changed.code).toBe("CONFLICT");
  });
});
