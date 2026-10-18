import {
  McpServer,
  type McpRequestContext,
  type McpServerFactory,
} from "@modelcontextprotocol/server";
import { ENDPOINT_ALLOWED_AGENTS } from "../config.js";
import type { McpHostContext } from "../app.js";
import { registerTravelDataTools } from "../tools/travel-data.js";
import { registerScenarioManifestResource } from "../resources.js";

/** Travel Data endpoint factory (frozen-snapshot queries, delegation-scoped). */
export function createTravelDataServerFactory(context: McpHostContext): McpServerFactory {
  return (requestContext: McpRequestContext) => {
    const identity = requestContext.authInfo?.clientId;
    if (!identity) {
      throw new Error("unauthenticated MCP request reached the server factory");
    }
    // Endpoint allowlist enforced here, before any tool is even registered.
    if (!ENDPOINT_ALLOWED_AGENTS["travelData"].includes(identity)) {
      throw new Error(`identity ${identity} may not call the travelData endpoint`);
    }
    const server = new McpServer({ name: "odft-travel-data", version: "1.0.0" });
    registerTravelDataTools(server, context, identity);
    registerScenarioManifestResource(server, context, identity);
    return server;
  };
}
