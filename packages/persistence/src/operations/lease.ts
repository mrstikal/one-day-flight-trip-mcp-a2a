import type { Pool } from "pg";
import type { OperationStatus } from "@odft/contracts";
import { DEFAULT_LEASE_MS, type ClaimedOperation } from "./claim.js";

/**
 * Lease renewal and operation completion. Every write is fenced by the exact
 * token the worker was admitted with; a lost lease/lock makes these no-ops, so
 * a slow old process cannot overwrite a newer owner's state.
 */

/** Extend the lease for a still-current owner. Returns false when fenced out. */
export async function renewLease(
  pool: Pool,
  claim: ClaimedOperation,
  leaseMs: number = DEFAULT_LEASE_MS,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE odft_app.workflow_operations
        SET lease_expires_at = now() + ($3::bigint * interval '1 millisecond'),
            updated_at = now()
      WHERE id = $1 AND fencing_token = $2 AND status = 'running'`,
    [claim.operationId, claim.fencingToken, leaseMs],
  );
  return result.rowCount === 1;
}

export interface CompleteOperationInput {
  readonly operationId: string;
  readonly fencingToken: string;
  readonly status: Extract<OperationStatus, "succeeded" | "waiting" | "failed" | "cancelled">;
  readonly result?: unknown;
  /** Reset the per-round automatic claim counter (only for an owner retry). */
  readonly resetAutoClaims?: boolean;
}

/**
 * Persist a terminal/waiting operation outcome under the fencing token. The
 * lease is cleared so a `waiting` operation no longer blocks the trip.
 */
export async function completeOperation(
  pool: Pool,
  input: CompleteOperationInput,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE odft_app.workflow_operations
        SET status = $3,
            result = COALESCE($4::jsonb, result),
            lease_expires_at = NULL,
            claimed_by = NULL,
            auto_claims = CASE WHEN $5 THEN 0 ELSE auto_claims END,
            completed_at = CASE WHEN $3 IN ('succeeded','failed','cancelled') THEN now() ELSE NULL END,
            updated_at = now()
      WHERE id = $1 AND fencing_token = $2 AND status = 'running'`,
    [
      input.operationId,
      input.fencingToken,
      input.status,
      input.result === undefined ? null : JSON.stringify(input.result),
      input.resetAutoClaims ?? false,
    ],
  );
  return result.rowCount === 1;
}

/**
 * Release a claimed operation back to `queued` without rotating the token (used
 * when the worker cannot start work, e.g. the trip row vanished). The next
 * claim rotates the token.
 */
export async function releaseClaim(
  pool: Pool,
  claim: ClaimedOperation,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE odft_app.workflow_operations
        SET status = 'queued', lease_expires_at = NULL, claimed_by = NULL, updated_at = now()
      WHERE id = $1 AND fencing_token = $2 AND status = 'running'`,
    [claim.operationId, claim.fencingToken],
  );
  return result.rowCount === 1;
}
