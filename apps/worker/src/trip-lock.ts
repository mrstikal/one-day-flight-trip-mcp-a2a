import type { Pool, PoolClient } from "pg";

/**
 * Session-level PostgreSQL advisory lock for exclusive per-trip execution
 * (02-architecture.md section 6). The lock is held on a dedicated connection for
 * the whole graph invocation and released on completion or shutdown.
 *
 * A borrowed `PoolClient` does not inherit the pool's `error` listener, so a
 * terminated lock connection would otherwise raise an unhandled `error` event
 * and kill the whole worker process. We attach a listener that marks the lock
 * lost and notifies the caller (which aborts only the affected operation).
 */

export interface TripLock {
  readonly tripId: string;
  readonly client: PoolClient;
  lost: boolean;
}

export interface TripLockOptions {
  readonly onLost?: (error: unknown) => void;
}

function lockKey(tripId: string): string {
  return `trip-execution:${tripId}`;
}

/** Try to acquire the trip advisory lock; returns undefined when another worker holds it. */
export async function acquireTripLock(
  pool: Pool,
  tripId: string,
  options: TripLockOptions = {},
): Promise<TripLock | undefined> {
  const client = await pool.connect();
  const lock: TripLock = { tripId, client, lost: false };
  const onError = (error: unknown): void => {
    lock.lost = true;
    options.onLost?.(error);
  };
  client.on("error", onError);
  try {
    const result = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`,
      [lockKey(tripId)],
    );
    if (result.rows[0]?.locked !== true) {
      client.removeListener("error", onError);
      client.release();
      return undefined;
    }
    (lock as { releaseListener?: () => void }).releaseListener = () => client.removeListener("error", onError);
    return lock;
  } catch (error) {
    client.removeListener("error", onError);
    client.release();
    throw error;
  }
}

/** Release the trip advisory lock and return the connection to the pool. */
export async function releaseTripLock(lock: TripLock): Promise<void> {
  const detach = (lock as { releaseListener?: () => void }).releaseListener;
  if (lock.lost) {
    detach?.();
    lock.client.release(true);
    return;
  }
  try {
    await lock.client.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [
      lockKey(lock.tripId),
    ]);
    lock.client.release();
  } catch {
    lock.client.release(true);
  } finally {
    detach?.();
  }
}
