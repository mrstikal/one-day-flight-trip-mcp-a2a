import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  admitOperation,
  admitResume,
  claimNextOperation,
  insertAgentDelegation,
  insertDecision,
  insertEvent,
  insertOperation,
} from "@odft/persistence";
import {
  createFixtureTrip,
  createTestPool,
  createWorkerPools,
  endWorkerPools,
  resetDatabase,
  type WorkerPools,
} from "../_setup.js";

/**
 * Phase 11 maintenance cutover evidence: the archival migration keeps legacy
 * domain/event rows, archives every LangGraph trip read-only, cancels unfinished
 * work and pending decisions, rotates fences, and leaves new rows defaulted to
 * the coordinator.
 */

const ARCHIVE_MIGRATION = fileURLToPath(
  new URL(
    "../../../packages/persistence/migrations/0018-archive-langgraph-trips.sql",
    import.meta.url,
  ),
);

describe("Phase 11 cutover migration", () => {
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

  it("defaults new trips, operations and decisions to the coordinator", async () => {
    const result = await pool.query<{
      table_name: string;
      column_default: string | null;
    }>(
      `SELECT table_name, column_default
         FROM information_schema.columns
        WHERE table_schema = 'odft_app'
          AND column_name = 'engine'
          AND table_name IN ('trips', 'workflow_operations', 'pending_decisions')
        ORDER BY table_name`,
    );
    expect(result.rows).toHaveLength(3);
    for (const row of result.rows) {
      expect(row.column_default, row.table_name).toContain("coordinator-v1");
    }
  });

  it("archives legacy trips read-only, cancels active work, and preserves history", async () => {
    const { tripId, sessionId } = await createFixtureTrip(pool);
    await pool.query(
      `UPDATE odft_app.trips SET engine = 'langgraph', workflow_status = 'queued' WHERE id = $1`,
      [tripId],
    );
    const operation = await pool.query<{ id: string; fencing_token: string }>(
      `UPDATE odft_app.workflow_operations
          SET engine = 'langgraph', status = 'waiting'
        WHERE trip_id = $1
        RETURNING id, fencing_token::text AS fencing_token`,
      [tripId],
    );
    const operationId = operation.rows[0]?.id as string;
    const active = await insertOperation(pool, {
      tripId,
      requestId: randomUUID(),
      payloadHash: "e".repeat(64),
      kind: "creation",
      acceptedRevision: 0,
      engine: "langgraph",
      payload: { schemaVersion: 1, requestId: randomUUID() },
    });
    const decisionId = await insertDecision(pool, {
      tripId,
      kind: "flight_choice",
      engine: "langgraph",
      threadId: tripId,
      graphVersion: "travel-graph-v7",
      createdRevision: 0,
      sourceFingerprint: "a".repeat(64),
      payloadHash: "b".repeat(64),
      allowedOfferIds: [],
    });
    await insertEvent(pool, {
      tripId,
      operationId: active.id,
      type: "graph.initialized",
      payload: { graphVersion: "travel-graph-v7", schemaVersion: 1 },
    });
    // The creation operation is parked (`waiting`); the second operation is
    // queued. Both must be cancelled, and the outstanding specialist delegation
    // must be revoked by the cutover.
    const delegation = await insertAgentDelegation(pool, {
      tripId,
      originatingOperationId: active.id,
      acceptedRevision: 0,
      skillId: "accommodation.recommend.v1",
      agentIdentity: "accommodation-agent",
      endpointUrl: "http://127.0.0.1:4402",
      snapshotId: randomUUID(),
      inputFingerprint: "c".repeat(64),
      scope: { domains: ["hotel"] },
    });
    const before = await pool.query<{ trips: string; events: string; operations: string }>(
      `SELECT (SELECT count(*)::text FROM odft_app.trips) AS trips,
              (SELECT count(*)::text FROM odft_app.execution_events) AS events,
              (SELECT count(*)::text FROM odft_app.workflow_operations) AS operations`,
    );

    const sql = await readFile(ARCHIVE_MIGRATION, "utf8");
    await pool.query(sql);

    const trip = await pool.query<{
      archived_at: string | null;
      archive_reason: string | null;
      workflow_status: string;
      recovery_required: boolean;
      last_unfinished_operation_id: string | null;
    }>(
      `SELECT archived_at::text AS archived_at, archive_reason, workflow_status,
              recovery_required, last_unfinished_operation_id
         FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    expect(trip.rows[0]?.archived_at).not.toBeNull();
    expect(trip.rows[0]?.archive_reason).toMatch(/Phase 11/);
    expect(trip.rows[0]?.workflow_status).toBe("failed");
    expect(trip.rows[0]?.recovery_required).toBe(false);
    expect(trip.rows[0]?.last_unfinished_operation_id).toBeNull();

    const cancelledOperation = await pool.query<{
      status: string;
      lease_expires_at: string | null;
      claimed_by: string | null;
      fencing_token: string;
    }>(
      `SELECT status, lease_expires_at::text AS lease_expires_at, claimed_by,
              fencing_token::text AS fencing_token
         FROM odft_app.workflow_operations WHERE id = $1`,
      [operationId],
    );
    expect(cancelledOperation.rows[0]?.status).toBe("cancelled");
    expect(cancelledOperation.rows[0]?.lease_expires_at).toBeNull();
    expect(cancelledOperation.rows[0]?.claimed_by).toBeNull();
    expect(BigInt(cancelledOperation.rows[0]?.fencing_token ?? "0")).toBeGreaterThan(
      BigInt(operation.rows[0]?.fencing_token ?? "0"),
    );

    const cancelledDecision = await pool.query<{ status: string; resolved_at: string | null }>(
      `SELECT status, resolved_at::text AS resolved_at
         FROM odft_app.pending_decisions WHERE id = $1`,
      [decisionId],
    );
    expect(cancelledDecision.rows[0]?.status).toBe("cancelled");
    expect(cancelledDecision.rows[0]?.resolved_at).not.toBeNull();

    const parked = await pool.query<{ status: string }>(
      `SELECT status FROM odft_app.workflow_operations WHERE id = $1`,
      [operationId],
    );
    expect(parked.rows[0]?.status).toBe("cancelled");
    const activeRow = await pool.query<{ status: string }>(
      `SELECT status FROM odft_app.workflow_operations WHERE id = $1`,
      [active.id],
    );
    expect(activeRow.rows[0]?.status).toBe("cancelled");
    const revoked = await pool.query<{ status: string; revoke_reason: string | null }>(
      `SELECT status, revoke_reason FROM odft_app.agent_delegations WHERE id = $1`,
      [delegation.id],
    );
    expect(revoked.rows[0]?.status).toBe("revoked");
    expect(revoked.rows[0]?.revoke_reason).toMatch(/Phase 11/);

    // Historical rows are retained, not deleted.
    const after = await pool.query<{ trips: string; events: string; operations: string }>(
      `SELECT (SELECT count(*)::text FROM odft_app.trips) AS trips,
              (SELECT count(*)::text FROM odft_app.execution_events) AS events,
              (SELECT count(*)::text FROM odft_app.workflow_operations) AS operations`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);

    // No worker may claim it, and no write may be admitted.
    expect(
      await claimNextOperation(pools.operations, {
        workerId: "cutover-test",
        leaseMs: 30_000,
        engines: ["langgraph"],
      }),
    ).toBeNull();
    const chat = await admitOperation(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: 0,
        chat: "hello",
      },
    });
    expect(chat).toMatchObject({ code: "TRIP_ARCHIVED" });
    const resume = await admitResume(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: 0,
        decisionId,
        response: { action: "choose_offer", offerId: "x" },
      },
    });
    expect(resume).toMatchObject({ code: "TRIP_ARCHIVED" });
  });

  it("is idempotent and never touches coordinator trips", async () => {
    const { tripId } = await createFixtureTrip(pool);
    const sql = await readFile(ARCHIVE_MIGRATION, "utf8");
    await pool.query(sql);
    await pool.query(sql);

    const trip = await pool.query<{ archived_at: string | null; engine: string }>(
      `SELECT archived_at::text AS archived_at, engine FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    expect(trip.rows[0]?.engine).toBe("coordinator-v1");
    expect(trip.rows[0]?.archived_at).toBeNull();

    const claim = await claimNextOperation(pools.operations, {
      workerId: "cutover-test",
      leaseMs: 30_000,
      engines: ["coordinator-v1"],
    });
    expect(claim?.tripId).toBe(tripId);
  });
});
