import { McpServer, type McpRequestContext, type McpServerFactory } from "@modelcontextprotocol/server";
import { ENDPOINT_ALLOWED_AGENTS } from "../config.js";
import type { McpHostContext } from "../app.js";
import { registerItineraryTools } from "../tools/itinerary-tools.js";
import { registerResources } from "../resources.js";

/** Itinerary Tools endpoint factory (deterministic preflight, read-only). */
export function createItineraryToolsServerFactory(context: McpHostContext): McpServerFactory {
  return (requestContext: McpRequestContext) => {
    const identity = requestContext.authInfo?.clientId;
    if (!identity) {
      throw new Error("unauthenticated MCP request reached the server factory");
    }
    // Endpoint allowlist enforced here, before any tool is even registered.
    if (!ENDPOINT_ALLOWED_AGENTS["itineraryTools"].includes(identity)) {
      throw new Error(`identity ${identity} may not call the itineraryTools endpoint`);
    }
    const server = new McpServer({ name: "odft-itinerary-tools", version: "1.0.0" });
    registerItineraryTools(server, context, identity);
    registerResources(server, context, identity, "itineraryTools");
    return server;
  };
}
