import { readFileSync } from "node:fs";
import { z } from "zod";
import { agentSkillIdSchema } from "@odft/contracts";

/**
 * Phase 03 protocol configuration (plan §3.2, §3.15).
 *
 * Everything is loaded from the environment / a trusted registry file. No
 * credentials, login secrets or provider keys live in source: entries carry a
 * `credentialRef` naming the environment variable that holds the bearer token,
 * and tokens are only ever read at runtime.
 */

export const DEFAULT_CARD_TIMEOUT_MS = 3_000;
export const DEFAULT_CALL_TIMEOUT_MS = 5_000;
export const DEFAULT_CAPABILITY_CACHE_TTL_MS = 300_000;
export const DEFAULT_MCP_TIMEOUT_MS = 5_000;
export const DEFAULT_MCP_READ_RETRIES = 1;

/** One trusted remote agent (exact origin, pinned card URL, required skills). */
export const trustedAgentEntrySchema = z
  .object({
    agentIdentity: z.string().min(1).max(120),
    /** Exact endpoint origin; card and JSON-RPC must share it. */
    endpointUrl: z.string().url(),
    /** Pinned card URL (may be the well-known path); no free discovery. */
    cardUrl: z.string().url(),
    /** Environment variable holding the bearer token for this agent. */
    credentialRef: z.string().min(1).max(120),
    requiredSkills: z.array(agentSkillIdSchema).min(1),
  })
  .strict();
export type TrustedAgentEntry = z.infer<typeof trustedAgentEntrySchema>;

/**
 * The coordinator is a first-class service identity, not an agent: it has its
 * own bearer credential and is accepted by every agent in addition to the
 * agent's own identity (plan §3.15).
 */
export const trustedCoordinatorEntrySchema = z
  .object({
    agentIdentity: z.string().min(1).max(120),
    credentialRef: z.string().min(1).max(120),
  })
  .strict();
export type TrustedCoordinatorEntry = z.infer<typeof trustedCoordinatorEntrySchema>;

export const trustedRegistrySchema = z
  .object({
    schemaVersion: z.literal(1),
    agents: z.array(trustedAgentEntrySchema).min(1),
    coordinator: trustedCoordinatorEntrySchema.optional(),
  })
  .strict();
export type TrustedRegistry = z.infer<typeof trustedRegistrySchema>;

/** One trusted MCP service endpoint (read-only by default; see plan §3.13). */
export const mcpServiceEntrySchema = z
  .object({
    serviceName: z.string().min(1).max(120),
    endpointUrl: z.string().url(),
    credentialRef: z.string().min(1).max(120),
  })
  .strict();
export type McpServiceEntry = z.infer<typeof mcpServiceEntrySchema>;

export const mcpRegistrySchema = z
  .object({
    schemaVersion: z.literal(1),
    services: z.array(mcpServiceEntrySchema).min(1),
  })
  .strict();
export type McpRegistry = z.infer<typeof mcpRegistrySchema>;

export interface ProtocolTimeouts {
  readonly cardTimeoutMs: number;
  readonly callTimeoutMs: number;
  readonly capabilityCacheTtlMs: number;
  readonly mcpTimeoutMs: number;
  readonly mcpReadRetries: number;
}

export const DEFAULT_PROTOCOL_TIMEOUTS: ProtocolTimeouts = {
  cardTimeoutMs: DEFAULT_CARD_TIMEOUT_MS,
  callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
  capabilityCacheTtlMs: DEFAULT_CAPABILITY_CACHE_TTL_MS,
  mcpTimeoutMs: DEFAULT_MCP_TIMEOUT_MS,
  mcpReadRetries: DEFAULT_MCP_READ_RETRIES,
};

export interface ProtocolConfig {
  /** This service's own agent identity (used for inbound admission scoping). */
  readonly selfAgentIdentity: string;
  readonly registry: TrustedRegistry;
  readonly mcpRegistry: McpRegistry;
  readonly timeouts: ProtocolTimeouts;
  /** Read a bearer token by its credential reference (env lookup). */
  readonly resolveCredential: (credentialRef: string) => string | undefined;
}

/** Load and validate a trusted registry JSON file. */
export function loadTrustedRegistry(path: string): TrustedRegistry {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return trustedRegistrySchema.parse(raw);
}

export function loadMcpRegistry(path: string): McpRegistry {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return mcpRegistrySchema.parse(raw);
}

export function loadProtocolConfig(input: {
  readonly selfAgentIdentity: string;
  readonly registryPath: string;
  readonly mcpRegistryPath: string;
  readonly env?: Record<string, string | undefined>;
  readonly timeouts?: Partial<ProtocolTimeouts>;
}): ProtocolConfig {
  const env = input.env ?? process.env;
  return {
    selfAgentIdentity: input.selfAgentIdentity,
    registry: loadTrustedRegistry(input.registryPath),
    mcpRegistry: loadMcpRegistry(input.mcpRegistryPath),
    timeouts: { ...DEFAULT_PROTOCOL_TIMEOUTS, ...input.timeouts },
    resolveCredential: (credentialRef) => env[credentialRef],
  };
}

/** The single trusted entry for an agent identity, or undefined. */
export function trustedEntryFor(
  registry: TrustedRegistry,
  agentIdentity: string,
): TrustedAgentEntry | undefined {
  return registry.agents.find((agent) => agent.agentIdentity === agentIdentity);
}

/**
 * Inbound registries are least-privilege: an agent process only needs its own
 * entry (for self-identification) plus the optional coordinator identity. It
 * must never resolve every peer's credential reference.
 */
export function scopeInboundRegistry(
  registry: TrustedRegistry,
  selfAgentIdentity: string,
  selfTokenRef: string,
): TrustedRegistry {
  const self = trustedEntryFor(registry, selfAgentIdentity);
  if (!self) {
    throw new Error(`the trusted registry has no entry for ${selfAgentIdentity}`);
  }
  if (self.credentialRef !== selfTokenRef) {
    throw new Error(
      `the trusted registry entry for ${selfAgentIdentity} must use credentialRef ${selfTokenRef}`,
    );
  }
  return { ...registry, agents: [self] };
}

/** Exact-origin check: card and endpoint URLs must share the trusted origin. */
export function exactOriginOf(url: string): string {
  return new URL(url).origin;
}
