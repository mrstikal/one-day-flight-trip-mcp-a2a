import { Client, SdkHttpError, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/client";
import type { ProtocolConfig, McpServiceEntry } from "../config.js";

/**
 * Phase 03 MCP client (plan §3.2, §3.12/§3.13).
 *
 * Modern pinned client: `versionNegotiation: { mode: { pin: '2026-07-28' } }`,
 * so the client never silently falls back to 2025-era behavior. Every call has
 * an explicit deadline; tool calls get one bounded attempt and resource reads
 * may retry once (read-only operations only). Failures map to safe categories.
 */

export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28" as const;

export class McpClientError extends Error {
  readonly code: "MCP_UNAVAILABLE" | "MCP_TIMEOUT" | "INVALID_ARTIFACT";
  constructor(code: McpClientError["code"], message: string) {
    super(message);
    this.name = "McpClientError";
    this.code = code;
  }
}

export interface McpClientDependencies {
  readonly config: ProtocolConfig;
  readonly fetchImpl?: typeof fetch;
}

interface ConnectedClient {
  readonly client: Client;
  readonly transport: StreamableHTTPClientTransport;
  readonly service: McpServiceEntry;
}

export class McpClient {
  /** One live connection per trusted MCP endpoint per process (plan §3.4). */
  private readonly connections = new Map<string, Promise<ConnectedClient>>();
  private readonly activeCalls = new Map<string, number>();

  constructor(private readonly deps: McpClientDependencies) {}

  serviceFor(serviceName: string): McpServiceEntry {
    const service = this.deps.config.mcpRegistry.services.find(
      (entry) => entry.serviceName === serviceName,
    );
    if (!service) {
      throw new McpClientError("MCP_UNAVAILABLE", `MCP service ${serviceName} is not trusted`);
    }
    return service;
  }

  private async connect(service: McpServiceEntry): Promise<ConnectedClient> {
    const token = this.deps.config.resolveCredential(service.credentialRef);
    if (!token) {
      throw new McpClientError(
        "MCP_UNAVAILABLE",
        `missing credential for MCP service ${service.serviceName}`,
      );
    }
    const transport = new StreamableHTTPClientTransport(new URL(service.endpointUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      ...(this.deps.fetchImpl ? { fetch: this.deps.fetchImpl } : {}),
    });
    const client = new Client(
      { name: "odft-coordinator", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: MCP_MODERN_PROTOCOL_VERSION } } },
    );
    try {
      // The connect handshake is under the same explicit deadline as calls: an
      // unreachable endpoint must not hang the caller.
      await withDeadline(
        this.deps.config.timeouts.mcpTimeoutMs,
        () => client.connect(transport),
        () =>
          new McpClientError(
            "MCP_TIMEOUT",
            `MCP service ${service.serviceName} did not complete its handshake in time`,
          ),
      );
    } catch (error) {
      // A timed-out/failed handshake must not leak the transport or its socket.
      await client.close().catch(() => undefined);
      if (error instanceof McpClientError) {
        throw error;
      }
      throw new McpClientError(
        "MCP_UNAVAILABLE",
        `MCP service ${service.serviceName} is unavailable`,
      );
    }
    return { client, transport, service };
  }

  private async connectionFor(service: McpServiceEntry): Promise<ConnectedClient> {
    const existing = this.connections.get(service.serviceName);
    if (existing) {
      return existing;
    }
    const pending = this.connect(service);
    this.connections.set(service.serviceName, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.connections.get(service.serviceName) === pending) {
        this.connections.delete(service.serviceName);
      }
      throw error;
    }
  }

  private async invalidateConnection(serviceName: string): Promise<void> {
    const pending = this.connections.get(serviceName);
    this.connections.delete(serviceName);
    if (!pending) {
      return;
    }
    const connected = await pending.catch(() => undefined);
    await connected?.client.close().catch(() => undefined);
  }

  /** Graceful shutdown: close every cached MCP connection. */
  async close(): Promise<void> {
    const pending = [...this.connections.values()];
    this.connections.clear();
    for (const connection of pending) {
      const connected = await connection.catch(() => undefined);
      await connected?.client.close().catch(() => undefined);
    }
  }

  private async withClient<T>(
    serviceName: string,
    work: (connected: ConnectedClient) => Promise<T>,
  ): Promise<T> {
    const service = this.serviceFor(serviceName);
    this.activeCalls.set(serviceName, (this.activeCalls.get(serviceName) ?? 0) + 1);
    try {
      const connected = await this.connectionFor(service);
      return await withDeadline(
        this.deps.config.timeouts.mcpTimeoutMs,
        () => work(connected),
        () => new McpClientError("MCP_TIMEOUT", `MCP call to ${serviceName} exceeded its deadline`),
      );
    } catch (error) {
      // Invalidate only when this is the last in-flight call: closing a
      // connection still serving a concurrent sibling would abort valid work.
      if ((this.activeCalls.get(serviceName) ?? 1) <= 1) {
        await this.invalidateConnection(serviceName);
      }
      throw error;
    } finally {
      const remaining = (this.activeCalls.get(serviceName) ?? 1) - 1;
      if (remaining <= 0) {
        this.activeCalls.delete(serviceName);
      } else {
        this.activeCalls.set(serviceName, remaining);
      }
    }
  }

  /** The negotiated protocol version of a live connection (asserted in tests). */
  async negotiatedProtocolVersion(serviceName: string): Promise<string | undefined> {
    return this.withClient(serviceName, async ({ client }) =>
      client.getNegotiatedProtocolVersion(),
    );
  }

  async listTools(serviceName: string): Promise<Awaited<ReturnType<Client["listTools"]>>> {
    return this.withClient(serviceName, async ({ client }) => client.listTools());
  }

  async listResources(serviceName: string): Promise<Awaited<ReturnType<Client["listResources"]>>> {
    return this.withClient(serviceName, async ({ client }) => client.listResources());
  }

  /** One bounded tool call; never retried automatically (not read-only). */
  async callTool(
    serviceName: string,
    params: Parameters<Client["callTool"]>[0],
  ): Promise<CallToolResult> {
    return this.withClient(serviceName, async ({ client }) => client.callTool(params));
  }

  /**
   * Read-only resource read with at most one extra attempt for an eligible
   * transport failure. Invalid input, permission denials and timeouts are
   * never retried (plan §3.9).
   */
  async readResource(
    serviceName: string,
    params: Parameters<Client["readResource"]>[0],
  ): Promise<ReadResourceResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.deps.config.timeouts.mcpReadRetries; attempt += 1) {
      try {
        return await this.withClient(serviceName, async ({ client }) =>
          client.readResource(params),
        );
      } catch (error) {
        lastError = error;
        if (error instanceof McpClientError) {
          throw error;
        }
        // HTTP-level denials are never retried: an authentication, permission or
        // invalid-input failure will fail again (plan §3.9).
        if (error instanceof SdkHttpError && error.status >= 400 && error.status < 500) {
          throw error;
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new McpClientError("MCP_UNAVAILABLE", `MCP resource read failed`);
  }
}

async function withDeadline<T>(
  timeoutMs: number,
  work: () => Promise<T>,
  onTimeout: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
