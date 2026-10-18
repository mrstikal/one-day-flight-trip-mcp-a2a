import { Pool } from "pg";
import { databaseUrlOrThrow, startE2eServices, type E2eServices } from "./_services.js";

/**
 * Shared helper to run the real coordinator stack in end-to-end tests.
 *
 * Phase 11: a spec that used to spawn only the LangGraph worker now starts the
 * complete runtime it actually needs — MCP host, the three primary A2A agents,
 * the replacement Accommodation agent and the coordinator worker — against the
 * explicitly selected isolated database.
 */

export type { E2eServices };

/** Database name of a connection URL without exposing its credentials. */
export function databaseNameOf(databaseUrl: string): string {
  return new URL(databaseUrl).pathname.replace(/^\//, "");
}

/**
 * Clear per-IP rate-limit buckets before a spec. All local requests share the
 * implicit `direct` IP scope, so accumulated runs would otherwise trip the
 * session/trip creation limits. Test-only; never used by the application.
 */
export async function resetRateLimits(): Promise<void> {
  // Route through the same guard as the stack: this TRUNCATE must never touch a
  // non-disposable database, even when a spec calls it before startWorker().
  const databaseUrl = databaseUrlOrThrow();
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await pool.query("TRUNCATE odft_app.rate_limit_buckets");
  } finally {
    await pool.end();
  }
}

/**
 * Start the full fixture stack. The worker must share the web server's
 * database: `DATABASE_URL` is inherited from the Playwright process (an
 * isolated `*_test` database for controlled runs) and is never guessed here.
 */
export async function startWorker(): Promise<E2eServices> {
  const databaseUrl = databaseUrlOrThrow();
  process.stdout.write(
    `[e2e] starting fixture coordinator stack against database "${databaseNameOf(databaseUrl)}"\n`,
  );
  return startE2eServices();
}

export async function stopWorker(stack: E2eServices | undefined): Promise<void> {
  await stack?.stop();
}
