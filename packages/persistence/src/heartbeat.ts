import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

/**
 * A worker process identity. The `workerId` includes a random component so a
 * restart produces a new identity, which readiness can distinguish from a stale
 * heartbeat. Contains no secrets.
 */
export interface WorkerIdentity {
  readonly workerId: string;
  readonly host: string;
  readonly pid: number;
}

export function createWorkerIdentity(): WorkerIdentity {
  const host = hostname();
  const pid = process.pid;
  return { workerId: `${host}:${pid}:${randomUUID()}`, host, pid };
}

/**
 * Upsert a real heartbeat for this worker process. Readiness must never report a
 * worker as alive when no recent heartbeat exists.
 */
export async function writeWorkerHeartbeat(pool: Pool, identity: WorkerIdentity): Promise<void> {
  await pool.query(
    `INSERT INTO odft_app.worker_heartbeat (worker_id, started_at, last_heartbeat_at, host, pid)
     VALUES ($1, now(), now(), $2, $3)
     ON CONFLICT (worker_id) DO UPDATE
       SET last_heartbeat_at = now(),
           host = EXCLUDED.host,
           pid = EXCLUDED.pid`,
    [identity.workerId, identity.host, identity.pid],
  );
  // Bound table growth from restarts: drop stale rows from long-dead workers.
  await pool.query(
    `DELETE FROM odft_app.worker_heartbeat
      WHERE last_heartbeat_at < now() - interval '1 day' AND worker_id <> $1`,
    [identity.workerId],
  );
}
