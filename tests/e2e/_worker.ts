import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

/** Shared helper to run the real worker process in end-to-end tests. */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSX = `${REPO_ROOT}/node_modules/.bin/tsx`;

/**
 * Clear per-IP rate-limit buckets before a spec. All local requests share the
 * implicit `direct` IP scope, so accumulated runs would otherwise trip the
 * session/trip creation limits. Test-only; never used by the application.
 */
export async function resetRateLimits(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return;
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await pool.query("TRUNCATE odft_app.rate_limit_buckets");
  } finally {
    await pool.end();
  }
}

export function startWorker(): ChildProcess {
  return spawn(TSX, ["--tsconfig", "tsconfig.json", "apps/worker/src/main.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, AI_MODE: "fixture", WORKER_CONCURRENCY: "1" },
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
