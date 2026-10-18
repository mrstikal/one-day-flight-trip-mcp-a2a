import type { Express, Request, RequestHandler } from "express";
import {
  DefaultRequestHandler,
  ServerCallContext,
  type AgentExecutor,
  type TaskStore,
  type User,
} from "@a2a-js/sdk/server";
import type { AgentCard } from "@a2a-js/sdk";
import { agentCardHandler, jsonRpcHandler } from "@a2a-js/sdk/server/express";
import { validateHostHeader, validateOriginHeader } from "@modelcontextprotocol/server";
import type { ProtocolConfig } from "../config.js";
import { authenticateServiceRequest, isAuthorizedCaller } from "../auth.js";
import { AgentConcurrencyGate, withAgentConcurrency } from "./concurrency.js";

/**
 * Phase 03 A2A server wiring (plan §3.2, §3.15).
 *
 * The official request handler, express card and JSON-RPC middlewares do all
 * wire processing, serialization, lifecycle events, streaming and storage.
 * This module only composes them: agent card, task store, executor, and a
 * bearer-verifying `UserBuilder` so the SDK's call context carries the
 * authenticated service identity (never a caller-supplied body value).
 */

export interface A2AServerDependencies {
  readonly config: ProtocolConfig;
  readonly agentCard: AgentCard;
  readonly taskStore: TaskStore;
  readonly executor: AgentExecutor;
}

/** Bearer-verifying user builder: the authenticated identity or unauthenticated. */
export function serviceUserBuilder(config: ProtocolConfig): (request: Request) => Promise<User> {
  return async (request: Request): Promise<User> => {
    try {
      // The raw Authorization header: the helper parses the bearer itself.
      const identity = authenticateServiceRequest(config, request.headers.authorization);
      return {
        get isAuthenticated(): boolean {
          return true;
        },
        get userName(): string {
          return identity.agentIdentity;
        },
      };
    } catch {
      return {
        get isAuthenticated(): boolean {
          return false;
        },
        get userName(): string {
          return "unauthenticated";
        },
      };
    }
  };
}

export interface MountedA2AServer {
  readonly requestHandler: DefaultRequestHandler;
  readonly cardPath: string;
  readonly rpcPath: string;
}

/**
 * Reject every JSON-RPC method the admission middleware does not already guard
 * (SendMessage/SendStreamingMessage) when the caller is not the configured
 * service identity. Without this, the SDK's default handlers answer GetTask,
 * ListTasks and CancelTask for unauthenticated callers: the task store's owner
 * is fixed, so those methods would enumerate and cancel the agent's tasks.
 */
export function requireServiceIdentity(config: ProtocolConfig): RequestHandler {
  return (request, response, next) => {
    const body = request.body as { id?: unknown; method?: unknown } | undefined;
    if (!body || typeof body !== "object" || typeof body.method !== "string") {
      next();
      return;
    }
    try {
      const identity = authenticateServiceRequest(config, request.headers.authorization);
      if (!isAuthorizedCaller(config, identity, config.selfAgentIdentity)) {
        response.status(403).json({
          jsonrpc: "2.0",
          id: body.id ?? null,
          error: { code: -32600, message: "forbidden" },
        });
        return;
      }
      next();
    } catch {
      response.status(401).json({
        jsonrpc: "2.0",
        id: body.id ?? null,
        error: { code: -32600, message: "unauthorized" },
      });
    }
  };
}

/**
 * Host + Origin validation for the A2A surface (plan §3.15). Bearer auth alone
 * is not enough: a browser or DNS-rebinding client must be rejected before any
 * JSON-RPC method reaches admission.
 */
export function a2aHostValidationMiddleware(
  options: {
    readonly allowedHostnames?: readonly string[];
    readonly allowedOriginHostnames?: readonly string[];
  } = {},
): RequestHandler {
  const allowedHosts = [
    ...(options.allowedHostnames ?? ["127.0.0.1", "localhost", "::1", "[::1]"]),
  ];
  const allowedOrigins = [
    ...(options.allowedOriginHostnames ?? options.allowedHostnames ?? allowedHosts),
  ];
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
 * Mount the official card + JSON-RPC handlers on an Express app.
 * `legacyCompat` stays disabled: only the v1.0 interface is served.
 */
export function mountA2AServer(
  app: Express,
  deps: A2AServerDependencies,
  options: {
    readonly cardPath?: string;
    readonly rpcPath?: string;
    readonly allowedHostnames?: readonly string[];
    readonly allowedOriginHostnames?: readonly string[];
    /** Per-agent execution gate; `false` disables it (tests only). */
    readonly concurrency?: { readonly concurrency?: number; readonly queueLimit?: number } | false;
    /** Settle the durable task-control row when the queue rejects a task. */
    readonly onSaturation?: (taskId: string) => Promise<void>;
  } = {},
): MountedA2AServer {
  const cardPath = options.cardPath ?? "/.well-known/agent-card.json";
  const rpcPath = options.rpcPath ?? "/";
  const hostValidation = a2aHostValidationMiddleware(options);
  const executor =
    options.concurrency === false
      ? deps.executor
      : withAgentConcurrency(
          deps.executor,
          new AgentConcurrencyGate(options.concurrency ?? {}),
          options.onSaturation,
        );
  const requestHandler = new DefaultRequestHandler(deps.agentCard, deps.taskStore, executor);
  app.use(cardPath, hostValidation, agentCardHandler({ agentCardProvider: requestHandler }));
  app.use(
    rpcPath,
    hostValidation,
    requireServiceIdentity(deps.config),
    jsonRpcHandler({
      requestHandler,
      userBuilder: serviceUserBuilder(deps.config),
    }),
  );
  return { requestHandler, cardPath, rpcPath };
}

/** Re-export for fixtures/tests that need to build call contexts directly. */
export { ServerCallContext };
