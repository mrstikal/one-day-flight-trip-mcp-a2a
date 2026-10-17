import type { Pool, PoolClient } from "pg";

/**
 * Phase 03 single-instance service lock (plan §3.7).
 *
 * Every protocol service holds a PostgreSQL session advisory lock on its agent
 * identity for its whole lifetime. A second live process (rolling restart,
 * accidental duplicate) fails fast instead of racing the running one, and only
 * the lock holder may reconcile tasks a stopped process left active — a second
 * process can never fail the tasks of a live one.
 */

export class ServiceLockError extends Error {
  readonly code = "CONFLICT" as const;
  constructor(agentIdentity: string) {
    super(
      `another service process already holds the ${agentIdentity} lock; refusing to start a second instance`,
    );
    this.name = "ServiceLockError";
  }
}

const LOCK_KEY_PREFIX = "odft_protocol_service";

export class ServiceInstanceLock {
  private released = false;

  private constructor(
    private readonly client: PoolClient,
    readonly agentIdentity: string,
  ) {}

  static async acquire(pool: Pool, agentIdentity: string): Promise<ServiceInstanceLock> {
    const client = await pool.connect();
    try {
      const result = await client.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
        [`${LOCK_KEY_PREFIX}:${agentIdentity}`],
      );
      if (result.rows[0]?.locked !== true) {
        throw new ServiceLockError(agentIdentity);
      }
      return new ServiceInstanceLock(client, agentIdentity);
    } catch (error) {
      client.release();
      throw error;
    }
  }

  /** Release the advisory lock and return the connection to the pool. */
  async release(): Promise<void> {
    if (this.released) {
      return;
    }
    this.released = true;
    try {
      await this.client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [
        `${LOCK_KEY_PREFIX}:${this.agentIdentity}`,
      ]);
    } finally {
      this.client.release();
    }
  }
}
