import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, parseServerConfig, type ServerConfig } from "@odft/persistence";
import { runWorker } from "./worker.js";
import { createShutdownController } from "./shutdown.js";

/**
 * Dedicated Node.js graph worker entry point (Phase 05).
 *
 * Claims durable operations, drives the graph under a trip lock and lease with
 * a fenced checkpointer, and shuts down gracefully. Exposes no public HTTP API.
 * The process does not write graph state when it is not ready (missing
 * migrations/checkpointer schema or a stale heartbeat).
 */

const GRACE_MS = 30_000;

function loadEnv(): void {
  const rootDir = fileURLToPath(new URL("../../../", import.meta.url));
  const candidates = [
    ".env.local",
    ".env",
    join(rootDir, ".env.local"),
    join(rootDir, ".env"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch {
        // Fall through to the next candidate; config validation reports problems.
      }
    }
  }
}

function log(record: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n");
}

async function main(): Promise<void> {
  loadEnv();

  let config: ServerConfig;
  try {
    config = parseServerConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const shutdown = createShutdownController(GRACE_MS);
  process.on("SIGTERM", () => {
    log({ level: "info", component: "worker", message: "worker stopping", reason: "SIGTERM" });
    shutdown.requestStop("SIGTERM");
  });
  process.on("SIGINT", () => {
    log({ level: "info", component: "worker", message: "worker stopping", reason: "SIGINT" });
    shutdown.requestStop("SIGINT");
  });
  process.on("unhandledRejection", (reason) => {
    log({
      level: "error",
      component: "worker",
      message: "unhandled rejection",
      error: reason instanceof Error ? reason.message : String(reason),
    });
    process.exitCode = 1;
    shutdown.requestStop("unhandledRejection");
  });

  try {
    await runWorker({ server: config, shutdown, logger: log });
  } catch (error) {
    log({
      level: "error",
      component: "worker",
      message: "worker failed",
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
  // The claim loop bounds shutdown by the grace window and aborts in-flight
  // work. Exit explicitly so a connection stuck in a query cannot keep the
  // process alive past the grace period.
  process.exit(process.exitCode ?? 0);
}

await main();
