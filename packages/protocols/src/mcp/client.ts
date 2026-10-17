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

  private async withClient<T>(
    serviceName: string,
    work: (connected: ConnectedClient) => Promise<T>,
  ): Promise<T> {
    const service = this.serviceFor(serviceName);
    const connected = await this.connect(service);
    try {
      return await withDeadline(
        this.deps.config.timeouts.mcpTimeoutMs,
        () => work(connected),
        () =>
          new McpClientError("MCP_TIMEOUT", `MCP call to ${serviceName} exceeded its deadline`),
      );
    } finally {
      await connected.client.close().catch(() => undefined);
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
        return await this.withClient(serviceName, async ({ client }) => client.readResource(params));
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
