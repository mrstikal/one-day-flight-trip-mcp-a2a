import type { Server } from "node:http";
import { loadLocalEnv } from "./load-env.js";
import { MCP_ENDPOINTS, loadMcpHostConfig, type McpEndpointKey } from "./config.js";
import { createEndpointApp, createMcpHostContext } from "./app.js";
import { createGeographyServerFactory } from "./servers/geography.js";
import { createTravelDataServerFactory } from "./servers/travel-data.js";
import { createItineraryToolsServerFactory } from "./servers/itinerary-tools.js";

/**
 * Phase 04 MCP host entry point: starts the three read-only endpoints
 * (geography, travel-data, itinerary-tools) on their configured local ports
 * with graceful shutdown. Each endpoint has its own identity and bearer tokens
 * from the trusted registry; the health route performs no external request.
 */

loadLocalEnv();

const config = loadMcpHostConfig();
const context = createMcpHostContext(config);

const factories: Record<McpEndpointKey, () => ReturnType<typeof createGeographyServerFactory>> = {
  geography: () => createGeographyServerFactory(context),
  travelData: () => createTravelDataServerFactory(context),
  itineraryTools: () => createItineraryToolsServerFactory(context),
};

const servers: Server[] = [];
for (const endpoint of Object.keys(MCP_ENDPOINTS) as McpEndpointKey[]) {
  const app = createEndpointApp(context, endpoint, factories[endpoint]());
  const server = app.listen(config.ports[endpoint], config.host, () => {
    process.stdout.write(
      `mcp-host ready: ${MCP_ENDPOINTS[endpoint].name} on http://${config.host}:${config.ports[endpoint]}${MCP_ENDPOINTS[endpoint].path}\n`,
    );
  });
  servers.push(server);
}

async function shutdown(): Promise<void> {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await context.close();
}

process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(130));
});
process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(143));
});
