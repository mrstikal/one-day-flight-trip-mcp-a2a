import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

/** Shared helper to run the real worker process in end-to-end tests. */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSX = `${REPO_ROOT}/node_modules/.bin/tsx`;

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
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required to reset rate limits: run the suite with the " +
        "explicitly selected (isolated) database so the worker and the web server share it.",
    );
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await pool.query("TRUNCATE odft_app.rate_limit_buckets");
  } finally {
    await pool.end();
  }
}

/**
 * Spawn the production worker in deterministic fixture mode against the
 * explicitly selected database. The worker must share the web server's
 * database: `DATABASE_URL` is inherited from the Playwright process (an
 * isolated `*_test` database for controlled runs) and is never guessed here.
 * Refusing a missing value is deliberate — silently falling back would let the
 * spec stack split across databases or attach to a live application worker's
 * operation queue.
 */
export function startWorker(): ChildProcess {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required to start the E2E worker: run the suite with the " +
        "explicitly selected (isolated) database so the worker and the web server share it.",
    );
  }
  process.stdout.write(
    `[e2e] starting fixture worker against database "${databaseNameOf(databaseUrl)}"\n`,
  );
  return spawn(TSX, ["--tsconfig", "tsconfig.json", "apps/worker/src/main.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      AI_MODE: "fixture",
      WORKER_CONCURRENCY: "1",
      // Landmark curation over the network must never run in tests: the
      // specs must be deterministic and offline, and a slow/failing Wikidata
      // call otherwise stalls the operation that the spec is waiting for.
      WIKIDATA_DISCOVERY: "false",
    },
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
}

export async function stopWorker(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    if (child.pid) {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    child.kill("SIGKILL");
  }
}
