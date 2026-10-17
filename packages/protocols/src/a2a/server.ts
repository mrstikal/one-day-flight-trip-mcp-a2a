import type { Express, Request } from "express";
import {
  DefaultRequestHandler,
  ServerCallContext,
  type AgentExecutor,
  type TaskStore,
  type User,
} from "@a2a-js/sdk/server";
import type { AgentCard } from "@a2a-js/sdk";
import { agentCardHandler, jsonRpcHandler } from "@a2a-js/sdk/server/express";
import type { ProtocolConfig } from "../config.js";
import { authenticateServiceRequest } from "../auth.js";

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
export function serviceUserBuilder(
  config: ProtocolConfig,
): (request: Request) => Promise<User> {
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
 * Mount the official card + JSON-RPC handlers on an Express app.
 * `legacyCompat` stays disabled: only the v1.0 interface is served.
 */
export function mountA2AServer(
  app: Express,
  deps: A2AServerDependencies,
  options: { readonly cardPath?: string; readonly rpcPath?: string } = {},
): MountedA2AServer {
  const cardPath = options.cardPath ?? "/.well-known/agent-card.json";
  const rpcPath = options.rpcPath ?? "/";
  const requestHandler = new DefaultRequestHandler(
    deps.agentCard,
    deps.taskStore,
    deps.executor,
  );
  app.use(
    cardPath,
    agentCardHandler({ agentCardProvider: requestHandler }),
  );
  app.use(
    rpcPath,
    jsonRpcHandler({
      requestHandler,
      userBuilder: serviceUserBuilder(deps.config),
    }),
  );
  return { requestHandler, cardPath, rpcPath };
}

/** Re-export for fixtures/tests that need to build call contexts directly. */
export { ServerCallContext };
