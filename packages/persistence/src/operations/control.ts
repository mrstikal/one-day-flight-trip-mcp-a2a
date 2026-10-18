import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ErrorEnvelope } from "@odft/contracts";
import { contentHash } from "../hash.js";
import { insertEvent } from "../events.js";
import { getActiveOperation } from "../operations.js";
import { lockTrip } from "../trips.js";
import { getActiveCoordinatorRun, updateCoordinatorRun } from "../coordinator-runs.js";
import { requestDelegationCancellation, revokeDelegation } from "../agent-delegations.js";
import { requestTaskCancellation } from "../protocol-tasks.js";

/**
 * Explicit owner technical retry (02-architecture.md section 6).
 *
 * Requeues the SAME latest failed unfinished operation with the same immutable
 * input, operation id, accepted revision, and effect scopes. It records a new
 * explicitly authorized recovery round (bounded automatic claims), never admits
 * a new business command, and never increments `trip.revision`.
 */

export interface RetryOperationOptions {
  readonly tripId: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly controlRequestId: string;
  readonly expectedRevision: number;
}

export interface RetryOperationResult {
  readonly status: "accepted";
  readonly operationId: string;
  readonly revision: number;
  readonly deduped: boolean;
}

function error(
  code: ErrorEnvelope["code"],
  message: string,
  extra: Partial<ErrorEnvelope> = {},
): ErrorEnvelope {
  return { code, message, retryable: false, ...extra };
}

/** Resolve a stored idempotency result, or a typed conflict on a payload mismatch. */
function storedRetryResult(
  row: { payload_hash: string; result: unknown },
  payloadHash: string,
): RetryOperationResult | ErrorEnvelope {
  if (row.payload_hash !== payloadHash) {
    return error("CONFLICT", "the control request id was reused with a different payload");
  }
  const stored = row.result as RetryOperationResult | null;
  if (!stored) {
    return error("CONFLICT", "stored control request has no result");
  }
  return { ...stored, deduped: true };
}

export async function retryOperation(
  pool: Pool,
  options: RetryOperationOptions,
): Promise<RetryOperationResult | ErrorEnvelope> {
  const { tripId, sessionId, operationId, controlRequestId, expectedRevision } = options;
  const payloadHash = contentHash({ operationId, controlRequestId, expectedRevision });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const preExisting = await client.query<{ payload_hash: string; result: unknown }>(
      `SELECT payload_hash, result FROM odft_app.workflow_control_requests
        WHERE trip_id = $1 AND control_request_id = $2`,
      [tripId, controlRequestId],
    );
    if (preExisting.rows[0]) {
      // Ownership is validated even on the dedupe path: another session must not
      // learn a foreign operation id or revision from a replayed control key.
      const owner = await client.query<{
        session_id: string;
        engine: string;
        archived_at: string | null;
      }>(
        `SELECT session_id, engine, archived_at::text AS archived_at FROM odft_app.trips WHERE id = $1`,
        [tripId],
      );
      if (!owner.rows[0] || owner.rows[0].session_id !== sessionId) {
        await client.query("ROLLBACK");
        return error("NOT_FOUND", "trip not found");
      }
      if (owner.rows[0].archived_at || owner.rows[0].engine === "langgraph") {
        await client.query("ROLLBACK");
        return error("TRIP_ARCHIVED", "archived or legacy trips are read-only history");
      }
      const stored = storedRetryResult(preExisting.rows[0], payloadHash);
      await client.query("COMMIT");
      return stored;
    }

    const trip = await lockTrip(client, tripId);
    if (!trip || trip.sessionId !== sessionId) {
      await client.query("ROLLBACK");
      return error("NOT_FOUND", "trip not found");
    }
    // Phase 09 history: archived trips are read-only.
    if (trip.archivedAt || trip.engine === "langgraph") {
      await client.query("ROLLBACK");
      return error("TRIP_ARCHIVED", "archived or legacy trips are read-only history");
    }
    if (trip.revision !== expectedRevision) {
      await client.query("ROLLBACK");
      return error("STALE_REVISION", "expected revision does not match the current revision", {
        currentRevision: trip.revision,
      });
    }

    // Re-check after taking the lock: a concurrent identical retry may have won
    // the race and returned before we acquired the lock.
    const raced = await client.query<{ payload_hash: string; result: unknown }>(
      `SELECT payload_hash, result FROM odft_app.workflow_control_requests
        WHERE trip_id = $1 AND control_request_id = $2`,
      [tripId, controlRequestId],
    );
    if (raced.rows[0]) {
      const stored = storedRetryResult(raced.rows[0], payloadHash);
      await client.query("COMMIT");
      return stored;
    }

    const target = await client.query<{
      id: string;
      status: string;
      created_at: string;
      lease_expired: boolean;
    }>(
      `SELECT id, status, created_at::text AS created_at,
              (lease_expires_at IS NOT NULL AND lease_expires_at < now()) AS lease_expired
         FROM odft_app.workflow_operations
        WHERE trip_id = $1 AND id = $2`,
      [tripId, operationId],
    );
    const row = target.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return error("NOT_FOUND", "operation not found");
    }
    // Recoverable = a terminal failure, or a crashed `running` operation whose
    // lease expired (its worker never marked it failed, e.g. SIGKILL).
    const recoverable = row.status === "failed" || (row.status === "running" && row.lease_expired);
    if (!recoverable) {
      const active = await getActiveOperation(client, tripId);
      if (active && active.id === operationId) {
        await client.query("ROLLBACK");
        return error("OPERATION_IN_PROGRESS", "the operation is already queued or running", {
          retryable: true,
        });
      }
      await client.query("ROLLBACK");
      return error("CONFLICT", "only a failed unfinished operation can be retried");
    }

    // The retry target must be the latest operation of the trip: ANY newer
    // operation (including succeeded/waiting) means this is not the latest
    // unfinished failure, so retrying it would re-run stale input past a newer run.
    // While the trip requires recovery, the recorded unfinished operation is the
    // exact target even when a newer rejected conflict row exists: a rejected
    // operation never advanced the graph, so it cannot supersede the owner of the
    // unfinished checkpoint (admission has blocked new work since the flag was set).
    const recordedUnfinished =
      trip.recoveryRequired && trip.lastUnfinishedOperationId === operationId;
    const newer = await client.query<{ id: string }>(
      `SELECT id FROM odft_app.workflow_operations
        WHERE trip_id = $1 AND created_at > $2
        LIMIT 1`,
      [tripId, row.created_at],
    );
    if (newer.rows[0] && !recordedUnfinished) {
      await client.query("ROLLBACK");
      return error("CONFLICT", "a newer operation exists; retry the latest failure");
    }

    await client.query(
      `UPDATE odft_app.workflow_operations
          SET status = 'queued',
              recovery_rounds = recovery_rounds + 1,
              auto_claims = 0,
              lease_expires_at = NULL,
              claimed_by = NULL,
              completed_at = NULL,
              updated_at = now()
        WHERE id = $1`,
      [operationId],
    );
    await client.query(
      `UPDATE odft_app.trips
          SET recovery_required = false, last_unfinished_operation_id = NULL,
              workflow_status = 'queued', updated_at = now()
        WHERE id = $1`,
      [tripId],
    );

    const result: RetryOperationResult = {
      status: "accepted",
      operationId,
      revision: trip.revision,
      deduped: false,
    };
    await client.query(
      `INSERT INTO odft_app.workflow_control_requests
         (id, trip_id, control_request_id, payload_hash, original_operation_id, result)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [randomUUID(), tripId, controlRequestId, payloadHash, operationId, JSON.stringify(result)],
    );
    await insertEvent(client, {
      tripId,
      operationId,
      type: "operation.retry_requested",
      payload: { recoveryRound: true },
    });
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Mark the trip as requiring owner recovery: an unfinished operation exhausted
 * its automatic claims. Ordinary commands are rejected with RECOVERY_REQUIRED
 * until the owner retries the same operation.
 */
export async function setRecoveryRequired(
  pool: Pool,
  tripId: string,
  operationId: string,
): Promise<void> {
  await pool.query(
    `UPDATE odft_app.trips
        SET recovery_required = true, workflow_status = 'failed',
            last_unfinished_operation_id = $2, updated_at = now()
      WHERE id = $1`,
    [tripId, operationId],
  );
}

export interface CancelOperationOptions {
  readonly tripId: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly controlRequestId: string;
  readonly expectedRevision: number;
}

export interface CancelOperationResult {
  readonly status: "cancelled";
  readonly operationId: string;
  readonly revision: number;
  readonly deduped: boolean;
}

/** Resolve a stored cancel result, or a typed conflict on a payload mismatch. */
function storedCancelResult(
  row: { payload_hash: string; result: unknown },
  payloadHash: string,
): CancelOperationResult | ErrorEnvelope {
  if (row.payload_hash !== payloadHash) {
    return error("CONFLICT", "the control request id was reused with a different payload");
  }
  const stored = row.result as CancelOperationResult | null;
  if (!stored || stored.status !== "cancelled") {
    return error("CONFLICT", "stored control request has no result");
  }
  return { ...stored, deduped: true };
}

/**
 * Phase 09 atomic local cancellation (ODTF_PLAN.md §3.13).
 *
 * One short transaction in Section 3.8's lock order (trip → operation →
 * delegation): the control request is deduplicated, the operation is marked
 * `cancelled` under its exact fencing token, owned pending/queued questions are
 * cancelled, active delegations are revoked with a durable remote-cancel
 * intent, and the fencing token rotates so late artifacts and lease recovery
 * can never resurrect the cancelled authority.
 * Reservations and committed domain changes are preserved: cancellation is not
 * a booking rollback. SDK task cancellation happens after commit (the durable
 * reconciler retries pending intents independently of the cancelled claim).
 *
 * Never increments `trip.revision`; a duplicate control request replays the
 * stored result with `deduped: true`.
 */
export async function cancelOperation(
  pool: Pool,
  options: CancelOperationOptions,
): Promise<CancelOperationResult | ErrorEnvelope> {
  const { tripId, sessionId, operationId, controlRequestId, expectedRevision } = options;
  const payloadHash = contentHash({ operationId, controlRequestId, expectedRevision });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const preExisting = await client.query<{ payload_hash: string; result: unknown }>(
      `SELECT payload_hash, result FROM odft_app.workflow_control_requests
        WHERE trip_id = $1 AND control_request_id = $2`,
      [tripId, controlRequestId],
    );
    if (preExisting.rows[0]) {
      // Ownership is validated even on the dedupe path: another session must not
      // learn a foreign operation id or revision from a replayed control key.
      const owner = await client.query<{
        session_id: string;
        engine: string;
        archived_at: string | null;
      }>(
        `SELECT session_id, engine, archived_at::text AS archived_at FROM odft_app.trips WHERE id = $1`,
        [tripId],
      );
      if (!owner.rows[0] || owner.rows[0].session_id !== sessionId) {
        await client.query("ROLLBACK");
        return error("NOT_FOUND", "trip not found");
      }
      // Phase 09 history: an archived trip replays nothing as accepted.
      if (owner.rows[0].archived_at || owner.rows[0].engine === "langgraph") {
        await client.query("ROLLBACK");
        return error("TRIP_ARCHIVED", "archived or legacy trips are read-only history");
      }
      const stored = storedCancelResult(preExisting.rows[0], payloadHash);
      await client.query("COMMIT");
      return stored;
    }

    // Section 3.8 lock order: trip first, then the operation row.
    const trip = await lockTrip(client, tripId);
    if (!trip || trip.sessionId !== sessionId) {
      await client.query("ROLLBACK");
      return error("NOT_FOUND", "trip not found");
    }
    if (trip.archivedAt || trip.engine === "langgraph") {
      await client.query("ROLLBACK");
      return error("TRIP_ARCHIVED", "archived or legacy trips are read-only history");
    }
    if (trip.revision !== expectedRevision) {
      await client.query("ROLLBACK");
      return error("STALE_REVISION", "expected revision does not match the current revision", {
        currentRevision: trip.revision,
      });
    }

    // Re-check after taking the lock: a concurrent identical cancel may have won
    // the race and returned before we acquired the lock.
    const raced = await client.query<{ payload_hash: string; result: unknown }>(
      `SELECT payload_hash, result FROM odft_app.workflow_control_requests
        WHERE trip_id = $1 AND control_request_id = $2`,
      [tripId, controlRequestId],
    );
    if (raced.rows[0]) {
      const stored = storedCancelResult(raced.rows[0], payloadHash);
      await client.query("COMMIT");
      return stored;
    }

    const target = await client.query<{
      id: string;
      status: string;
      fencing_token: string;
    }>(
      `SELECT id, status, fencing_token::text AS fencing_token
          FROM odft_app.workflow_operations
        WHERE trip_id = $1 AND id = $2
        FOR UPDATE`,
      [tripId, operationId],
    );
    const row = target.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return error("NOT_FOUND", "operation not found");
    }
    if (row.status !== "queued" && row.status !== "running" && row.status !== "waiting") {
      await client.query("ROLLBACK");
      return error("CONFLICT", "only a queued, running, or waiting operation can be cancelled");
    }
    // Only the trip's NEWEST non-terminal operation may be cancelled: every
    // prior decision leaves its own operation `waiting` forever, and
    // cancelling a stale row would revoke work owned by the live operation
    // (the UI targets the newest match; this is the server-side guard).
    const newer = await client.query<{ id: string }>(
      `SELECT id FROM odft_app.workflow_operations
        WHERE trip_id = $1 AND created_at > (SELECT created_at FROM odft_app.workflow_operations WHERE id = $2)
          AND status IN ('queued', 'running', 'waiting')
        LIMIT 1`,
      [tripId, operationId],
    );
    if (newer.rows[0]) {
      await client.query("ROLLBACK");
      return error("CONFLICT", "only the newest active operation can be cancelled");
    }

    // Rotate the fencing token BEFORE committing the cancellation so every
    // later stale write (including lease recovery of the old token) is rejected.
    // Cancelled authority can never be resurrected by retry/claim.
    const cancelled = await client.query(
      `UPDATE odft_app.workflow_operations
          SET status = 'cancelled',
              fencing_token = fencing_token + 1,
              lease_expires_at = NULL,
              claimed_by = NULL,
              completed_at = now(),
              updated_at = now()
        WHERE id = $1 AND fencing_token = $2::bigint
          AND status IN ('queued', 'running', 'waiting')`,
      [operationId, row.fencing_token],
    );
    if (cancelled.rowCount !== 1) {
      await client.query("ROLLBACK");
      return error("CONFLICT", "the operation settled before it could be cancelled", {
        retryable: true,
      });
    }

    // Cancel owned pending questions: the decisions bound to the cancelled
    // operation's coordinator run (ordinary decisions AND queued specialist
    // `agent_input` questions); answers to a cancelled question are refused by
    // the stale-decision guard. Decisions owned by a NEWER operation's run are
    // left alone — the live run may be about to consume them.
    const cancelledRun = await getActiveCoordinatorRun(client, tripId);
    const cancelledRunId =
      cancelledRun && cancelledRun.operationId === operationId ? cancelledRun.id : null;
    if (cancelledRunId) {
      await client.query(
        `UPDATE odft_app.pending_decisions
            SET status = 'cancelled', resolved_at = now()
          WHERE trip_id = $1 AND status = 'pending' AND coordinator_run_id = $2`,
        [tripId, cancelledRunId],
      );
    } else {
      // Graph-engine (non-coordinator) operations own no run: cancel only the
      // decisions created at the operation's accepted revision that no newer
      // run has taken over.
      await client.query(
        `UPDATE odft_app.pending_decisions
            SET status = 'cancelled', resolved_at = now()
          WHERE trip_id = $1 AND status = 'pending' AND coordinator_run_id IS NULL
            AND created_revision = $2`,
        [tripId, trip.revision],
      );
    }
    // A coordinator run bound to this operation parks as cancelled; its queued
    // specialist questions never promote afterwards.
    const activeRun = cancelledRun;
    if (activeRun && activeRun.operationId === operationId) {
      await updateCoordinatorRun(client, {
        runId: activeRun.id,
        step: "cancelled",
        status: "cancelled",
        runData: {
          ...activeRun.runData,
          questionQueue: [],
          drainPending: false,
          itineraryDelegationId: null,
        },
      });
    }

    // Delegation level: revoke active work and persist the durable remote-cancel
    // intent in the same commit (SDK cancellation itself happens after commit;
    // local revocation already makes late artifacts inadmissible).
    const delegations = await client.query<{
      id: string;
      agent_identity: string;
      task_id: string | null;
    }>(
      `SELECT id, agent_identity, task_id FROM odft_app.agent_delegations
        WHERE trip_id = $1 AND originating_operation_id = $2
          AND status IN ('pending', 'dispatched', 'working', 'input_required')
        ORDER BY id
        FOR UPDATE`,
      [tripId, operationId],
    );
    for (const delegation of delegations.rows) {
      await revokeDelegation(client, {
        delegationId: delegation.id,
        reason: "operation cancelled by the owner",
      });
      await requestDelegationCancellation(client, delegation.id);
      if (delegation.task_id) {
        await requestTaskCancellation(client, {
          agentIdentity: delegation.agent_identity,
          taskId: delegation.task_id,
        });
      }
    }

    // The trip returns to ready only when no other live work remains. Answered
    // decision operations stay `waiting` forever as audit rows; counting them
    // would leave a cancelled trip stuck in `queued`/`waiting_user`. A waiting
    // row only counts while it still owns a pending decision.
    const remaining = await client.query<{ id: string }>(
      `SELECT id FROM odft_app.workflow_operations
        WHERE trip_id = $1 AND id <> $2
          AND (status IN ('queued', 'running')
               OR (status = 'waiting'
                   AND EXISTS (
                        SELECT 1 FROM odft_app.pending_decisions d
                          JOIN odft_app.coordinator_runs r ON r.id = d.coordinator_run_id
                         WHERE d.trip_id = $1 AND d.status = 'pending'
                           AND r.operation_id = odft_app.workflow_operations.id)))
        LIMIT 1`,
      [tripId, operationId],
    );
    if (!remaining.rows[0]) {
      await client.query(
        `UPDATE odft_app.trips
            SET recovery_required = false, last_unfinished_operation_id = NULL,
                workflow_status = 'ready', updated_at = now()
          WHERE id = $1`,
        [tripId],
      );
    } else {
      await client.query(
        `UPDATE odft_app.trips
            SET last_unfinished_operation_id = NULL, updated_at = now()
          WHERE id = $1`,
        [tripId],
      );
    }

    const result: CancelOperationResult = {
      status: "cancelled",
      operationId,
      revision: trip.revision,
      deduped: false,
    };
    await client.query(
      `INSERT INTO odft_app.workflow_control_requests
         (id, trip_id, control_request_id, payload_hash, original_operation_id, result)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [randomUUID(), tripId, controlRequestId, payloadHash, operationId, JSON.stringify(result)],
    );
    await insertEvent(client, {
      tripId,
      operationId,
      type: "operation.cancel_requested",
      payload: { controlRequestId },
    });
    await insertEvent(client, {
      tripId,
      operationId,
      type: "operation.cancelled",
      payload: { controlRequestId },
    });
    await client.query("COMMIT");
    // The caller dispatches SDK task cancellation after commit from the stored
    // `cancellation_state = 'pending'` intents; see `reconcile.ts`.
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
