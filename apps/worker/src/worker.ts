import {
  checkReadiness,
  createPool,
  createWorkerIdentity,
  DEFAULT_LEASE_MS,
  parseServerConfig,
  writeWorkerHeartbeat,
  type ServerConfig,
} from "@odft/persistence";
import { runClaimLoop } from "./claim.js";
import {
  createA2ADelegationTransport,
  loadCoordinatorTransportConfig,
} from "./coordinator-transport.js";
import { runReconcileLoop } from "./reconcile-loop.js";
import { createOperationDriver } from "./driver.js";
import { createAiService } from "./ai/service.js";
import { createTravelPortsFactory } from "./travel/ports.js";
import { createShutdownController, type ShutdownController } from "./shutdown.js";

/**
 * Coordinator worker entry orchestration (Phase 11).
 *
 * The process is the only executor of admitted operations: it drives the
 * coordinator dispatcher, delegates to the A2A specialists over the trusted
 * registry, and runs the durable observation/cancel reconciler. It refuses to
 * claim operations until the database, migrations, and a recent heartbeat all
 * pass. There is no LangGraph graph and no checkpointer schema to initialize.
 */

const HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

export interface RunWorkerOptions {
  readonly server: ServerConfig;
  /** Environment used for the trusted agent registry (defaults to process.env). */
  readonly env?: NodeJS.ProcessEnv;
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
  const env = options.env ?? process.env;
  const logger = options.logger ?? (() => {});
  const concurrency = config.workerConcurrency;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const shutdown = options.shutdown ?? createShutdownController(options.graceMs);

  const operationsPool = createPool(config, {
    max: Math.max(2, concurrency + 2),
    applicationName: "odft-worker",
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

  // AI configuration is validated at startup (fixture needs nothing; openrouter
  // requires complete profiles and fails with an actionable, secret-free error).
  const ai = createAiService({ pool: operationsPool, config });
  const portsFactory = createTravelPortsFactory(operationsPool, ai, {
    wikidataDiscovery: config.wikidataDiscovery,
    onDiscoveryLog: (record) => logger(record as never),
    aiMode: config.aiMode,
  });

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

    // Phase 11: the coordinator always requires the trusted A2A registry. Fail
    // closed at startup instead of leaving admitted operations unclaimed.
    const transportConfig = loadCoordinatorTransportConfig(env);
    const transport = createA2ADelegationTransport(transportConfig.config);
    const driver = createOperationDriver({
      pool: operationsPool,
      lockPool,
      transport,
      agents: {
        flight: transportConfig.flight,
        accommodation: transportConfig.accommodation,
        cityGuide: transportConfig.cityGuide,
        itinerary: transportConfig.itinerary,
      },
      portsFactory: (ctx, signal) => portsFactory(ctx, signal),
      logger,
      signal: shutdown.signal,
    });

    logger({
      level: "info",
      component: "worker",
      message: "worker started",
      workerId,
      pid: identity.pid,
      concurrency,
      leaseMs,
      engine: "coordinator-v1",
    });
    options.onStarted?.();

    await Promise.all([
      runClaimLoop({
        operationsPool,
        driver,
        shutdown,
        workerId,
        leaseMs,
        concurrency,
        pollIntervalMs,
        graceMs: options.graceMs ?? 30_000,
        logger,
        supportedEngines: ["coordinator-v1"],
      }),
      // Durable outboxes: the observation bridge and the cancel reconciler run
      // on their own interval, independently of any claim.
      runReconcileLoop({
        operationsPool,
        shutdown,
        transport,
        logger,
      }),
    ]);
  } finally {
    clearInterval(heartbeat);
    await Promise.allSettled([operationsPool.end(), lockPool.end()]);
  }
}

/** Parse and run from the environment (used by the executable entry point). */
export async function runWorkerFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await runWorker({ server: parseServerConfig(env), env });
}
