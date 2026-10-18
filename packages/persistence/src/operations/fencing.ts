import type { Pool, PoolClient } from "pg";

/**
 * Fencing primitives shared by the coordinator worker and its fenced writes
 * (02-architecture.md section 6). A single-writer rule guards domain writes: a
 * write is accepted only while the operation is `running` under the exact
 * fencing token the writer was admitted with. Phase 11 removed the legacy
 * checkpoint gate because no checkpoint writer exists anymore.
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

/**
 * Read the current operation ownership WITHOUT a row lock (read-committed
 * snapshot). Never take `FOR UPDATE` here: doing so would create a lock-order
 * cycle with job claiming.
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

/**
 * Advisory gate shared by the fenced effect runner and cancellation.
 *
 * The effect runner holds it across the whole effect (including its callback,
 * which may take the trip row lock), while cancellation takes it BEFORE the
 * trip lock. This serializes an in-flight effect with a cancellation without
 * holding the operation row lock across the callback, and without the ABBA
 * cycle trip→operation / operation→trip.
 */
export function operationEffectLockKey(operationId: string): string {
  return `odft-effect-operation:${operationId}`;
}

export async function lockOperationEffectGate(
  client: Pick<PoolClient, "query">,
  operationId: string,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    operationEffectLockKey(operationId),
  ]);
}
