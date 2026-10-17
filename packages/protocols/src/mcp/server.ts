import type { RequestHandler } from "express";
import {
  createMcpHandler,
  validateHostHeader,
  validateOriginHeader,
  type McpHttpHandler,
  type McpServerFactory,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { authenticateServiceRequest } from "../auth.js";
import type { ProtocolConfig } from "../config.js";

/**
 * Phase 03 MCP server (plan §3.2, §3.15).
 *
 * Modern-only entry: `createMcpHandler({ legacy: 'reject' })` refuses 2025-era
 * negotiation with the SDK's unsupported-protocol-version error, and the Node
 * adapter (`toNodeHandler`) forwards the auth info our middleware verified.
 * Authentication runs BEFORE dispatch: an unauthenticated or wrong-origin
 * request never constructs a server instance or reaches a tool.
 */

export interface McpServerDependencies {
  readonly config: ProtocolConfig;
  readonly factory: McpServerFactory;
  /** Allowed Host header hostnames (e.g. localhost, 127.0.0.1). */
  readonly allowedHostnames: readonly string[];
  /** Allowed Origin hostnames; omitted means same-host origins only. */
  readonly allowedOriginHostnames?: readonly string[];
  readonly onerror?: (error: Error) => void;
}

export function createMcpServerHandler(deps: McpServerDependencies): McpHttpHandler {
  return createMcpHandler(deps.factory, {
    legacy: "reject",
    ...(deps.onerror ? { onerror: deps.onerror } : {}),
  });
}

/** Host + origin validation middleware (SDK helpers, fail closed). */
export function mcpHostValidationMiddleware(deps: McpServerDependencies): RequestHandler {
  const allowedHosts = [...deps.allowedHostnames];
  const allowedOrigins = deps.allowedOriginHostnames
    ? [...deps.allowedOriginHostnames]
    : allowedHosts;
  return (request, response, next) => {
    const host = validateHostHeader(request.headers.host, allowedHosts);
    if (!host.ok) {
      response.status(421).json({ error: "misdirected request" });
      return;
    }
    const origin = validateOriginHeader(request.headers.origin, allowedOrigins);
    if (!origin.ok) {
      response.status(403).json({ error: "forbidden origin" });
      return;
    }
    next();
  };
}

/**
 * Bearer verification middleware: verifies the trusted-registry token and puts
 * the pass-through auth info on the Node request, where `toNodeHandler`
 * forwards it as the handler's `authInfo`.
 */
export function mcpAuthMiddleware(config: ProtocolConfig): RequestHandler {
  return (request, response, next) => {
    try {
      // The raw Authorization header: the helper parses the bearer itself.
      const identity = authenticateServiceRequest(config, request.headers.authorization);
      (request as { auth?: unknown }).auth = {
        token: "verified",
        clientId: identity.agentIdentity,
        scopes: [],
      };
      next();
    } catch {
      response
        .status(401)
        .set("WWW-Authenticate", 'Bearer realm="odft", error="invalid_token"')
        .json({ error: "unauthorized" });
    }
  };
}

export interface MountedMcpServer {
  readonly handler: McpHttpHandler;
  readonly middleware: readonly RequestHandler[];
}

/**
 * The full middleware chain for one modern-only MCP endpoint.
 *
 * The Node adapter is wrapped so an upstream `express.json()` body is forwarded
 * as `parsedBody`: the adapter must not try to re-read a consumed stream (that
 * would surface as a parse error for every request).
 */
export function createMcpServerMiddleware(deps: McpServerDependencies): MountedMcpServer {
  const handler = createMcpServerHandler(deps);
  const nodeHandler = toNodeHandler(handler, deps.onerror ? { onerror: deps.onerror } : {}) as unknown as (
    request: unknown,
    response: unknown,
    parsedBody?: unknown,
  ) => void;
  const adapter: RequestHandler = (request, response, next) => {
    const parsedBody = (request as { body?: unknown }).body;
    if (parsedBody === undefined) {
      nodeHandler(request, response);
      return;
    }
    nodeHandler(request, response, parsedBody);
    void next;
  };
  return {
    handler,
    middleware: [mcpHostValidationMiddleware(deps), mcpAuthMiddleware(deps.config), adapter],
  };
}
