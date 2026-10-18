import { readFileSync } from "node:fs";
import { z } from "zod";
import { DEFAULT_PROTOCOL_TIMEOUTS, trustedRegistrySchema, type ProtocolConfig, type TrustedRegistry } from "@odft/protocols";

/**
 * Phase 04 MCP host configuration (plan §3.4).
 *
 * Three read-only endpoints, each with its own identity and bearer token; the
 * trusted registry lists the agent identities allowed to call them. Everything
 * comes from the environment / a registry file — no secrets in source.
 */

export const MCP_ENDPOINTS = {
  geography: { name: "odft-geography", path: "/geography/mcp", defaultPort: 4321 },
  travelData: { name: "odft-travel-data", path: "/travel-data/mcp", defaultPort: 4322 },
  itineraryTools: { name: "odft-itinerary-tools", path: "/itinerary-tools/mcp", defaultPort: 4323 },
} as const;
export type McpEndpointKey = keyof typeof MCP_ENDPOINTS;

/** Which authenticated agent identities may call which endpoint. */
export const ENDPOINT_ALLOWED_AGENTS: Readonly<Record<McpEndpointKey, readonly string[]>> = {
  geography: ["flight-agent", "accommodation-agent", "accommodation-agent-alt", "city-guide-agent"],
  travelData: ["flight-agent", "accommodation-agent", "accommodation-agent-alt", "city-guide-agent"],
  itineraryTools: ["city-guide-agent"],
};

/**
 * Per-identity domain allowlist of the travel-data endpoint (plan §3.4 table):
 * Flight gets flights/metadata, Accommodation hotels/metadata, City Guide the
 * meal/activity/event domains.
 */
export const TRAVEL_DATA_DOMAIN_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  "flight-agent": ["flights"],
  "accommodation-agent": ["hotel"],
  "accommodation-agent-alt": ["hotel"],
  "city-guide-agent": ["breakfast", "lunch", "dinner", "attractions", "events"],
};

const endpointConfigSchema = z
  .object({
    geographyPort: z.number().int().min(1).max(65535).default(MCP_ENDPOINTS.geography.defaultPort),
    travelDataPort: z.number().int().min(1).max(65535).default(MCP_ENDPOINTS.travelData.defaultPort),
    itineraryToolsPort: z.number().int().min(1).max(65535).default(MCP_ENDPOINTS.itineraryTools.defaultPort),
    host: z.string().min(1).default("127.0.0.1"),
  })
  .strict();

export interface McpHostConfig {
  readonly databaseUrl: string;
  readonly host: string;
  readonly ports: Readonly<Record<McpEndpointKey, number>>;
  /** Trusted inbound registry: agent identities + tokens for each endpoint. */
  readonly inbound: TrustedRegistry;
  readonly timeouts: typeof DEFAULT_PROTOCOL_TIMEOUTS;
  /** Registry the protocol client uses when this host is a client (tests). */
  readonly protocol: ProtocolConfig;
}

function envNumber(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadMcpHostConfig(env: Record<string, string | undefined> = process.env): McpHostConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the MCP host");
  }
  const registryPath = env.ODFT_MCP_AGENT_REGISTRY_PATH;
  if (!registryPath) {
    throw new Error(
      "ODFT_MCP_AGENT_REGISTRY_PATH is required (trusted agent registry with credential refs)",
    );
  }
  const inbound = trustedRegistrySchema.parse(JSON.parse(readFileSync(registryPath, "utf8")));
  const endpoints = endpointConfigSchema.parse({
    geographyPort: envNumber(env, "ODFT_MCP_GEOGRAPHY_PORT", MCP_ENDPOINTS.geography.defaultPort),
    travelDataPort: envNumber(env, "ODFT_MCP_TRAVEL_DATA_PORT", MCP_ENDPOINTS.travelData.defaultPort),
    itineraryToolsPort: envNumber(env, "ODFT_MCP_ITINERARY_TOOLS_PORT", MCP_ENDPOINTS.itineraryTools.defaultPort),
    host: env.ODFT_MCP_HOST ?? "127.0.0.1",
  });
  const selfAgentIdentity = env.ODFT_MCP_SELF_IDENTITY ?? MCP_ENDPOINTS.geography.name;
  return {
    databaseUrl,
    host: endpoints.host,
    ports: {
      geography: endpoints.geographyPort,
      travelData: endpoints.travelDataPort,
      itineraryTools: endpoints.itineraryToolsPort,
    },
    inbound,
    timeouts: DEFAULT_PROTOCOL_TIMEOUTS,
    protocol: {
      selfAgentIdentity,
      registry: inbound,
      mcpRegistry: {
        schemaVersion: 1,
        services: [
          {
            serviceName: MCP_ENDPOINTS.geography.name,
            endpointUrl: `http://${endpoints.host}:${endpoints.geographyPort}${MCP_ENDPOINTS.geography.path}`,
            credentialRef: "ODFT_MCP_TOKEN_GEOGRAPHY",
          },
          {
            serviceName: MCP_ENDPOINTS.travelData.name,
            endpointUrl: `http://${endpoints.host}:${endpoints.travelDataPort}${MCP_ENDPOINTS.travelData.path}`,
            credentialRef: "ODFT_MCP_TOKEN_TRAVEL_DATA",
          },
          {
            serviceName: MCP_ENDPOINTS.itineraryTools.name,
            endpointUrl: `http://${endpoints.host}:${endpoints.itineraryToolsPort}${MCP_ENDPOINTS.itineraryTools.path}`,
            credentialRef: "ODFT_MCP_TOKEN_ITINERARY_TOOLS",
          },
        ],
      },
      timeouts: DEFAULT_PROTOCOL_TIMEOUTS,
      resolveCredential: (ref) => env[ref],
    },
  };
}
