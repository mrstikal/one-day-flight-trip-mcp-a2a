import type { Pool } from "pg";
import { acquireCheckpointGate } from "./fencing.js";

/**
 * Durable operation claiming (02-architecture.md section 6).
 *
 * A worker claims eligible work with `FOR UPDATE SKIP LOCKED`, rotates the
 * fencing token, and sets a lease. Rotation acquires the same
 * `checkpoint-write:<tripId>` gate the fenced saver uses, so an already-admitted
 * checkpoint write finishes before a new token is committed and every later
 * stale write is rejected.
 */

export const DEFAULT_LEASE_MS = 60_000;
export const LEASE_RENEW_MS = 15_000;
/** Automatic claims allowed per explicitly authorized recovery round. */
export const MAX_AUTO_CLAIMS_PER_ROUND = 3;

export type ClaimedOperationKind = "command" | "creation" | "decision";

export interface ClaimedOperation {
  readonly operationId: string;
  readonly tripId: string;
  readonly requestId: string;
  readonly kind: ClaimedOperationKind;
  readonly payload: unknown;
  readonly acceptedRevision: number;
  readonly nodeName: string | null;
  /** PostgreSQL bigint carried as text. */
  readonly fencingToken: string;
  readonly attempts: number;
  readonly recoveryRounds: number;
  readonly autoClaims: number;
  readonly leaseExpiresAt: string;
}

export interface ClaimOptions {
  readonly workerId: string;
  readonly leaseMs?: number;
}

interface ClaimRow {
  id: string;
  trip_id: string;
  request_id: string;
  kind: ClaimedOperationKind;
  payload: unknown;
  accepted_revision: number;
  node_name: string | null;
  fencing_token: string;
  attempts: number;
  recovery_rounds: number;
  auto_claims: number;
  lease_expires_at: string;
}

function toClaimed(row: ClaimRow): ClaimedOperation {
  return {
    operationId: row.id,
    tripId: row.trip_id,
    requestId: row.request_id,
    kind: row.kind,
    payload: row.payload,
    acceptedRevision: row.accepted_revision,
    nodeName: row.node_name,
    fencingToken: row.fencing_token,
    attempts: row.attempts,
    recoveryRounds: row.recovery_rounds,
    autoClaims: row.auto_claims,
    leaseExpiresAt: row.lease_expires_at,
  };
}

const CLAIM_RETURNING =
  "id, trip_id, request_id, kind, payload, accepted_revision, node_name, fencing_token, " +
  "attempts, recovery_rounds, auto_claims, lease_expires_at::text AS lease_expires_at";

/**
 * Claim the oldest eligible operation, or return `null` when none is ready.
 *
 * Eligible work is `queued` or a `running` operation whose lease expired, and
 * only while fewer than {@link MAX_AUTO_CLAIMS_PER_ROUND} automatic claims have
 * been consumed in the current recovery round. A trip whose operation exhausted
 * its round is left for the owner's explicit technical retry.
 */
export async function claimNextOperation(
  pool: Pool,
  options: ClaimOptions,
): Promise<ClaimedOperation | null> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const selected = await client.query<{ id: string; trip_id: string }>(
      `SELECT id, trip_id
         FROM odft_app.workflow_operations
        WHERE auto_claims < $1
          AND (status = 'queued' OR (status = 'running' AND lease_expires_at < now()))
        ORDER BY created_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [MAX_AUTO_CLAIMS_PER_ROUND],
    );
    const candidate = selected.rows[0];
    if (!candidate) {
      await client.query("COMMIT");
      return null;
    }

    // Rotate the fencing token under the checkpoint gate before committing.
    await acquireCheckpointGate(client, candidate.trip_id);

    const updated = await client.query<ClaimRow>(
      `UPDATE odft_app.workflow_operations
          SET status = 'running',
              fencing_token = fencing_token + 1,
              lease_expires_at = now() + ($2::bigint * interval '1 millisecond'),
              claimed_by = $3,
              attempts = attempts + 1,
              auto_claims = auto_claims + 1,
              updated_at = now()
        WHERE id = $1
        RETURNING ${CLAIM_RETURNING}`,
      [candidate.id, leaseMs, options.workerId],
    );

    await client.query("COMMIT");
    return toClaimed(updated.rows[0] as ClaimRow);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Claim one specific operation by id (owner technical retry path). */
export async function claimOperationById(
  pool: Pool,
  operationId: string,
  options: ClaimOptions,
): Promise<ClaimedOperation | null> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<{ id: string; trip_id: string }>(
      `SELECT id, trip_id FROM odft_app.workflow_operations
        WHERE id = $1 AND auto_claims < $2
          AND (status = 'queued' OR (status = 'running' AND lease_expires_at < now()))
        FOR UPDATE SKIP LOCKED`,
      [operationId, MAX_AUTO_CLAIMS_PER_ROUND],
    );
    const candidate = selected.rows[0];
    if (!candidate) {
      await client.query("COMMIT");
      return null;
    }
    await acquireCheckpointGate(client, candidate.trip_id);
    const updated = await client.query<ClaimRow>(
      `UPDATE odft_app.workflow_operations
          SET status = 'running',
              fencing_token = fencing_token + 1,
              lease_expires_at = now() + ($2::bigint * interval '1 millisecond'),
              claimed_by = $3,
              attempts = attempts + 1,
              auto_claims = auto_claims + 1,
              updated_at = now()
        WHERE id = $1
        RETURNING ${CLAIM_RETURNING}`,
      [candidate.id, leaseMs, options.workerId],
    );
    await client.query("COMMIT");
    return toClaimed(updated.rows[0] as ClaimRow);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Reap operations that exhausted their automatic-claim budget while `running`
 * and whose lease expired (the worker crashed after its final claim). Without
 * this, such an operation blocks its trip forever: it is no longer claimable
 * (auto_claims >= max) and not retryable while its status is still `running`.
 *
 * Marks them `failed`, flags the trip for owner recovery, and records an event.
 * Returns the number reaped.
 */
export async function reapExhaustedOperations(pool: Pool, options: { limit?: number } = {}): Promise<number> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<{ id: string; trip_id: string }>(
      `SELECT id, trip_id
         FROM odft_app.workflow_operations
        WHERE status = 'running'
          AND auto_claims >= $1
          AND lease_expires_at < now()
        ORDER BY lease_expires_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $2`,
      [MAX_AUTO_CLAIMS_PER_ROUND, limit],
    );
    for (const row of selected.rows) {
      await client.query(
        `UPDATE odft_app.workflow_operations
            SET status = 'failed', lease_expires_at = NULL, claimed_by = NULL,
                completed_at = now(), updated_at = now()
          WHERE id = $1`,
        [row.id],
      );
      await client.query(
        `UPDATE odft_app.trips
            SET recovery_required = true, workflow_status = 'failed',
                last_unfinished_operation_id = $2, updated_at = now()
          WHERE id = $1`,
        [row.trip_id, row.id],
      );
      await client.query(
        `INSERT INTO odft_app.execution_events (trip_id, operation_id, type, payload)
         VALUES ($1, $2, 'operation.failed', $3::jsonb)`,
        [row.trip_id, row.id, JSON.stringify({ code: "CLAIM_BUDGET_EXHAUSTED" })],
      );
    }
    await client.query("COMMIT");
    return selected.rows.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
