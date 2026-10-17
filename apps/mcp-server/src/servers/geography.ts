import { McpServer, type McpRequestContext, type McpServerFactory } from "@modelcontextprotocol/server";
import { ENDPOINT_ALLOWED_AGENTS } from "../config.js";
import type { McpHostContext } from "../app.js";
import { registerGeographyTools } from "../tools/geography.js";
import { registerResources } from "../resources.js";

/**
 * Geography endpoint factory: one `McpServer` per request so the authenticated
 * identity (verified by the shared middleware chain) is bound to its tools.
 */
export function createGeographyServerFactory(context: McpHostContext): McpServerFactory {
  return (requestContext: McpRequestContext) => {
    const identity = requestContext.authInfo?.clientId;
    if (!identity) {
      throw new Error("unauthenticated MCP request reached the server factory");
    }
    // Endpoint allowlist enforced here, before any tool is even registered.
    if (!ENDPOINT_ALLOWED_AGENTS["geography"].includes(identity)) {
      throw new Error(`identity ${identity} may not call the geography endpoint`);
    }
    const server = new McpServer({ name: "odft-geography", version: "1.0.0" });
    registerGeographyTools(server, context, identity);
    registerResources(server, context, identity, "geography");
    return server;
  };
}
