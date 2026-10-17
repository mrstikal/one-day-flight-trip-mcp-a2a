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
import { createCityGuideAgentApp } from "./app.js";
import { CITY_GUIDE_AGENT_IDENTITY, loadCityGuideAgentConfig } from "./config.js";
import { loadLocalEnv } from "./load-env.js";

/**
 * Phase 06 City Guide Agent entry point: single-instance service lock, startup
 * reconciliation of interrupted tasks (AGENT_RESTARTED), then the A2A surface.
 * `DATABASE_URL` must be the restricted `odft_city_guide_agent` role connection; a task
 * awaiting input survives a restart (`input_required` is a resting state).
 */

loadLocalEnv();

const config = loadCityGuideAgentConfig();
const serverConfig = parseServerConfig(process.env);
const pool = new Pool({ connectionString: config.databaseUrl, max: 6 });
const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
const admission = new DurableMessageAdmission(db, {
  agentIdentity: CITY_GUIDE_AGENT_IDENTITY,
  taskTable: AGENT_TASK_TABLES.cityGuide,
  activeOwner: `pid-${process.pid}`,
});
const telemetry = new ProtocolTelemetryWriter(pool);
const mcp = new McpClient({ config: config.protocol });

const serviceLock = await ServiceInstanceLock.acquire(pool, CITY_GUIDE_AGENT_IDENTITY).catch((error) => {
  process.stderr.write(`city-guide-agent: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
const reconciled = await admission.reconcileRestartedTasks(serviceLock);

const app = createCityGuideAgentApp({
  config,
  serverConfig,
  pool,
  db,
  admission,
  telemetry,
  mcp,
});
const server = app.listen(config.port, config.host, () => {
  process.stdout.write(
    `city-guide-agent ready on http://${config.host}:${config.port} (reconciled: ${reconciled.length})\n`,
  );
});

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await serviceLock.release();
  await db.destroy();
  await pool.end();
}

process.on("SIGINT", () => void shutdown().then(() => process.exit(130)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(143)));
