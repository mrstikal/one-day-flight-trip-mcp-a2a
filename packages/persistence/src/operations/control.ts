import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ErrorEnvelope } from "@odft/contracts";
import { contentHash } from "../hash.js";
import { insertEvent } from "../events.js";
import { getActiveOperation } from "../operations.js";
import { lockTrip } from "../trips.js";

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
      const owner = await client.query<{ session_id: string }>(
        `SELECT session_id FROM odft_app.trips WHERE id = $1`,
        [tripId],
      );
      if (!owner.rows[0] || owner.rows[0].session_id !== sessionId) {
        await client.query("ROLLBACK");
        return error("NOT_FOUND", "trip not found");
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
