import { Pool } from "pg";
import type { RequestHandler } from "express";
import express from "express";
import { z } from "zod";
import {
  delegationScopeSchema,
  type DelegationDomain,
  type DelegationScope,
  type TripRecord,
} from "@odft/contracts";

export type { DelegationDomain };
import {
  findActiveDelegationForSnapshot,
  getAgentDelegation,
  getTrip,
  loadOverlay,
  type AgentDelegationRecord,
} from "@odft/persistence";
import { ProtocolTelemetryWriter, buildObservation, createMcpServerMiddleware } from "@odft/protocols";
import { createTravelSnapshotReadService, type TravelSnapshotReadService } from "@odft/services";
import { createTravelItineraryToolsService, type TravelItineraryToolsService } from "@odft/services";
import { ENDPOINT_ALLOWED_AGENTS, MCP_ENDPOINTS, type McpEndpointKey, type McpHostConfig } from "./config.js";

/**
 * Phase 04 MCP host (plan §3.4): three read-only endpoints over two database
 * roles — the protocol role for delegation authorization reads and safe
 * observations, and the read-only domain/reference role for every domain read.
 * No tool can write bookings, snapshots, artifacts or fault counters.
 */

export class McpAuthorizationError extends Error {
  readonly code: "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT";
  constructor(code: McpAuthorizationError["code"], message: string) {
    super(message);
    this.name = "McpAuthorizationError";
    this.code = code;
  }
}

export interface AuthorizedDelegation {
  readonly delegation: AgentDelegationRecord;
  readonly scope: DelegationScope;
  readonly trip: TripRecord;
  /** Resolved immutable fault overlay of the delegated domain (read-only). */
  readonly behavior: Awaited<ReturnType<typeof loadOverlay>>;
  readonly attempt: number;
}

export interface McpHostContext {
  readonly config: McpHostConfig;
  readonly readPool: Pool;
  readonly authPool: Pool;
  readonly snapshotRead: TravelSnapshotReadService;
  readonly itineraryTools: TravelItineraryToolsService;
  readonly telemetry: ProtocolTelemetryWriter;
  /** The caller's newest active delegation for a snapshot (resource reads). */
  delegationForSnapshot(identity: string, snapshotId: string): Promise<string>;
  /** Best-effort correlation for a tool-call observation (never throws). */
  correlationForDelegation(delegationId: string): Promise<{
    readonly tripId: string;
    readonly operationId: string;
    readonly delegationId: string;
    readonly taskId: string | null;
  } | undefined>;
  authorize(input: {
    readonly identity: string;
    readonly endpoint: McpEndpointKey;
    readonly delegationId: string;
    readonly domain?: string;
    readonly snapshotId?: string;
    readonly needRouteValidation?: boolean;
    readonly needItinerary?: boolean;
  }): Promise<AuthorizedDelegation>;
  close(): Promise<void>;
}

/** Map a delegation domain to its persisted overlay domain (plan §3.11). */
const overlayDomainFor = (
  domain: string,
): "flights" | "hotels" | "breakfast" | "lunch" | "dinner" | "activities" | "events" =>
  domain === "hotel"
    ? "hotels"
    : domain === "attractions"
      ? "activities"
      : (domain as "flights" | "breakfast" | "lunch" | "dinner" | "events");

export function createMcpHostContext(config: McpHostConfig): McpHostContext {
  // Delegation authorization and observations use the protocol service role
  // when configured; the read-only role never sees authorization state.
  const authPool = new Pool({
    connectionString: process.env.ODFT_PROTOCOL_DATABASE_URL ?? config.databaseUrl,
    max: 4,
    application_name: "odft-mcp-auth",
  });
  const readOnlyUrl = process.env.ODFT_MCP_READONLY_DATABASE_URL;
  if (!readOnlyUrl) {
    throw new Error(
      "ODFT_MCP_READONLY_DATABASE_URL is required: the MCP host reads domain/reference data only through the read-only role",
    );
  }
  const readPool = new Pool({ connectionString: readOnlyUrl, max: 6, application_name: "odft-mcp-read" });
  const telemetry = new ProtocolTelemetryWriter(authPool);

  const context: McpHostContext = {
    config,
    readPool,
    authPool,
    snapshotRead: createTravelSnapshotReadService({ pool: readPool }),
    itineraryTools: createTravelItineraryToolsService({ pool: readPool }),
    telemetry,

    async delegationForSnapshot(identity, snapshotId) {
      const delegationId = await findActiveDelegationForSnapshot(authPool, {
        agentIdentity: identity,
        snapshotId,
      });
      if (!delegationId) {
        throw new McpAuthorizationError(
          "NOT_FOUND",
          "no active delegation authorizes this snapshot for the caller",
        );
      }
      return delegationId;
    },

    async correlationForDelegation(delegationId) {
      try {
        const delegation = await getAgentDelegation(authPool, delegationId);
        if (!delegation) {
          return undefined;
        }
        return {
          tripId: delegation.tripId,
          operationId: delegation.originatingOperationId,
          delegationId: delegation.id,
          taskId: delegation.taskId,
        };
      } catch {
        return undefined;
      }
    },

    async authorize(input) {
      const allowed = ENDPOINT_ALLOWED_AGENTS[input.endpoint];
      if (!allowed.includes(input.identity)) {
        throw new McpAuthorizationError(
          "FORBIDDEN",
          `identity ${input.identity} may not call the ${input.endpoint} endpoint`,
        );
      }
      const delegation = await getAgentDelegation(authPool, input.delegationId);
      if (!delegation) {
        throw new McpAuthorizationError("NOT_FOUND", `delegation ${input.delegationId} not found`);
      }
      if (delegation.agentIdentity !== input.identity) {
        throw new McpAuthorizationError(
          "FORBIDDEN",
          "the delegation belongs to a different agent identity",
        );
      }
      if (delegation.status === "revoked" || delegation.status === "cancelled" || delegation.status === "failed") {
        throw new McpAuthorizationError("FORBIDDEN", `delegation is ${delegation.status}`);
      }
      if (delegation.deadlineAt && Date.parse(delegation.deadlineAt) < Date.now()) {
        throw new McpAuthorizationError("FORBIDDEN", "delegation deadline has passed");
      }
      const scope = delegationScopeSchema.parse(delegation.scope);
      if (input.domain && !scope.domains.includes(input.domain as DelegationDomain)) {
        throw new McpAuthorizationError(
          "FORBIDDEN",
          `domain ${input.domain} is outside the delegated scope`,
        );
      }
      if (input.snapshotId && scope.snapshotId !== input.snapshotId) {
        throw new McpAuthorizationError(
          "FORBIDDEN",
          "the requested snapshot is not the delegated frozen snapshot",
        );
      }
      if (input.needRouteValidation && !scope.allowRouteValidation) {
        throw new McpAuthorizationError("FORBIDDEN", "route validation is outside the delegated scope");
      }
      if (input.needItinerary && !scope.allowItinerary) {
        throw new McpAuthorizationError("FORBIDDEN", "itinerary tools are outside the delegated scope");
      }
      const trip = await getTrip(readPool, delegation.tripId);
      if (!trip) {
        throw new McpAuthorizationError("NOT_FOUND", `trip ${delegation.tripId} not found`);
      }
      const domain = input.domain ?? scope.domains[0];
      const behavior = domain
        ? await loadOverlay(readPool, delegation.tripId, overlayDomainFor(domain), delegation.originatingOperationId)
        : null;
      return { delegation, scope, trip, behavior, attempt: delegation.attempt };
    },

    async close() {
      await authPool.end().catch(() => undefined);
      await readPool.end().catch(() => undefined);
    },
  };
  return context;
}

/** Build one endpoint's express app: health + host/auth checks + MCP handler. */
export function createEndpointApp(
  context: McpHostContext,
  endpoint: McpEndpointKey,
  factory: Parameters<typeof createMcpServerMiddleware>[0]["factory"],
): express.Express {
  const app = express();
  app.get("/health", (_request, response) => {
    // Lightweight liveness only: no database, provider or external request.
    response.json({ status: "ok", endpoint: MCP_ENDPOINTS[endpoint].name, version: "1.0.0" });
  });
  app.use(express.json({ limit: "1mb" }));
  const mounted = createMcpServerMiddleware({
    config: context.config.protocol,
    factory,
    allowedHostnames: [new URL(context.config.protocol.mcpRegistry.services[0]!.endpointUrl).hostname, "localhost", "127.0.0.1"],
    onerror: (error) => {
      void context.telemetry.record(
        buildObservation({
          source: sourceFor(endpoint),
          kind: "mcp_tool_call",
          payload: { detail: `handler error: ${error.message}`, status: "error" },
        }),
      );
    },
  });
  app.use(MCP_ENDPOINTS[endpoint].path, ...mounted.middleware);
  return app;
}

export function sourceFor(endpoint: McpEndpointKey): "mcp-geography" | "mcp-travel-data" | "mcp-itinerary-tools" {
  return endpoint === "geography"
    ? "mcp-geography"
    : endpoint === "travelData"
      ? "mcp-travel-data"
      : "mcp-itinerary-tools";
}

/**
 * Wrap a tool handler so failures become safe MCP tool errors and every real
 * invocation is recorded as one sanitized observation (name, duration, safe
 * outcome) — never arguments, results or credentials.
 */
export function createToolHandler<Input, Output>(
  context: McpHostContext,
  endpoint: McpEndpointKey,
  toolName: string,
  handler: (input: Input) => Promise<Output>,
): (input: Input) => Promise<{ content: { type: "text"; text: string }[]; structuredContent: Output; isError?: boolean }> {
  return async (input: Input) => {
    const startedAt = Date.now();
    const delegationId = (input as { delegationId?: unknown } | null)?.delegationId;
    const correlation =
      typeof delegationId === "string"
        ? await context.correlationForDelegation(delegationId)
        : undefined;
    try {
      const result = await handler(input);
      await context.telemetry.record(
        buildObservation({
          source: sourceFor(endpoint),
          kind: "mcp_tool_call",
          ...(correlation ? { correlation } : {}),
          payload: {
            detail: toolName,
            status: "ok",
            durationMs: Date.now() - startedAt,
            counters: {},
          },
        }),
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      const message =
        error instanceof McpAuthorizationError
          ? error.message
          : error instanceof z.ZodError
            ? "invalid tool arguments"
            : error instanceof Error
              ? error.message
              : "tool failed";
      await context.telemetry.record(
        buildObservation({
          source: sourceFor(endpoint),
          kind: "mcp_tool_call",
          ...(correlation ? { correlation } : {}),
          payload: {
            detail: `${toolName}: ${message}`,
            failureCategory:
              error instanceof McpAuthorizationError
                ? error.code === "FORBIDDEN" || error.code === "UNAUTHORIZED"
                  ? "DELEGATION_REVOKED"
                  : error.code === "NOT_FOUND"
                    ? "INVALID_ARTIFACT"
                    : "DELEGATION_REVOKED"
                : "INVALID_ARTIFACT",
            status: "error",
            durationMs: Date.now() - startedAt,
            counters: {},
          },
        }),
      );
      return {
        content: [{ type: "text" as const, text: message }],
        structuredContent: { error: message } as Output,
        isError: true,
      };
    }
  };
}

export type { RequestHandler };
