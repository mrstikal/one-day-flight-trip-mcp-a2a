import { Pool } from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { parseServerConfig } from "@odft/persistence";
import {
  AGENT_TASK_TABLES,
  DurableMessageAdmission,
  McpClient,
  ProtocolTelemetryWriter,
  ServiceInstanceLock,
} from "@odft/protocols";
import { loadDelegatedRankingDeps } from "./ai.js";
import { createFlightAgentApp } from "./app.js";
import { FLIGHT_AGENT_IDENTITY, loadFlightAgentConfig } from "./config.js";
import { loadLocalEnv } from "./load-env.js";

/**
 * Phase 05 Flight Agent entry point: single-instance service lock, startup
 * reconciliation of interrupted tasks (AGENT_RESTARTED), then the A2A surface.
 * `DATABASE_URL` must be the restricted `odft_flight_agent` role connection.
 */

loadLocalEnv();

const config = loadFlightAgentConfig();
const serverConfig = parseServerConfig(process.env);
// Fail fast when AI_MODE=openrouter is misconfigured (profile/manifest).
const rankingDeps = await loadDelegatedRankingDeps(config, serverConfig);
const pool = new Pool({ connectionString: config.databaseUrl, max: 6 });
const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
const admission = new DurableMessageAdmission(db, {
  agentIdentity: FLIGHT_AGENT_IDENTITY,
  taskTable: AGENT_TASK_TABLES.flight,
  activeOwner: `pid-${process.pid}`,
});
const telemetry = new ProtocolTelemetryWriter(pool);
const mcp = new McpClient({ config: config.protocol });

const serviceLock = await ServiceInstanceLock.acquire(pool, FLIGHT_AGENT_IDENTITY).catch(
  (error) => {
    process.stderr.write(
      `flight-agent: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  },
);
const reconciled = await admission.reconcileRestartedTasks(serviceLock);

const app = createFlightAgentApp({
  config,
  serverConfig,
  pool,
  db,
  admission,
  telemetry,
  mcp,
  rankingDeps,
});
const server = app.listen(config.port, config.host, () => {
  process.stdout.write(
    `flight-agent ready on http://${config.host}:${config.port} (reconciled: ${reconciled.length})\n`,
  );
});

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mcp.close();
  await serviceLock.release();
  await db.destroy();
  await pool.end();
}

process.on("SIGINT", () => void shutdown().then(() => process.exit(130)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(143)));
