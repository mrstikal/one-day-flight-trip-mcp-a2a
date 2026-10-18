import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimOperationById,
  finalizeSuccess,
  finalizeWaiting,
  reapExhaustedOperations,
  reserveTaskMcpInvocation,
  upsertTaskControl,
} from "@odft/persistence";
import {
  createFlightDelegation,
  createMcpTestPool,
  createMcpTestWorkerPools,
  endWorkerPools,
  resetMcpDatabase,
  seedFlightDelegation,
  setupProtocolRoles,
  type SeededSnapshot,
  type WorkerPools,
} from "./_setup.js";

/**
 * Phase 05 shared lock graph (§3.8): finalizers/reapers acquire the trip lock
 * BEFORE the operation row, so concurrent reserve/finalize/control/reap
 * interleavings cannot ABBA-deadlock (`40P01`) or self-block across
 * connections.
 */

let pool: Pool;
let pools: WorkerPools;
let seeded: SeededSnapshot & { delegationId: string };

beforeAll(async () => {
  pool = createMcpTestPool();
  pools = createMcpTestWorkerPools();
  await resetMcpDatabase(pool);
  setupProtocolRoles();
  seeded = await seedFlightDelegation(pool, pools);
}, 120_000);

afterAll(async () => {
  await endWorkerPools(pools);
  await pool.end();
});

async function createClaimedOperation(): Promise<{ operationId: string; fence: string }> {
  const created = await pool.query<{ id: string }>(
    `INSERT INTO odft_app.workflow_operations
       (id, trip_id, request_id, payload_hash, accepted_revision, status, kind, payload, engine)
     VALUES (gen_random_uuid(), $1, gen_random_uuid(), $2, 1, 'queued', 'command', '{}'::jsonb, 'langgraph')
     RETURNING id`,
    [seeded.tripId, "9".repeat(64)],
  );
  const operationId = created.rows[0]?.id as string;
  const claimed = await claimOperationById(pool, operationId, { workerId: "lock-test-worker" });
  if (!claimed) {
    throw new Error("claim failed");
  }
  return { operationId, fence: claimed.fencingToken };
}

describe("shared transaction locking", () => {
  it("runs concurrent finalize/control/reap without deadlocks or self-blocking", async () => {
    const { operationId, fence } = await createClaimedOperation();
    const results = await Promise.allSettled([
      finalizeWaiting(
        pool,
        { tripId: seeded.tripId, operationId, fencingToken: fence },
        {
          kind: "flight_choice",
          fingerprint: "a".repeat(64),
          allowedOfferIds: ["demo-1"],
          allowedOptionIds: [],
          graphVersion: "travel-graph-v7",
          createdRevision: 1,
          engine: "langgraph",
        },
      ),
      finalizeSuccess(
        pool,
        { tripId: seeded.tripId, operationId, fencingToken: fence },
        {
          result: { summary: "concurrent" },
          summary: "concurrent success",
          workflowStatus: "ready",
        },
      ),
      pool.query(`SELECT id FROM odft_app.workflow_operations WHERE id = $1 FOR UPDATE`, [
        operationId,
      ]),
      reapExhaustedOperations(pool, { limit: 10 }),
    ]);
    for (const result of results) {
      expect(result.status).toBe("fulfilled");
    }
    // Exactly one of the two finalizers won; the other saw a stale fence.
    const outcomes = results
      .slice(0, 2)
      .map((result) => (result.status === "fulfilled" ? (result.value as boolean) : false));
    expect(outcomes.filter(Boolean).length).toBe(1);
  }, 60_000);

  it("reaps an exhausted lease-bound operation trip-first", async () => {
    const { operationId } = await createClaimedOperation();
    await pool.query(
      `UPDATE odft_app.workflow_operations
          SET auto_claims = 3, lease_expires_at = now() - interval '1 minute'
        WHERE id = $1`,
      [operationId],
    );
    const reaped = await reapExhaustedOperations(pool, { limit: 10 });
    expect(reaped).toBeGreaterThanOrEqual(1);
    const row = await pool.query<{ status: string }>(
      `SELECT status FROM odft_app.workflow_operations WHERE id = $1`,
      [operationId],
    );
    expect(row.rows[0]?.status).toBe("failed");
    const trip = await pool.query<{
      recovery_required: boolean;
      last_unfinished_operation_id: string;
    }>(`SELECT recovery_required, last_unfinished_operation_id FROM odft_app.trips WHERE id = $1`, [
      seeded.tripId,
    ]);
    expect(trip.rows[0]?.recovery_required).toBe(true);
    expect(trip.rows[0]?.last_unfinished_operation_id).toBe(operationId);
    // Reset the trip flag so later suites start clean.
    await pool.query(
      `UPDATE odft_app.trips SET recovery_required = false, last_unfinished_operation_id = NULL, workflow_status = 'ready' WHERE id = $1`,
      [seeded.tripId],
    );
  }, 60_000);

  it("does not deadlock a reserve against a finalizer (trip-first both sides)", async () => {
    const { operationId, fence } = await createClaimedOperation();
    const results = await Promise.allSettled([
      pool.query(`SELECT id FROM odft_app.trips WHERE id = $1 FOR UPDATE`, [seeded.tripId]),
      finalizeWaiting(
        pool,
        { tripId: seeded.tripId, operationId, fencingToken: fence },
        {
          kind: "clarification",
          fingerprint: "b".repeat(64),
          allowedOfferIds: [],
          allowedOptionIds: ["keep", "change"],
          graphVersion: "travel-graph-v7",
          createdRevision: 1,
          engine: "langgraph",
        },
      ),
    ]);
    for (const result of results) {
      expect(result.status).toBe("fulfilled");
    }
  }, 60_000);

  it("serializes a delegated paid reservation against a finalizer (trip-first both sides)", async () => {
    // The delegated ledger function locks trip -> delegation -> counters; the
    // finalizer locks trip -> operation. Both start at the trip row, so the
    // interleaving below must complete without `40P01` and the reservation must
    // actually win its slot.
    const { operationId, fence } = await createClaimedOperation();
    const delegationId = await createFlightDelegation(pool, seeded);
    const taskId = `lock-task-${randomUUID().slice(0, 8)}`;
    const claimed = await pool.query<{ claimed: boolean }>(
      `SELECT odft_app.claim_delegated_task('flight-agent', $1::uuid, $2) AS claimed`,
      [delegationId, taskId],
    );
    expect(claimed.rows[0]?.claimed).toBe(true);
    await upsertTaskControl(pool, {
      agentIdentity: "flight-agent",
      taskId,
      contextId: `ctx-${taskId}`,
      delegationId,
    });
    const results = await Promise.allSettled([
      pool.query<{ outcome: { ok: boolean; code?: string } }>(
        `SELECT odft_app.reserve_delegated_call(
            'flight-agent', $1::uuid, $2, 'trace-lock', 'recommendation:1',
            'recommendation', 'scripted/model', 'test', 'recommendation-v2', 'openrouter', 'test-pricing-v1',
            1000, 0.01, 0.05, 10, 1, 2, 0.1) AS outcome`,
        [delegationId, taskId],
      ),
      finalizeSuccess(
        pool,
        { tripId: seeded.tripId, operationId, fencingToken: fence },
        {
          result: { summary: "concurrent reserve" },
          summary: "concurrent reserve success",
          workflowStatus: "ready",
        },
      ),
      pool.query(`SELECT id FROM odft_app.trips WHERE id = $1 FOR UPDATE`, [seeded.tripId]),
    ]);
    for (const result of results) {
      expect(result.status).toBe("fulfilled");
    }
    const reservation = results[0] as PromiseFulfilledResult<{
      rows: { outcome: { ok: boolean; code?: string } }[];
    }>;
    expect(reservation.value.rows[0]?.outcome.ok).toBe(true);
  }, 60_000);

  it("atomically caps concurrent MCP invocations", async () => {
    const taskId = randomUUID();
    await upsertTaskControl(pool, {
      agentIdentity: "flight-agent",
      taskId,
      contextId: `ctx-${taskId}`,
    });
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        reserveTaskMcpInvocation(pool, {
          agentIdentity: "flight-agent",
          taskId,
          maxInvocations: 4,
        }),
      ),
    );
    // Exactly four callers win the conditional UPDATE; the rest are refused.
    expect(results.filter(Boolean)).toHaveLength(4);
    const stored = await pool.query<{ mcp_invocations: number }>(
      `SELECT mcp_invocations FROM odft_app.protocol_task_control
        WHERE agent_identity = 'flight-agent' AND task_id = $1`,
      [taskId],
    );
    expect(stored.rows[0]?.mcp_invocations).toBe(4);
  });
});
