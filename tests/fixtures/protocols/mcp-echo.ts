import express from "express";
import { z } from "zod";
import { McpServer, type McpServerFactory } from "@modelcontextprotocol/server";
import {
  DEFAULT_PROTOCOL_TIMEOUTS,
  createMcpServerMiddleware,
  trustedRegistrySchema,
  type ProtocolConfig,
} from "@odft/protocols";
import { loadLocalEnv } from "../../../scripts/_load-env.js";

/**
 * Phase 03 MCP echo fixture: a REAL modern-only MCP server over HTTP used by
 * the interoperability tests. It serves one tool (`echo`) and one read-only
 * resource (`odft://echo/info`) through the official SDK, behind the
 * production middleware chain: host/origin validation and bearer verification
 * BEFORE any dispatch, with 2025-era negotiation rejected by the handler.
 *
 * Env: PORT, ODFT_MCP_ECHO_TOKEN.
 */

loadLocalEnv();

const port = Number.parseInt(process.env.PORT ?? "4214", 10);
const token = process.env.ODFT_MCP_ECHO_TOKEN ?? "fixture-mcp-token";
const endpointUrl = `http://127.0.0.1:${port}`;

const config: ProtocolConfig = {
  selfAgentIdentity: "mcp-echo",
  registry: trustedRegistrySchema.parse({
    schemaVersion: 1,
    agents: [
      {
        agentIdentity: "mcp-echo",
        endpointUrl,
        cardUrl: `${endpointUrl}/.well-known/agent-card.json`,
        credentialRef: "ODFT_MCP_ECHO_TOKEN",
        requiredSkills: ["flight.recommend.v1"],
      },
    ],
  }),
  mcpRegistry: {
    schemaVersion: 1,
    services: [
      { serviceName: "mcp-echo", endpointUrl, credentialRef: "ODFT_MCP_ECHO_TOKEN" },
    ],
  },
  timeouts: DEFAULT_PROTOCOL_TIMEOUTS,
  resolveCredential: (ref) => (ref === "ODFT_MCP_ECHO_TOKEN" ? token : process.env[ref]),
};

const factory: McpServerFactory = () => {
  const server = new McpServer({ name: "odft-mcp-echo", version: "1.0.0" });
  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Returns the provided payload unchanged (fixture).",
      inputSchema: z.object({ payload: z.string() }),
      outputSchema: z.object({ echoed: z.string(), server: z.literal("mcp-echo") }),
    },
    async ({ payload }) => {
      const output = { echoed: payload, server: "mcp-echo" as const };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
  server.registerResource(
    "echo-info",
    "odft://echo/info",
    { title: "Echo fixture info", mimeType: "application/json" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ name: "mcp-echo", protocol: "2026-07-28" }),
        },
      ],
    }),
  );
  return server;
};

const app = express();
app.use(express.json({ limit: "1mb" }));
const mounted = createMcpServerMiddleware({
  config,
  factory,
  allowedHostnames: ["localhost", "127.0.0.1"],
});
app.use("/mcp", ...mounted.middleware);

app.listen(port, "127.0.0.1", () => {
  process.stdout.write(`mcp-echo ready on ${endpointUrl}/mcp\n`);
});
