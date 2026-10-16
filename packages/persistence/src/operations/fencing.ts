import type { Pool, PoolClient } from "pg";

/**
 * Fencing primitives shared by the worker driver and the fenced checkpoint
 * saver (02-architecture.md section 6). A single-writer rule guards both domain
 * writes and official-saver writes: a write is accepted only while the
 * operation is `running` under the exact fencing token the writer was admitted
 * with.
 */

/** The immutable identity of the operation a writer was admitted for. */
export interface OperationFencingContext {
  readonly operationId: string;
  readonly tripId: string;
  /** `workflow_operations.fencing_token` (PostgreSQL bigint, carried as text). */
  readonly fencingToken: string;
}

/** Non-locking ownership read of the current operation state. */
export interface OperationOwnership {
  readonly id: string;
  readonly tripId: string;
  readonly status: string;
  readonly fencingToken: string;
}

/** A write attempted after the operation's fencing token rotated or it ended. */
export class StaleFencingError extends Error {
  readonly operationId: string;

  constructor(operationId: string) {
    super(`stale fencing token for operation ${operationId}`);
    this.name = "StaleFencingError";
    this.operationId = operationId;
  }
}

/** The transaction-scoped advisory gate key that serializes checkpoint writes. */
export function checkpointGateKey(tripId: string): string {
  return `checkpoint-write:${tripId}`;
}

/**
 * Acquire the transaction-scoped checkpoint gate. The caller must already be
 * inside a transaction; the lock is released automatically on COMMIT/ROLLBACK
 * and is therefore never leaked by a crashed connection.
 */
export async function acquireCheckpointGate(
  client: Pick<PoolClient, "query">,
  tripId: string,
): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    checkpointGateKey(tripId),
  ]);
}

/**
 * Read the current operation ownership WITHOUT a row lock (read-committed
 * snapshot). Never take `FOR UPDATE` here: doing so inside the checkpoint gate
 * would create a lock-order cycle with job claiming.
 */
export async function readOperationOwnership(
  client: Pick<PoolClient, "query"> | Pick<Pool, "query">,
  operationId: string,
): Promise<OperationOwnership | undefined> {
  const result = await client.query<{
    id: string;
    trip_id: string;
    status: string;
    fencing_token: string;
  }>(
    `SELECT id, trip_id, status, fencing_token
       FROM odft_app.workflow_operations WHERE id = $1`,
    [operationId],
  );
  const row = result.rows[0];
  return row
    ? { id: row.id, tripId: row.trip_id, status: row.status, fencingToken: row.fencing_token }
    : undefined;
}

/** True when the ownership row still matches the writer's admitted identity. */
export function isFencingCurrent(
  ownership: OperationOwnership | undefined,
  ctx: OperationFencingContext,
): boolean {
  return (
    ownership !== undefined &&
    ownership.id === ctx.operationId &&
    ownership.tripId === ctx.tripId &&
    ownership.status === "running" &&
    ownership.fencingToken === ctx.fencingToken
  );
}

/** Throw {@link StaleFencingError} unless the ownership row is still current. */
export function assertFencingCurrent(
  ownership: OperationOwnership | undefined,
  ctx: OperationFencingContext,
): void {
  if (!isFencingCurrent(ownership, ctx)) {
    throw new StaleFencingError(ctx.operationId);
  }
}

/**
 * Lock the ownership row for the duration of the caller's transaction and throw
 * unless the writer still owns the exact fencing token. `FOR SHARE` also blocks a
 * concurrent token rotation until the transaction commits, so a fenced write
 * cannot interleave with a lease handover.
 */
export async function lockOperationFence(
  client: Pick<PoolClient, "query">,
  ctx: OperationFencingContext,
): Promise<void> {
  const owned = await client.query(
    `SELECT 1 FROM odft_app.workflow_operations
      WHERE id = $1 AND trip_id = $2 AND fencing_token = $3::bigint
      FOR SHARE`,
    [ctx.operationId, ctx.tripId, ctx.fencingToken],
  );
  if (owned.rowCount !== 1) {
    throw new StaleFencingError(ctx.operationId);
  }
}
