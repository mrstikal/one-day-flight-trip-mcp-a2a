import { readFileSync } from "node:fs";
import { z } from "zod";
import { DEFAULT_PROTOCOL_TIMEOUTS, trustedRegistrySchema, type ProtocolConfig, type TrustedRegistry } from "@odft/protocols";

/**
 * Phase 06 City Guide Agent configuration (plan §3.3/§3.15): the inbound trusted
 * registry, the agent's own database role and the MCP endpoints.
 * `DATABASE_URL` must be the restricted `odft_city_guide_agent` role connection.
 */

export const CITY_GUIDE_AGENT_IDENTITY = "city-guide-agent";
export const CITY_GUIDE_SKILL_ID = "city-guide.research.v1";

const envSchema = z
  .object({
    port: z.number().int().min(1).max(65535).default(4403),
    host: z.string().min(1).default("127.0.0.1"),
    databaseUrl: z.string().min(1),
    registryPath: z.string().min(1),
    mcpRegistryPath: z.string().min(1).nullable().default(null),
    selfTokenRef: z.string().min(1).default("ODFT_AGENT_TOKEN_CITY_GUIDE"),
    stepDelayMs: z.number().int().min(0).max(60000).default(0),
  })
  .strict();

export interface CityGuideAgentConfig {
  readonly host: string;
  readonly port: number;
  /** Restricted `odft_city_guide_agent` role connection (never the owner role). */
  readonly databaseUrl: string;
  readonly registryPath: string;
  readonly mcpRegistryPath: string | null;
  /** Test-only delay between work steps (parallel-window observation). */
  readonly stepDelayMs: number;
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

export function loadCityGuideAgentConfig(env: Record<string, string | undefined> = process.env): CityGuideAgentConfig {
  const parsed = envSchema.parse({
    port: envNumber(env, "ODFT_CITY_GUIDE_AGENT_PORT", 4403),
    host: env["ODFT_CITY_GUIDE_AGENT_HOST"] ?? "127.0.0.1",
    databaseUrl: env.DATABASE_URL ?? "",
    registryPath: env["ODFT_CITY_GUIDE_AGENT_REGISTRY_PATH"] ?? "",
    mcpRegistryPath: env["ODFT_CITY_GUIDE_AGENT_MCP_REGISTRY_PATH"] ?? null,
    selfTokenRef: env["ODFT_CITY_GUIDE_AGENT_TOKEN_REF"] ?? "ODFT_AGENT_TOKEN_CITY_GUIDE",
    stepDelayMs: envNumber(env, "ODFT_CITY_GUIDE_AGENT_STEP_DELAY_MS", 0),
  });
  if (!parsed.databaseUrl) {
    throw new Error("DATABASE_URL is required for the city-guide-agent");
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
    stepDelayMs: parsed.stepDelayMs,
    inbound,
    protocol: {
      selfAgentIdentity: CITY_GUIDE_AGENT_IDENTITY,
      registry: inbound,
      mcpRegistry,
      timeouts: DEFAULT_PROTOCOL_TIMEOUTS,
      resolveCredential: (ref) => env[ref],
    },
  };
}
