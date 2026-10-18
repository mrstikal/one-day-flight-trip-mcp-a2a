import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  claimNextOperation,
  createPool,
  createTrip,
  loadReferenceData,
  parseServerConfig,
  retryOperation,
  runMigrations,
  type ClaimedOperation,
  type ServerConfig,
} from "@odft/persistence";
import { createAiService, type AiService } from "../../apps/worker/src/ai/service.js";
import { createFixtureSession } from "../fixtures/session.js";
import { fixtureCreationInput } from "../fixtures/trip.js";

/**
 * Shared real-PostgreSQL setup for integration tests (Phase 11).
 *
 * The legacy graph and its checkpointer are gone; this module only provides the
 * coordinator-era database reset, pools, fixture trip and AI runtime.
 */

export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL is required for integration tests");
  }
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to run against non-test database "${name}"`);
  }
  return url;
}

export function createTestPool(max = 8): Pool {
  return new Pool({ connectionString: requireTestDatabaseUrl(), max });
}

export function testServerConfig(): ServerConfig {
  const databaseUrl = requireTestDatabaseUrl();
  const env = {
    DATABASE_URL: databaseUrl,
    PUBLIC_BASE_URL: "http://localhost:3000",
    SESSION_HMAC_KEY: "integration-test-session-hmac-key-0123456789",
    AI_MODE: "fixture",
    WORKER_CONCURRENCY: "2",
  };
  return parseServerConfig(env);
}

export interface WorkerPools {
  readonly operations: Pool;
  readonly lock: Pool;
}

export function createWorkerPools(max = 4): WorkerPools {
  const config = testServerConfig();
  return {
    operations: createPool(config, { max, applicationName: "odft-test-ops" }),
    lock: createPool(config, { max, applicationName: "odft-test-lock" }),
  };
}

export async function endWorkerPools(pools: WorkerPools): Promise<void> {
  await Promise.allSettled([pools.operations.end(), pools.lock.end()]);
}

export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS odft_app CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS odft_protocol CASCADE");
  await runMigrations(pool);
  await loadReferenceData(pool);
}

/** Fixture-mode AI runtime (no credentials, no network). */
export function createTestAiService(pools: WorkerPools): AiService {
  return createAiService({ pool: pools.operations, config: testServerConfig() });
}

export interface FixtureTrip {
  readonly sessionId: string;
  readonly tripId: string;
  readonly creationOperationId: string;
}

/** Create a session plus a real coordinator trip whose creation operation is ready. */
export async function createFixtureTrip(pool: Pool): Promise<FixtureTrip> {
  const sessionClient = await pool.connect();
  let sessionId: string;
  try {
    sessionId = await createFixtureSession(sessionClient);
  } finally {
    sessionClient.release();
  }
  const created = await createTrip(pool, { sessionId, input: fixtureCreationInput() });
  if (!("tripId" in created)) {
    throw new Error(`fixture createTrip failed: ${created.code}`);
  }
  return { sessionId, tripId: created.tripId, creationOperationId: created.operationId };
}

/** Claim the next ready operation, failing the test if none is available. */
export async function claimNextOrFail(pools: WorkerPools): Promise<ClaimedOperation> {
  const claim = await claimNextOperation(pools.operations, {
    workerId: "test-worker",
    leaseMs: 30_000,
    engines: ["coordinator-v1"],
  });
  if (!claim) {
    throw new Error("expected a claimable operation but none was ready");
  }
  return claim;
}

/** Explicit owner technical retry for a failed operation (tests). */
export async function retryFailedOperation(
  pool: Pool,
  input: { tripId: string; sessionId: string; operationId: string; expectedRevision: number },
) {
  return retryOperation(pool, {
    ...input,
    controlRequestId: randomUUID(),
  });
}
