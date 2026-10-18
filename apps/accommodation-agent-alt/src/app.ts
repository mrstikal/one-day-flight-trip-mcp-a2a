import express from "express";
import type { Pool } from "pg";
import type { Kysely } from "kysely";
import {
  AGENT_TASK_TABLES,
  DurableMessageAdmission,
  ProtocolTelemetryWriter,
  a2aHostValidationMiddleware,
  createAdmissionMiddleware,
  createTaskStore,
  mountA2AServer,
} from "@odft/protocols";
import type { DelegatedFlightRankingDeps } from "@odft/services";
import { buildAccommodationAltAgentCard } from "./card.js";
import { createAccommodationAltExecutor } from "./executor.js";
import { ACCOMMODATION_ALT_AGENT_IDENTITY, type AccommodationAltAgentConfig } from "./config.js";
import { setTaskState, type ServerConfig } from "@odft/persistence";

/**
 * Phase 10 alternative Accommodation Agent HTTP surface: durable admission,
 * official card/JSON-RPC mount and a no-egress health route. Its task table is
 * `odft_protocol.agent_tasks_accommodation_alt`.
 */
export function createAccommodationAltAgentApp(input: {
  config: AccommodationAltAgentConfig;
  serverConfig: ServerConfig;
  pool: Pool;
  db: Kysely<unknown>;
  admission: DurableMessageAdmission;
  telemetry: ProtocolTelemetryWriter;
  mcp: Parameters<typeof createAccommodationAltExecutor>[0]["mcp"];
  rankingDeps?: DelegatedFlightRankingDeps;
}): express.Express {
  const app = express();
  app.get("/health", (_request, response) => {
    response.json({
      status: "ok",
      endpoint: ACCOMMODATION_ALT_AGENT_IDENTITY,
      version: "1.0.0",
      strategy: "value",
    });
  });
  // Host/Origin validation runs BEFORE admission: a misdirected or
  // browser-origin request never claims a message.
  app.use(
    a2aHostValidationMiddleware({
      allowedHostnames: [input.config.host, "127.0.0.1", "localhost", "[::1]"],
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(
    createAdmissionMiddleware({
      config: input.config.protocol,
      admission: input.admission,
      telemetry: input.telemetry,
    }),
  );
  mountA2AServer(
    app,
    {
      config: input.config.protocol,
      agentCard: buildAccommodationAltAgentCard(input.config),
      taskStore: createTaskStore(input.db, {
        tableName: AGENT_TASK_TABLES.accommodationAlt,
        owner: ACCOMMODATION_ALT_AGENT_IDENTITY,
      }),
      executor: createAccommodationAltExecutor({
        config: input.config,
        serverConfig: input.serverConfig,
        admission: input.admission,
        pool: input.pool,
        mcp: input.mcp,
        protocol: input.config.protocol,
        rankingDeps: input.rankingDeps,
      }),
    },
    {
      onSaturation: async (taskId) => {
        await setTaskState(input.pool, {
          agentIdentity: ACCOMMODATION_ALT_AGENT_IDENTITY,
          taskId,
          state: "failed",
        });
      },
    },
  );
  return app;
}
