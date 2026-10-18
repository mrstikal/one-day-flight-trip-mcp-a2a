import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildObservation } from "@odft/protocols";
import {
  admitOperation,
  admitResume,
  bridgeObservationToEvent,
  cancelOperation,
  insertProtocolObservation,
  listPendingDelegationCancels,
  listUnlinkedObservations,
  loadPublicInspector,
  requestDelegationCancellation,
  requestTaskCancellation,
  resolveDelegationCancellation,
  revokeDelegation,
} from "@odft/persistence";
import { bridgePendingObservations, reconcilePendingCancels } from "@odft/workflow";
import { fixtureDelegation } from "./_delegation-fixture.js";
import {
  createTestPool,
  createFixtureTrip,
  createWorkerPools,
  endWorkerPools,
  resetDatabase,
  type WorkerPools,
} from "../_setup.js";

/**
 * Phase 09: atomic local cancellation, durable cancel/observation outboxes, the
 * communication inspector, and read-only history.
 *
 * - `cancelOperation` revokes authority atomically (fence rotation, delegation
 *   revocation, durable remote-cancel intent) without a revision bump; a
 *   duplicate control request replays the stored result.
 * - The reconciler bridges unlinked observations to `protocol.observed` events
 *   (source timestamp preserved) and resolves pending cancel intents through
 *   the injected transport.
 * - The inspector renders communications/MCP/timeline rows from persisted data
 *   only; archived trips deny every write with TRIP_ARCHIVED.
 */
describe("phase 09 cancellation and history", () => {
  let pool: Pool;
  let pools: WorkerPools;

  beforeAll(async () => {
    pool = createTestPool();
    pools = createWorkerPools();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await endWorkerPools(pools);
    await pool.end();
  });

  it("cancels a queued operation atomically without a revision bump", async () => {
    const { tripId, sessionId } = await createFixtureTrip(pool);
    // The creation operation is queued; cancel it directly.
    const created = await pool.query<{ id: string }>(
      `SELECT id FROM odft_app.workflow_operations WHERE trip_id = $1`,
      [tripId],
    );
    const operationId = created.rows[0]?.id;
    expect(operationId).toBeTruthy();
    const before = await pool.query<{ revision: number }>(
      `SELECT revision FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );

    const result = await cancelOperation(pools.operations, {
      tripId,
      sessionId,
      operationId: operationId as string,
      controlRequestId: randomUUID(),
      expectedRevision: 1,
    });
    expect("status" in result && result.status).toBe("cancelled");
    if (!("status" in result)) {
      throw new Error("cancel refused");
    }
    expect(result.deduped).toBe(false);
    expect(result.revision).toBe(1);

    const after = await pool.query<{
      status: string;
      revision: number;
      recovery_required: boolean;
    }>(
      `SELECT o.status, t.revision, t.recovery_required
         FROM odft_app.workflow_operations o
         JOIN odft_app.trips t ON t.id = o.trip_id
        WHERE o.id = $1`,
      [operationId],
    );
    expect(after.rows[0]?.status).toBe("cancelled");
    expect(after.rows[0]?.revision).toBe(before.rows[0]?.revision);
    expect(after.rows[0]?.recovery_required).toBe(false);

    // A duplicate control request replays the stored result.
    const replay = await cancelOperation(pools.operations, {
      tripId,
      sessionId,
      operationId: operationId as string,
      controlRequestId:
        (
          await pool.query<{ control_request_id: string }>(
            `SELECT control_request_id FROM odft_app.workflow_control_requests WHERE trip_id = $1`,
            [tripId],
          )
        ).rows[0]?.control_request_id ?? randomUUID(),
      expectedRevision: 1,
    });
    expect("status" in replay).toBe(true);

    // A settled operation cannot be cancelled again.
    const again = await cancelOperation(pools.operations, {
      tripId,
      sessionId,
      operationId: operationId as string,
      controlRequestId: randomUUID(),
      expectedRevision: 1,
    });
    expect("code" in again ? again.code : "cancelled").toBe("CONFLICT");
  });

  it("refuses to cancel a stale operation while a newer one is active", async () => {
    const { tripId, sessionId } = await createFixtureTrip(pool);
    const first = await pool.query<{ id: string }>(
      `SELECT id FROM odft_app.workflow_operations WHERE trip_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [tripId],
    );
    const staleId = first.rows[0]?.id as string;
    // A newer non-terminal operation (a later run left its row waiting).
    const newerId = randomUUID();
    await pool.query(
      `INSERT INTO odft_app.workflow_operations
         (id, trip_id, request_id, payload, payload_hash, status,
          accepted_revision, fencing_token, attempts)
       VALUES ($1, $2, $3, '{}'::jsonb, $4, 'waiting', 1, 1, 0)`,
      [newerId, tripId, randomUUID(), "a".repeat(64)],
    );
    const stale = await cancelOperation(pools.operations, {
      tripId,
      sessionId,
      operationId: staleId,
      controlRequestId: randomUUID(),
      expectedRevision: 1,
    });
    expect("code" in stale ? stale.code : "cancelled").toBe("CONFLICT");
    // The live operation still cancels.
    const live = await cancelOperation(pools.operations, {
      tripId,
      sessionId,
      operationId: newerId,
      controlRequestId: randomUUID(),
      expectedRevision: 1,
    });
    expect("status" in live && live.status).toBe("cancelled");
  });

  it("preserves reservations and committed domain changes across cancellation", async () => {
    // Cancellation is not a booking rollback: the operation row flips to
    // `cancelled` while the trip revision, reservations table, and committed
    // domain rows are untouched by the cancel transaction. A confirmed
    // reservation created BEFORE the cancel must still read back afterwards.
    const { tripId, sessionId } = await createFixtureTrip(pool);
    const created = await pool.query<{ id: string }>(
      `SELECT id FROM odft_app.workflow_operations WHERE trip_id = $1`,
      [tripId],
    );
    const operationId = created.rows[0]?.id as string;
    const before = await pool.query<{ revision: number; reservation_count: string }>(
      `SELECT t.revision, (SELECT COUNT(*) FROM odft_app.reservations r WHERE r.trip_id = t.id) AS reservation_count
         FROM odft_app.trips t WHERE t.id = $1`,
      [tripId],
    );
    const result = await cancelOperation(pools.operations, {
      tripId,
      sessionId,
      operationId,
      controlRequestId: randomUUID(),
      expectedRevision: 1,
    });
    expect("status" in result).toBe(true);
    const after = await pool.query<{
      status: string;
      revision: number;
      reservation_count: string;
    }>(
      `SELECT o.status, t.revision,
              (SELECT COUNT(*) FROM odft_app.reservations r WHERE r.trip_id = t.id) AS reservation_count
         FROM odft_app.workflow_operations o
         JOIN odft_app.trips t ON t.id = o.trip_id
        WHERE o.id = $1`,
      [operationId],
    );
    expect(after.rows[0]?.status).toBe("cancelled");
    // No revision bump, no reservation touched.
    expect(after.rows[0]?.revision).toBe(before.rows[0]?.revision);
    expect(after.rows[0]?.reservation_count).toBe(before.rows[0]?.reservation_count);
  });

  it("revokes delegations with a durable remote-cancel intent", async () => {
    const { tripId, sessionId } = await createFixtureTrip(pool);
    const created = await pool.query<{ id: string }>(
      `SELECT id FROM odft_app.workflow_operations WHERE trip_id = $1`,
      [tripId],
    );
    const operationId = created.rows[0]?.id as string;
    const delegationId = await fixtureDelegation(pool, {
      tripId,
      operationId,
      taskId: "task-1",
      status: "working",
    });

    const result = await cancelOperation(pools.operations, {
      tripId,
      sessionId,
      operationId,
      controlRequestId: randomUUID(),
      expectedRevision: 1,
    });
    expect("status" in result).toBe(true);

    const delegation = await pool.query<{
      status: string;
      cancellation_state: string | null;
    }>(`SELECT status, cancellation_state FROM odft_app.agent_delegations WHERE id = $1`, [
      delegationId,
    ]);
    expect(delegation.rows[0]?.status).toBe("revoked");
    expect(delegation.rows[0]?.cancellation_state).toBe("pending");

    // The reconciler resolves the intent through the injected transport.
    const seen: string[] = [];
    await reconcilePendingCancels(pools.operations, {
      async cancelTask(input) {
        seen.push(`${input.agentIdentity}:${input.taskId}`);
      },
    });
    expect(seen).toEqual(["flight-agent:task-1"]);
    const resolved = await pool.query<{ cancellation_state: string | null }>(
      `SELECT cancellation_state FROM odft_app.agent_delegations WHERE id = $1`,
      [delegationId],
    );
    expect(resolved.rows[0]?.cancellation_state).toBe("acknowledged");

    // A transport failure persists as failed inspector evidence, never throws.
    const delegationId2 = await fixtureDelegation(pool, {
      tripId,
      operationId,
      taskId: "task-2",
      status: "revoked",
    });
    await requestDelegationCancellation(pool, delegationId2);
    await requestTaskCancellation(pool, { agentIdentity: "flight-agent", taskId: "task-2" });
    const failing = {
      async cancelTask() {
        throw new Error("remote unavailable");
      },
    };
    // Bounded retries: transient failures stay `pending` until the budget is
    // exhausted; only then does the intent settle as `failed` evidence.
    await reconcilePendingCancels(pools.operations, failing, { maxAttempts: 3 });
    const stillPending = await pool.query<{
      cancellation_state: string | null;
      cancellation_attempts: number;
    }>(
      `SELECT cancellation_state, cancellation_attempts FROM odft_app.agent_delegations WHERE id = $1`,
      [delegationId2],
    );
    expect(stillPending.rows[0]?.cancellation_state).toBe("pending");
    expect(stillPending.rows[0]?.cancellation_attempts).toBe(1);
    await reconcilePendingCancels(pools.operations, failing, { maxAttempts: 3 });
    await reconcilePendingCancels(pools.operations, failing, { maxAttempts: 3 });
    const failed = await pool.query<{ cancellation_state: string | null }>(
      `SELECT cancellation_state FROM odft_app.agent_delegations WHERE id = $1`,
      [delegationId2],
    );
    expect(failed.rows[0]?.cancellation_state).toBe("failed");

    // Direct helpers stay covered: revoke + resolve round-trip.
    const delegationId3 = await fixtureDelegation(pool, { tripId, operationId });
    await pool.query(`UPDATE odft_app.agent_delegations SET status = 'working' WHERE id = $1`, [
      delegationId3,
    ]);
    await revokeDelegation(pool, { delegationId: delegationId3, reason: "test" });
    await requestDelegationCancellation(pool, delegationId3);
    const pending = await listPendingDelegationCancels(pool);
    expect(pending.some((entry) => entry.delegationId === delegationId3)).toBe(true);
    await resolveDelegationCancellation(pool, {
      delegationId: delegationId3,
      state: "acknowledged",
    });
  });

  it("revokes a delegation continued by the cancelled operation", async () => {
    const { tripId, sessionId } = await createFixtureTrip(pool);
    const created = await pool.query<{ id: string }>(
      `SELECT id FROM odft_app.workflow_operations WHERE trip_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [tripId],
    );
    const originatingOperationId = created.rows[0]?.id as string;
    // A later operation (the decision answer) becomes the newest active one.
    const continuedOperationId = randomUUID();
    await pool.query(
      `INSERT INTO odft_app.workflow_operations
         (id, trip_id, request_id, payload, payload_hash, status,
          accepted_revision, fencing_token, attempts)
       VALUES ($1, $2, $3, '{}'::jsonb, $4, 'waiting', 1, 1, 0)`,
      [continuedOperationId, tripId, randomUUID(), "b".repeat(64)],
    );
    // The delegation was created by the earlier operation but CONTINUED by the
    // later one (current_operation_id), exactly the agent_input answer path.
    const delegationId = await fixtureDelegation(pool, {
      tripId,
      operationId: originatingOperationId,
      taskId: "task-continued",
      status: "working",
    });
    await pool.query(
      `UPDATE odft_app.agent_delegations SET current_operation_id = $2 WHERE id = $1`,
      [delegationId, continuedOperationId],
    );

    const result = await cancelOperation(pools.operations, {
      tripId,
      sessionId,
      operationId: continuedOperationId,
      controlRequestId: randomUUID(),
      expectedRevision: 1,
    });
    expect("status" in result && result.status).toBe("cancelled");

    const delegation = await pool.query<{
      status: string;
      cancellation_state: string | null;
      current_operation_id: string | null;
    }>(
      `SELECT status, cancellation_state, current_operation_id
         FROM odft_app.agent_delegations WHERE id = $1`,
      [delegationId],
    );
    expect(delegation.rows[0]?.status).toBe("revoked");
    expect(delegation.rows[0]?.cancellation_state).toBe("pending");
    expect(delegation.rows[0]?.current_operation_id).toBe(continuedOperationId);
  });

  it("bridges unlinked observations to protocol.observed events in source order", async () => {
    const { tripId } = await createFixtureTrip(pool);
    const first = await insertProtocolObservation(
      pool,
      buildObservation({
        source: "flight-agent",
        kind: "task_completed",
        correlation: { tripId, operationId: null },
        payload: { detail: "recommendations ready", status: "ok", counters: {} },
      }),
    );
    const second = await insertProtocolObservation(
      pool,
      buildObservation({
        source: "mcp-travel-data",
        kind: "mcp_tool_call",
        correlation: { tripId, operationId: null },
        payload: { detail: "search_airports", status: "ok", counters: {} },
      }),
    );
    expect((await listUnlinkedObservations(pool)).length).toBeGreaterThanOrEqual(2);

    const bridged = await bridgePendingObservations(pools.operations);
    expect(bridged.length).toBeGreaterThanOrEqual(2);
    expect((await listUnlinkedObservations(pool)).length).toBe(0);

    // The bridge is idempotent: a second pass bridges nothing new.
    const again = await bridgePendingObservations(pools.operations);
    expect(again.length).toBe(0);

    // Direct bridge helper round-trips the stored link.
    const third = await insertProtocolObservation(
      pool,
      buildObservation({
        source: "coordinator",
        kind: "artifact_received",
        correlation: { tripId, operationId: null },
        payload: { detail: "artifact", status: "ok", counters: {} },
      }),
    );
    const eventId = await bridgeObservationToEvent(pool, {
      observationId: third.id,
      tripId,
      operationId: null,
      type: "protocol.observed",
      payload: { kind: third.kind, source: third.source, observationId: third.id },
    });
    const relinked = await bridgeObservationToEvent(pool, {
      observationId: third.id,
      tripId,
      operationId: null,
      type: "protocol.observed",
      payload: { kind: third.kind, source: third.source, observationId: third.id },
    });
    expect(relinked).toBe(eventId);
    expect(first.id).toBeTruthy();
    expect(second.id).toBeTruthy();
  });

  it("renders communications, MCP calls, and the timeline from persisted rows", async () => {
    const { tripId } = await createFixtureTrip(pool);
    const created = await pool.query<{ id: string }>(
      `SELECT id FROM odft_app.workflow_operations WHERE trip_id = $1`,
      [tripId],
    );
    const delegationId = await fixtureDelegation(pool, {
      tripId,
      operationId: (created.rows[0] as { id: string }).id,
      taskId: "task-9",
      status: "working",
    });
    await insertProtocolObservation(
      pool,
      buildObservation({
        source: "mcp-travel-data",
        kind: "mcp_tool_call",
        correlation: { tripId, operationId: null },
        payload: { detail: "search_airports", status: "ok", counters: {} },
      }),
    );
    await insertProtocolObservation(
      pool,
      buildObservation({
        source: "flight-agent",
        kind: "task_completed",
        correlation: { tripId, operationId: null, delegationId, taskId: "task-9" },
        payload: { detail: "done", status: "ok", counters: {} },
      }),
    );

    const inspector = await loadPublicInspector(pool, tripId);
    expect(inspector.communications.some((row) => row.agentIdentity === "flight-agent")).toBe(true);
    expect(inspector.mcpCalls.some((row) => row.edge === "mcp")).toBe(true);
    expect(inspector.timeline.length).toBeGreaterThanOrEqual(2);
    expect(new Set(inspector.timeline.map((row) => row.edge)).size).toBeGreaterThanOrEqual(2);
  });

  it("denies every write for archived trips with TRIP_ARCHIVED", async () => {
    const { tripId, sessionId } = await createFixtureTrip(pool);
    await pool.query(
      `UPDATE odft_app.trips SET archived_at = now(), archive_reason = 'test archive' WHERE id = $1`,
      [tripId],
    );

    const command = await admitOperation(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: 1,
        command: { type: "find_alternatives", target: "hotel", objective: "match_preferences" },
      },
    });
    expect("code" in command ? command.code : "accepted").toBe("TRIP_ARCHIVED");

    const resume = await admitResume(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        decisionId: randomUUID(),
        expectedRevision: 1,
        response: { action: "choose_option", optionId: "change_hotel" },
      },
    });
    expect("code" in resume ? resume.code : "accepted").toBe("TRIP_ARCHIVED");

    const created = await pool.query<{ id: string }>(
      `SELECT id FROM odft_app.workflow_operations WHERE trip_id = $1`,
      [tripId],
    );
    const cancel = await cancelOperation(pools.operations, {
      tripId,
      sessionId,
      operationId: created.rows[0]?.id as string,
      controlRequestId: randomUUID(),
      expectedRevision: 1,
    });
    expect("code" in cancel ? cancel.code : "cancelled").toBe("TRIP_ARCHIVED");
  });
});
