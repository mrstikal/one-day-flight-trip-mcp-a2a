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
import { createAccommodationAltAgentApp } from "./app.js";
import { ACCOMMODATION_ALT_AGENT_IDENTITY, loadAccommodationAltAgentConfig } from "./config.js";
import { loadLocalEnv } from "./load-env.js";

/**
 * Phase 10 alternative Accommodation Agent entry point: single-instance service
 * lock, startup reconciliation (AGENT_RESTARTED), then the A2A surface. The
 * database connection is the restricted accommodation role; the task table is
 * the replacement implementation's own.
 */

loadLocalEnv();

const config = loadAccommodationAltAgentConfig();
const serverConfig = parseServerConfig(process.env);
const rankingDeps = await loadDelegatedRankingDeps(config, serverConfig);
const pool = new Pool({ connectionString: config.databaseUrl, max: 6 });
const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
const admission = new DurableMessageAdmission(db, {
  agentIdentity: ACCOMMODATION_ALT_AGENT_IDENTITY,
  taskTable: AGENT_TASK_TABLES.accommodationAlt,
  activeOwner: `pid-${process.pid}`,
});
const telemetry = new ProtocolTelemetryWriter(pool);
const mcp = new McpClient({ config: config.protocol });

const serviceLock = await ServiceInstanceLock.acquire(pool, ACCOMMODATION_ALT_AGENT_IDENTITY).catch(
  (error) => {
    process.stderr.write(
      `accommodation-agent-alt: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  },
);
const reconciled = await admission.reconcileRestartedTasks(serviceLock);

const app = createAccommodationAltAgentApp({
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
    `accommodation-agent-alt ready on http://${config.host}:${config.port} (reconciled: ${reconciled.length})\n`,
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
