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
import { buildCityGuideAgentCard } from "./card.js";
import { createCityGuideExecutor } from "./executor.js";
import { CITY_GUIDE_AGENT_IDENTITY, type CityGuideAgentConfig } from "./config.js";
import type { ServerConfig } from "@odft/persistence";
import type { DelegatedItineraryDeps } from "@odft/services";

/**
 * Phase 06 City Guide Agent HTTP surface: durable admission middleware, official
 * card/JSON-RPC mount, and a health route that performs no external request.
 */
export function createCityGuideAgentApp(input: {
  config: CityGuideAgentConfig;
  serverConfig: ServerConfig;
  pool: Pool;
  db: Kysely<unknown>;
  admission: DurableMessageAdmission;
  telemetry: ProtocolTelemetryWriter;
  mcp: Parameters<typeof createCityGuideExecutor>[0]["mcp"];
  itineraryDeps: DelegatedItineraryDeps;
}): express.Express {
  const app = express();
  app.get("/health", (_request, response) => {
    response.json({ status: "ok", endpoint: CITY_GUIDE_AGENT_IDENTITY, version: "1.0.0" });
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
    agentCard: buildCityGuideAgentCard(input.config),
    taskStore: createTaskStore(input.db, {
      tableName: AGENT_TASK_TABLES.cityGuide,
      owner: CITY_GUIDE_AGENT_IDENTITY,
    }),
    executor: createCityGuideExecutor({
      config: input.config,
      serverConfig: input.serverConfig,
      admission: input.admission,
      pool: input.pool,
      mcp: input.mcp,
      protocol: input.config.protocol,
      itineraryDeps: input.itineraryDeps,
    }),
  });
  return app;
}
