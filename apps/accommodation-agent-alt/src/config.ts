import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  DEFAULT_PROTOCOL_TIMEOUTS,
  trustedRegistrySchema,
  type ProtocolConfig,
  type TrustedRegistry,
} from "@odft/protocols";

/**
 * Phase 10 alternative Accommodation Agent configuration (plan §3.17).
 *
 * A separate application with its own identity, task table and strategy. It
 * shares the public contracts, official SDK plumbing and governed AI
 * infrastructure, but never imports the primary executor. The database role is
 * the same least-privilege accommodation role (the agent still cannot write
 * trip/scenario/reservation rows); the task table is its own.
 */

export const ACCOMMODATION_ALT_AGENT_IDENTITY = "accommodation-agent-alt";
export const ACCOMMODATION_ALT_SKILL_ID = "accommodation.recommend.v1";

const envSchema = z
  .object({
    port: z.number().int().min(1).max(65535).default(4404),
    host: z.string().min(1).default("127.0.0.1"),
    databaseUrl: z.string().min(1),
    registryPath: z.string().min(1),
    mcpRegistryPath: z.string().min(1).nullable().default(null),
    selfTokenRef: z.string().min(1).default("ODFT_AGENT_TOKEN_ACCOMMODATION_ALT"),
    aiMode: z.enum(["fixture", "openrouter"]).default("fixture"),
    aiConfigPath: z.string().min(1).nullable().default(null),
    stepDelayMs: z.number().int().min(0).max(60000).default(0),
    crashBeforeWork: z.boolean().default(false),
  })
  .strict();

export interface AccommodationAltAgentConfig {
  readonly host: string;
  readonly port: number;
  /** Restricted accommodation role connection (never the owner role). */
  readonly databaseUrl: string;
  readonly registryPath: string;
  readonly mcpRegistryPath: string | null;
  readonly aiMode: "fixture" | "openrouter";
  /** Optional distinct model/profile file for this implementation. */
  readonly aiConfigPath: string | null;
  /** Test-only delay between work steps (parallel-window observation). */
  readonly stepDelayMs: number;
  /** Test-only crash hook AFTER durable admission, before any work. */
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

export function loadAccommodationAltAgentConfig(
  env: Record<string, string | undefined> = process.env,
): AccommodationAltAgentConfig {
  const parsed = envSchema.parse({
    port: envNumber(env, "ODFT_ACCOMMODATION_ALT_AGENT_PORT", 4404),
    host: env["ODFT_ACCOMMODATION_ALT_AGENT_HOST"] ?? "127.0.0.1",
    databaseUrl: env.DATABASE_URL ?? "",
    registryPath: env["ODFT_ACCOMMODATION_ALT_AGENT_REGISTRY_PATH"] ?? "",
    mcpRegistryPath: env["ODFT_ACCOMMODATION_ALT_AGENT_MCP_REGISTRY_PATH"] ?? null,
    selfTokenRef:
      env["ODFT_ACCOMMODATION_ALT_AGENT_TOKEN_REF"] ?? "ODFT_AGENT_TOKEN_ACCOMMODATION_ALT",
    aiMode: env.AI_MODE === "openrouter" ? "openrouter" : "fixture",
    aiConfigPath: env.ODFT_ACCOMMODATION_ALT_AI_CONFIG_PATH ?? env.AI_CONFIG_PATH ?? null,
    stepDelayMs: envNumber(env, "ODFT_ACCOMMODATION_ALT_AGENT_STEP_DELAY_MS", 0),
    crashBeforeWork: env.ODFT_ACCOMMODATION_ALT_AGENT_CRASH === "1",
  });
  if (!parsed.databaseUrl) {
    throw new Error("DATABASE_URL is required for the accommodation-agent-alt");
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
    stepDelayMs: parsed.stepDelayMs,
    crashBeforeWork: parsed.crashBeforeWork,
    inbound,
    protocol: {
      selfAgentIdentity: ACCOMMODATION_ALT_AGENT_IDENTITY,
      registry: inbound,
      mcpRegistry,
      timeouts: DEFAULT_PROTOCOL_TIMEOUTS,
      resolveCredential: (ref) => env[ref],
    },
  };
}
