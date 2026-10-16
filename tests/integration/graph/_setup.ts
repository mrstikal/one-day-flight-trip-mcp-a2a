import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  CHECKPOINT_SCHEMA,
  admitResume,
  claimNextOperation,
  createPool,
  createTrip,
  getPendingDecisionForTrip,
  loadReferenceData,
  parseServerConfig,
  retryOperation,
  runMigrations,
  setupCheckpointer,
  type ClaimedOperation,
  type ServerConfig,
} from "@odft/persistence";
import {
  buildHarnessGraph,
  buildTravelGraph,
  buildTravelStartInput,
  chooseInvocation,
  TRAVEL_GRAPH_VERSION,
} from "@odft/workflow";
import type { OperationDriver } from "../../../apps/worker/src/driver.js";
import { createOperationDriver } from "../../../apps/worker/src/driver.js";
import { FencedSaver } from "../../../apps/worker/src/checkpointer/fenced-saver.js";
import { createAiService, type AiService } from "../../../apps/worker/src/ai/service.js";
import { createTravelPortsFactory } from "../../../apps/worker/src/travel/ports.js";
import { createFixtureSession } from "../../fixtures/session.js";
import { fixtureCreationInput } from "../../fixtures/trip.js";
import { requireTestDatabaseUrl } from "../booking/_setup.js";

/** Shared real-PostgreSQL setup for Phase 05 graph/worker integration tests. */

export { requireTestDatabaseUrl };

export function createGraphTestPool(max = 8): Pool {
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
  readonly guard: Pool;
  readonly saver: Pool;
  readonly lock: Pool;
}

export function createWorkerPools(max = 4): WorkerPools {
  const config = testServerConfig();
  return {
    operations: createPool(config, { max, applicationName: "odft-test-ops" }),
    guard: createPool(config, { max, applicationName: "odft-test-guard" }),
    saver: createPool(config, { max, applicationName: "odft-test-saver" }),
    lock: createPool(config, { max, applicationName: "odft-test-lock" }),
  };
}

export async function endWorkerPools(pools: WorkerPools): Promise<void> {
  await Promise.allSettled([
    pools.operations.end(),
    pools.guard.end(),
    pools.saver.end(),
    pools.lock.end(),
  ]);
}

export async function resetGraphDatabase(pool: Pool): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS odft_app CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS odft_checkpoint CASCADE");
  await runMigrations(pool);
  await setupCheckpointer(pool);
  await loadReferenceData(pool);
}

export function createHarnessDriver(pools: WorkerPools): OperationDriver {
  return createOperationDriver({
    operationsPool: pools.operations,
    guardPool: pools.guard,
    saverPool: pools.saver,
    lockPool: pools.lock,
    workerId: "test-worker",
    leaseMs: 30_000,
    graphVersion: "harness-graph-v0",
    logger: (record) => {
      if (record.level === "warn" || record.level === "error") {
        process.stderr.write(`[driver] ${JSON.stringify(record)}\n`);
      }
    },
    buildGraph: (checkpointer) => buildHarnessGraph({ checkpointer }) as never,
    buildSaver: () => new PostgresSaver(pools.saver, undefined, { schema: CHECKPOINT_SCHEMA }),
  });
}

/** Fixture-mode AI runtime for the travel graph (no credentials, no network). */
export function createTestAiService(pools: WorkerPools): AiService {
  return createAiService({ pool: pools.operations, config: testServerConfig() });
}

/** Production travel-graph driver over the given worker pools (Phase 06). */
export function createTravelDriver(
  pools: WorkerPools,
  ai: AiService = createTestAiService(pools),
): OperationDriver {
  return createOperationDriver({
    operationsPool: pools.operations,
    guardPool: pools.guard,
    saverPool: pools.saver,
    lockPool: pools.lock,
    workerId: "test-worker",
    leaseMs: 30_000,
    graphVersion: TRAVEL_GRAPH_VERSION,
    logger: (record) => {
      if (record.level === "warn" || record.level === "error") {
        process.stderr.write(`[driver] ${JSON.stringify(record)}\n`);
      }
    },
    buildGraph: (checkpointer) => buildTravelGraph({ checkpointer }) as never,
    portsFactory: (ctx) => createTravelPortsFactory(pools.operations, ai)(ctx),
    chooseInvocation: (state, operation, options) =>
      chooseInvocation(state, operation, { ...options, buildStartInput: buildTravelStartInput }),
    buildSaver: () => new PostgresSaver(pools.saver, undefined, { schema: CHECKPOINT_SCHEMA }),
  });
}

/**
 * Read-only checkpoint head resolver for tests, mirroring the production read
 * path: `FencedSaver` resolves the thread's causal leaf (the newest checkpoint
 * that no other checkpoint names as its parent) instead of the saver's
 * `ORDER BY checkpoint_id DESC`, which can return a MID-RUN checkpoint when the
 * upstream id clock is not monotonic across module instances. Reads never
 * acquire the guard gate, so the real guard pool is passed only for shape
 * compatibility with production construction.
 */
function readOnlySaver(pools: WorkerPools, tripId: string): FencedSaver {
  const delegate = new PostgresSaver(pools.saver, undefined, { schema: CHECKPOINT_SCHEMA });
  return new FencedSaver(delegate, pools.guard, {
    tripId,
    operationId: "read-only",
    fencingToken: "0",
  });
}

/** Read the persisted travel-graph checkpoint state for a trip (no writes). */
export async function readTravelState(pools: WorkerPools, tripId: string) {
  const graph = buildTravelGraph({ checkpointer: readOnlySaver(pools, tripId) });
  return graph.getState({ configurable: { thread_id: tripId } });
}

/** Approve the pending itinerary draft when one is waiting (Phase 10). */
export async function approvePendingItineraryIfAny(
  pool: Pool,
  pools: WorkerPools,
  tripId: string,
  sessionId: string,
): Promise<boolean> {
  const decision = await getPendingDecisionForTrip(pools.operations, tripId);
  if (decision?.kind !== "itinerary_approval") {
    return false;
  }
  await approvePendingItinerary(pool, pools, tripId, sessionId);
  return true;
}

/**
 * Approve the pending `itinerary_approval` decision (Phase 10) and run the
 * resume operation to a decision-free ready state.
 */
export async function approvePendingItinerary(
  pool: Pool,
  pools: WorkerPools,
  tripId: string,
  sessionId: string,
): Promise<void> {
  const decision = await getPendingDecisionForTrip(pools.operations, tripId);
  if (decision?.kind !== "itinerary_approval") {
    throw new Error(`expected itinerary_approval, got ${String(decision?.kind)}`);
  }
  const state = await readTravelState(pools, tripId);
  const itineraryId = state.values.itineraryId as string | null;
  if (!itineraryId) {
    throw new Error("no itinerary draft is active for approval");
  }
  const revision = await pool.query<{ revision: number }>(
    `SELECT revision FROM odft_app.trips WHERE id = $1`,
    [tripId],
  );
  const admitted = await admitResume(pool, {
    tripId,
    sessionId,
    request: {
      requestId: randomUUID(),
      expectedRevision: revision.rows[0]?.revision ?? 0,
      decisionId: decision.id,
      response: { action: "approve_itinerary", itineraryId } as never,
    },
  });
  if (!("operationId" in admitted)) {
    throw new Error(`itinerary approval refused: ${JSON.stringify(admitted)}`);
  }
  await createTravelDriver(pools).runOperation(await claimNextOrFail(pools));
}

/** Claim the next ready operation, failing the test if none is available. */
export async function claimNextOrFail(pools: WorkerPools): Promise<ClaimedOperation> {
  const claim = await claimNextOperation(pools.operations, {
    workerId: "test-worker",
    leaseMs: 30_000,
  });
  if (!claim) {
    throw new Error("expected a claimable operation but none was ready");
  }
  return claim;
}

export interface HarnessTripFixture {
  readonly sessionId: string;
  readonly tripId: string;
  readonly creationOperationId: string;
}

/** Create a session plus a real trip whose queued creation operation is ready. */
export async function createHarnessTrip(pool: Pool): Promise<HarnessTripFixture> {
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

/** Read the persisted harness checkpoint state for a trip (no writes). */
export async function readHarnessState(pools: WorkerPools, tripId: string) {
  const graph = buildHarnessGraph({ checkpointer: readOnlySaver(pools, tripId) });
  return graph.getState({ configurable: { thread_id: tripId } });
}

/** Build a driver whose graph always throws on `stream` (auto-claim exhaustion tests). */
export function createAlwaysFailingDriver(pools: WorkerPools): OperationDriver {
  return createOperationDriver({
    operationsPool: pools.operations,
    guardPool: pools.guard,
    saverPool: pools.saver,
    lockPool: pools.lock,
    workerId: "test-worker",
    leaseMs: 30_000,
    graphVersion: "harness-graph-v0",
    buildGraph: (checkpointer) => {
      const real = buildHarnessGraph({ checkpointer });
      return {
        getState: (config) => real.getState(config),
        stream: async () => {
          throw new Error("simulated graph failure");
        },
      };
    },
    buildSaver: () => new PostgresSaver(pools.saver, undefined, { schema: CHECKPOINT_SCHEMA }),
  });
}
