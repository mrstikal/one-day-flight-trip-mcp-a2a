import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  DEFAULT_PROTOCOL_TIMEOUTS,
  trustedRegistrySchema,
  type ProtocolConfig,
  type TrustedRegistry,
} from "@odft/protocols";

/**
 * Phase 05 Flight Agent configuration (plan §3.15): loopback binding, trusted
 * inbound registry, the agent's own database role, MCP endpoints and the
 * governed AI mode. No secrets in source.
 */

export const FLIGHT_AGENT_IDENTITY = "flight-agent";
export const FLIGHT_SKILL_ID = "flight.recommend.v1";

const envSchema = z
  .object({
    port: z.number().int().min(1).max(65535).default(4401),
    host: z.string().min(1).default("127.0.0.1"),
    databaseUrl: z.string().min(1),
    registryPath: z.string().min(1),
    mcpRegistryPath: z.string().min(1).nullable().default(null),
    selfTokenRef: z.string().min(1).default("ODFT_AGENT_TOKEN_FLIGHT"),
    aiMode: z.enum(["fixture", "openrouter"]).default("fixture"),
    aiConfigPath: z.string().min(1).nullable().default(null),
    crashBeforeWork: z.boolean().default(false),
  })
  .strict();

export interface FlightAgentConfig {
  readonly host: string;
  readonly port: number;
  /** Restricted `odft_flight_agent` role connection (never the owner role). */
  readonly databaseUrl: string;
  readonly registryPath: string;
  readonly mcpRegistryPath: string | null;
  readonly aiMode: "fixture" | "openrouter";
  readonly aiConfigPath: string | null;
  readonly crashBeforeWork: boolean;
  readonly inbound: TrustedRegistry;
  /** Client-side config used to reach the MCP endpoints (Phase 04). */
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

export function loadFlightAgentConfig(
  env: Record<string, string | undefined> = process.env,
): FlightAgentConfig {
  const parsed = envSchema.parse({
    port: envNumber(env, "ODFT_FLIGHT_AGENT_PORT", 4401),
    host: env.ODFT_FLIGHT_AGENT_HOST ?? "127.0.0.1",
    databaseUrl: env.DATABASE_URL ?? "",
    registryPath: env.ODFT_FLIGHT_AGENT_REGISTRY_PATH ?? "",
    mcpRegistryPath: env.ODFT_MCP_REGISTRY_PATH ?? null,
    selfTokenRef: env.ODFT_FLIGHT_AGENT_TOKEN_REF ?? "ODFT_AGENT_TOKEN_FLIGHT",
    aiMode: env.AI_MODE === "openrouter" ? "openrouter" : "fixture",
    aiConfigPath: env.AI_CONFIG_PATH ?? null,
    crashBeforeWork: env.ODFT_FLIGHT_AGENT_CRASH === "1",
  });
  if (!parsed.databaseUrl) {
    throw new Error("DATABASE_URL is required for the flight agent");
  }
  const inbound = trustedRegistrySchema.parse(
    JSON.parse(readFileSync(parsed.registryPath, "utf8")),
  );
  const mcpRegistry = parsed.mcpRegistryPath
    ? JSON.parse(readFileSync(parsed.mcpRegistryPath, "utf8"))
    : { schemaVersion: 1, services: [] };
  return {
    host: parsed.host,
    port: parsed.port,
    databaseUrl: parsed.databaseUrl,
    registryPath: parsed.registryPath,
    mcpRegistryPath: parsed.mcpRegistryPath,
    aiMode: parsed.aiMode,
    aiConfigPath: parsed.aiConfigPath,
    crashBeforeWork: parsed.crashBeforeWork,
    inbound,
    protocol: {
      selfAgentIdentity: FLIGHT_AGENT_IDENTITY,
      registry: inbound,
      mcpRegistry,
      timeouts: DEFAULT_PROTOCOL_TIMEOUTS,
      resolveCredential: (ref) => env[ref],
    },
  };
}
