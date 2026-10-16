import type { Pool } from "pg";
import { CHECKPOINT_SCHEMA } from "./checkpointer-setup.js";
import { MIGRATION_VERSIONS } from "./migrate.js";

/**
 * Readiness checks database connectivity, applied migrations, the official
 * checkpointer schema, and a recent worker heartbeat. Liveness is local and
 * never calls OpenRouter or map tiles. Failing checks never throw; they are
 * reported as a structured, sanitized result.
 */

export interface CheckStatus {
  readonly ok: boolean;
  readonly detail: string;
}

export interface ReadinessReport {
  readonly ready: boolean;
  readonly checks: {
    readonly database: CheckStatus;
    readonly migrations: CheckStatus;
    readonly checkpointer: CheckStatus;
    readonly workerHeartbeat: CheckStatus;
  };
}

export interface ReadinessOptions {
  /** Maximum acceptable heartbeat age. Defaults to 30 seconds. */
  readonly heartbeatMaxAgeMs?: number;
  /** Required migration versions. Defaults to the committed migration files. */
  readonly requiredMigrations?: readonly string[];
}

export async function checkReadiness(
  pool: Pool,
  options: ReadinessOptions = {},
): Promise<ReadinessReport> {
  const heartbeatMaxAgeMs = options.heartbeatMaxAgeMs ?? 30_000;
  const requiredMigrations = options.requiredMigrations ?? MIGRATION_VERSIONS;

  // Run the checks concurrently so a single unavailable dependency cannot make
  // the probe wait for every check's connection timeout in sequence.
  const [database, migrations, checkpointer, workerHeartbeat] = await Promise.all([
    runCheck(async () => {
      await pool.query("SELECT 1");
      return "database reachable";
    }),

    runCheck(async () => {
      const result = await pool.query<{ version: string }>(
        `SELECT version FROM odft_app.schema_migrations`,
      );
      const applied = new Set(result.rows.map((row) => row.version));
      const missing = requiredMigrations.filter((version) => !applied.has(version));
      if (missing.length > 0) {
        throw new Error(`missing migrations: ${missing.join(", ")}`);
      }
      return `${applied.size} migration(s) applied`;
    }),

    runCheck(async () => {
      const result = await pool.query<{ present: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS present`,
        [`${CHECKPOINT_SCHEMA}.checkpoints`],
      );
      if (!result.rows[0]?.present) {
        throw new Error(`checkpointer schema ${CHECKPOINT_SCHEMA} is not initialized`);
      }
      return `checkpointer schema ${CHECKPOINT_SCHEMA} ready`;
    }),

    runCheck(async () => {
      const result = await pool.query<{ age_ms: string | null }>(
        `SELECT (extract(epoch FROM (now() - max(last_heartbeat_at))) * 1000)::bigint::text AS age_ms
           FROM odft_app.worker_heartbeat`,
      );
      const raw = result.rows[0]?.age_ms;
      if (raw === null || raw === undefined) {
        throw new Error("no worker heartbeat recorded");
      }
      const ageMs = Number(raw);
      if (!Number.isFinite(ageMs) || ageMs > heartbeatMaxAgeMs) {
        throw new Error(`worker heartbeat is stale (${raw} ms old)`);
      }
      return `worker heartbeat ${raw} ms old`;
    }),
  ]);

  const ready = database.ok && migrations.ok && checkpointer.ok && workerHeartbeat.ok;

  return { ready, checks: { database, migrations, checkpointer, workerHeartbeat } };
}

async function runCheck(probe: () => Promise<string>): Promise<CheckStatus> {
  try {
    return { ok: true, detail: await probe() };
  } catch (error) {
    return {
      ok: false,
      detail: sanitizeDetail(error instanceof Error ? error.message : "unknown error"),
    };
  }
}

/**
 * Readiness detail must never leak connection strings, hosts, or credentials
 * through a raw database error.
 */
function sanitizeDetail(message: string): string {
  if (
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|getaddrinfo|password|authentication|SASL|host|port|connect/i.test(
      message,
    )
  ) {
    return "dependency unavailable";
  }
  return message;
}
