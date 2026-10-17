import express from "express";
import type { Pool } from "pg";
import type { Kysely } from "kysely";
import {
  AGENT_TASK_TABLES,
  DurableMessageAdmission,
  ProtocolTelemetryWriter,
  createAdmissionMiddleware,
  createTaskStore,
  mountA2AServer,
} from "@odft/protocols";
import type { DelegatedFlightRankingDeps } from "@odft/services";
import { buildFlightAgentCard } from "./card.js";
import { createFlightExecutor } from "./executor.js";
import { FLIGHT_AGENT_IDENTITY, type FlightAgentConfig } from "./config.js";
import type { ServerConfig } from "@odft/persistence";

/**
 * Phase 05 Flight Agent HTTP surface: durable admission middleware, official
 * card/JSON-RPC mount, and a health route that performs no external request.
 */
export function createFlightAgentApp(input: {
  config: FlightAgentConfig;
  serverConfig: ServerConfig;
  pool: Pool;
  db: Kysely<unknown>;
  admission: DurableMessageAdmission;
  telemetry: ProtocolTelemetryWriter;
  mcp: Parameters<typeof createFlightExecutor>[0]["mcp"];
  rankingDeps?: DelegatedFlightRankingDeps;
}): express.Express {
  const app = express();
  app.get("/health", (_request, response) => {
    response.json({ status: "ok", endpoint: FLIGHT_AGENT_IDENTITY, version: "1.0.0" });
  });
  app.use(express.json({ limit: "1mb" }));
  app.use(
    createAdmissionMiddleware({
      config: input.config.protocol,
      admission: input.admission,
      telemetry: input.telemetry,
    }),
  );
  mountA2AServer(app, {
    config: input.config.protocol,
    agentCard: buildFlightAgentCard(input.config),
    taskStore: createTaskStore(input.db, {
      tableName: AGENT_TASK_TABLES.flight,
      owner: FLIGHT_AGENT_IDENTITY,
    }),
    executor: createFlightExecutor({
      config: input.config,
      serverConfig: input.serverConfig,
      admission: input.admission,
      pool: input.pool,
      mcp: input.mcp,
      protocol: input.config.protocol,
      rankingDeps: input.rankingDeps,
    }),
  });
  return app;
}
