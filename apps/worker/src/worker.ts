import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  CHECKPOINT_SCHEMA,
  checkReadiness,
  createPool,
  createWorkerIdentity,
  DEFAULT_LEASE_MS,
  parseServerConfig,
  writeWorkerHeartbeat,
  type OperationFencingContext,
  type ServerConfig,
} from "@odft/persistence";
import {
  buildTravelGraph,
  buildTravelStartInput,
  chooseInvocation,
  TRAVEL_GRAPH_DEFINITION,
  TRAVEL_GRAPH_VERSION,
  type CheckpointView,
  type ChooseInvocationOptions,
  type InvocationChoice,
  type InvocationOperation,
} from "@odft/workflow";
import { runClaimLoop } from "./claim.js";
import { createOperationDriver, type WorkerGraph } from "./driver.js";
import { createAiService } from "./ai/service.js";
import { createTravelPortsFactory } from "./travel/ports.js";
import { createShutdownController, type ShutdownController } from "./shutdown.js";

/**
 * Worker entry orchestration (Phase 06).
 *
 * The process drives the production travel graph: route feasibility, flight
 * materialization, schedule validation, the flight/booking decisions, and the
 * demo reservation. It refuses to claim operations until the database,
 * migrations, official checkpointer schema, and a recent heartbeat all pass.
 */

const HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

export interface RunWorkerOptions {
  readonly server: ServerConfig;
  /** Graph factory; defaults to the production travel graph. */
  readonly buildGraph?: (checkpointer: BaseCheckpointSaver) => WorkerGraph;
  /** Invocation ports factory; defaults to the travel ports. */
  readonly portsFactory?: (ctx: OperationFencingContext, signal?: AbortSignal) => unknown;
  /** Invocation selection; defaults to the travel start-input chooser. */
  readonly chooseInvocation?: (
    state: CheckpointView | null,
    operation: InvocationOperation,
    options: ChooseInvocationOptions,
  ) => InvocationChoice;
  readonly workerId?: string;
  readonly leaseMs?: number;
  readonly pollIntervalMs?: number;
  readonly graceMs?: number;
  readonly logger?: (record: Record<string, unknown>) => void;
  /** Externally controlled shutdown (tests). Defaults to a fresh controller. */
  readonly shutdown?: ShutdownController;
  /** Resolve once the worker is ready and claiming (tests). */
  readonly onStarted?: () => void;
}

export async function runWorker(options: RunWorkerOptions): Promise<void> {
  const config = options.server;
  const logger = options.logger ?? (() => {});
  const concurrency = config.workerConcurrency;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const shutdown = options.shutdown ?? createShutdownController(options.graceMs);

  const operationsPool = createPool(config, {
    max: Math.max(2, concurrency + 2),
    applicationName: "odft-worker",
  });
  const guardPool = createPool(config, {
    max: Math.max(1, concurrency + 1),
    applicationName: "odft-worker-checkpoint-guard",
  });
  const saverPool = createPool(config, {
    max: Math.max(1, concurrency + 1),
    applicationName: "odft-worker-checkpointer",
  });
  const lockPool = createPool(config, {
    max: Math.max(1, concurrency + 1),
    applicationName: "odft-worker-trip-lock",
  });

  const identity = createWorkerIdentity();
  const workerId = options.workerId ?? identity.workerId;

  const heartbeat = setInterval(() => {
    void writeWorkerHeartbeat(operationsPool, identity).catch((error: unknown) => {
      logger({
        level: "error",
        component: "worker",
        message: "heartbeat failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  const buildGraph: (checkpointer: BaseCheckpointSaver) => WorkerGraph =
    options.buildGraph ?? ((checkpointer) => buildTravelGraph({ checkpointer }));
  // AI configuration is validated at startup (fixture needs nothing; openrouter
  // requires complete profiles and fails with an actionable, secret-free error).
  const ai = createAiService({ pool: operationsPool, config });
  const portsFactory =
    options.portsFactory ??
    createTravelPortsFactory(operationsPool, ai, {
      wikidataDiscovery: config.wikidataDiscovery,
      onDiscoveryLog: (record) => logger(record as never),
    });
  const selectInvocation =
    options.chooseInvocation ??
    ((state, operation, invocationOptions) =>
      chooseInvocation(state, operation, {
        ...invocationOptions,
        buildStartInput: buildTravelStartInput,
      }));

  try {
    await writeWorkerHeartbeat(operationsPool, identity);
    const readiness = await checkReadiness(operationsPool);
    if (!readiness.ready) {
      const failed = Object.entries(readiness.checks)
        .filter(([, status]) => !status.ok)
        .map(([name, status]) => `${name}: ${status.detail}`)
        .join("; ");
      throw new Error(`worker not ready: ${failed}`);
    }

    logger({
      level: "info",
      component: "worker",
      message: "worker started",
      workerId,
      pid: identity.pid,
      concurrency,
      leaseMs,
      graph: options.buildGraph ? "custom" : "travel",
    });
    options.onStarted?.();

    const driver = createOperationDriver({
      operationsPool,
      guardPool,
      saverPool,
      lockPool,
      workerId,
      leaseMs,
      graphVersion: TRAVEL_GRAPH_VERSION,
      logger,
      buildGraph,
      // Phase 11: the safe definition comes from the same registry the graph was
      // built from (custom graphs provide their own, or none).
      ...(options.buildGraph ? {} : { graphDefinition: TRAVEL_GRAPH_DEFINITION }),
      buildSaver: () =>
        new PostgresSaver(saverPool, undefined, { schema: CHECKPOINT_SCHEMA }),
      portsFactory,
      chooseInvocation: selectInvocation,
      signal: shutdown.signal,
    });

    await runClaimLoop({
      operationsPool,
      driver,
      shutdown,
      workerId,
      leaseMs,
      concurrency,
      pollIntervalMs,
      graceMs: options.graceMs ?? 30_000,
      logger,
    });
  } finally {
    clearInterval(heartbeat);
    await Promise.allSettled([
      operationsPool.end(),
      guardPool.end(),
      saverPool.end(),
      lockPool.end(),
    ]);
  }
}

/** Parse and run from the environment (used by the executable entry point). */
export async function runWorkerFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await runWorker({ server: parseServerConfig(env) });
}
