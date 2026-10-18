import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { insertAgentDelegation } from "@odft/persistence";
import { DEFAULT_PROTOCOL_TIMEOUTS, trustedRegistrySchema, type ProtocolConfig } from "@odft/protocols";
import {
  ACCOMMODATION_AGENT_PASSWORD,
  CITY_GUIDE_AGENT_PASSWORD,
  REPO_ROOT,
} from "../../fixtures/protocols/roles.js";
import { AGENT_TOKENS, MCP_TEST_PORTS, stopMcpHost, type SeededSnapshot } from "../mcp/_setup.js";

/**
 * Phase 06 A2A setup: the Accommodation and City Guide agents over real HTTP
 * with the Phase 04 MCP host, the restricted agent roles and delegated frozen
 * snapshots. Distinct ports keep every agent independently executable.
 */

const TSX = `${REPO_ROOT}/node_modules/.bin/tsx`;

export const ACCOMMODATION_AGENT_PORT = 4432;
export const ACCOMMODATION_ALT_AGENT_PORT = 4434;
export const CITY_GUIDE_AGENT_PORT = 4433;
export const ACCOMMODATION_AGENT_TOKEN = AGENT_TOKENS.accommodation;
export const ACCOMMODATION_ALT_AGENT_TOKEN = AGENT_TOKENS.accommodationAlt;
export const CITY_GUIDE_AGENT_TOKEN = AGENT_TOKENS.cityGuide;

export { stopMcpHost };

export function accommodationAgentDatabaseUrl(): string {
  const base = new URL(process.env.TEST_DATABASE_URL as string);
  return `postgres://odft_accommodation_agent:${ACCOMMODATION_AGENT_PASSWORD}@${base.hostname}:${base.port}${base.pathname}`;
}

export function cityGuideAgentDatabaseUrl(): string {
  const base = new URL(process.env.TEST_DATABASE_URL as string);
  return `postgres://odft_city_guide_agent:${CITY_GUIDE_AGENT_PASSWORD}@${base.hostname}:${base.port}${base.pathname}`;
}

function startAgent(
  entry: string,
  port: number,
  databaseUrl: string,
  mcpRegistry: string,
  tokenEnv: string,
  token: string,
  env: Record<string, string>,
): ChildProcess {
  const prefix = entry.includes("accommodation") ? "ODFT_ACCOMMODATION_AGENT" : "ODFT_CITY_GUIDE_AGENT";
  return spawn(TSX, [`apps/${entry}/src/main.ts`], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      [`${prefix}_PORT`]: String(port),
      [`${prefix}_REGISTRY_PATH`]: `${REPO_ROOT}/tests/fixtures/protocols/mcp-host-registry.json`,
      [`${prefix}_MCP_REGISTRY_PATH`]: `${REPO_ROOT}/tests/fixtures/protocols/${mcpRegistry}`,
      [tokenEnv]: token,
      AI_MODE: "fixture",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
}

export function startAccommodationAgent(env: Record<string, string> = {}): ChildProcess {
  return startAgent(
    "accommodation-agent",
    ACCOMMODATION_AGENT_PORT,
    accommodationAgentDatabaseUrl(),
    "mcp-services-registry-accommodation.json",
    "ODFT_AGENT_TOKEN_ACCOMMODATION",
    ACCOMMODATION_AGENT_TOKEN,
    env,
  );
}

export function startAccommodationAltAgent(env: Record<string, string> = {}): ChildProcess {
  const prefix = "ODFT_ACCOMMODATION_ALT_AGENT";
  return spawn(TSX, ["apps/accommodation-agent-alt/src/main.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: accommodationAgentDatabaseUrl(),
      [`${prefix}_PORT`]: String(ACCOMMODATION_ALT_AGENT_PORT),
      [`${prefix}_REGISTRY_PATH`]: `${REPO_ROOT}/tests/fixtures/protocols/mcp-host-registry.json`,
      [`${prefix}_MCP_REGISTRY_PATH`]: `${REPO_ROOT}/tests/fixtures/protocols/mcp-services-registry-accommodation-alt.json`,
      ODFT_AGENT_TOKEN_ACCOMMODATION_ALT: ACCOMMODATION_ALT_AGENT_TOKEN,
      AI_MODE: "fixture",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
}

export function startCityGuideAgent(env: Record<string, string> = {}): ChildProcess {
  return startAgent(
    "city-guide-agent",
    CITY_GUIDE_AGENT_PORT,
    cityGuideAgentDatabaseUrl(),
    "mcp-services-registry-city-guide.json",
    "ODFT_AGENT_TOKEN_CITY_GUIDE",
    CITY_GUIDE_AGENT_TOKEN,
    env,
  );
}

export function waitForAgentReady(child: ChildProcess, name: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`${name} not ready: ${buffer}`)), timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      if (buffer.includes(`${name} ready`)) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        resolve(buffer);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${name} exited with ${code}: ${buffer}`));
    });
  });
}

export const stopAgent = stopMcpHost;

function clientConfig(
  identity: string,
  port: number,
  skillId: string,
  token: string,
): ProtocolConfig {
  const endpointUrl = `http://127.0.0.1:${port}`;
  return {
    selfAgentIdentity: "coordinator",
    registry: trustedRegistrySchema.parse({
      schemaVersion: 1,
      agents: [
        {
          agentIdentity: identity,
          endpointUrl,
          cardUrl: `${endpointUrl}/.well-known/agent-card.json`,
          credentialRef: "TEST_TOKEN",
          requiredSkills: [skillId],
        },
      ],
    }),
    mcpRegistry: {
      schemaVersion: 1,
      services: [
        {
          serviceName: "odft-travel-data",
          endpointUrl: `http://127.0.0.1:${MCP_TEST_PORTS.travelData}/travel-data/mcp`,
          credentialRef: "TEST_TOKEN",
        },
      ],
    },
    timeouts: DEFAULT_PROTOCOL_TIMEOUTS,
    resolveCredential: (ref) => (ref === "TEST_TOKEN" ? token : undefined),
  };
}

export function accommodationAgentClientConfig(): ProtocolConfig {
  return clientConfig(
    "accommodation-agent",
    ACCOMMODATION_AGENT_PORT,
    "accommodation.recommend.v1",
    ACCOMMODATION_AGENT_TOKEN,
  );
}

export function accommodationAltAgentClientConfig(): ProtocolConfig {
  return clientConfig(
    "accommodation-agent-alt",
    ACCOMMODATION_ALT_AGENT_PORT,
    "accommodation.recommend.v1",
    ACCOMMODATION_ALT_AGENT_TOKEN,
  );
}

export function cityGuideAgentClientConfig(): ProtocolConfig {
  return clientConfig("city-guide-agent", CITY_GUIDE_AGENT_PORT, "city-guide.research.v1", CITY_GUIDE_AGENT_TOKEN);
}

/** Insert an accommodation delegation (hotel domain, explicit objective/level). */
export async function createAccommodationDelegation(
  pool: Pool,
  seeded: SeededSnapshot,
  options: {
    readonly objective?: "preserve_level" | "cheaper" | null;
    readonly levelOverride?: string | null;
    readonly domains?: string[];
    readonly agentIdentity?: string;
    readonly endpointUrl?: string;
  } = {},
): Promise<string> {
  const created = await insertAgentDelegation(pool, {
    tripId: seeded.tripId,
    originatingOperationId: seeded.operationId,
    acceptedRevision: 1,
    skillId: "accommodation.recommend.v1",
    agentIdentity: options.agentIdentity ?? "accommodation-agent",
    endpointUrl: options.endpointUrl ?? `http://127.0.0.1:${ACCOMMODATION_AGENT_PORT}`,
    snapshotId: seeded.snapshotId,
    inputFingerprint: "e".repeat(64),
    scope: {
      domains: (options.domains ?? ["hotel"]) as never,
      snapshotId: seeded.snapshotId,
      allowRouteValidation: false,
      allowItinerary: false,
      objective: options.objective ?? null,
      levelOverride: (options.levelOverride ?? null) as never,
    },
  });
  return created.id;
}

/** Insert a city-guide delegation over the requested research domains. */
export async function createCityGuideDelegation(
  pool: Pool,
  seeded: SeededSnapshot,
  options: { readonly domains?: string[] } = {},
): Promise<string> {
  const created = await insertAgentDelegation(pool, {
    tripId: seeded.tripId,
    originatingOperationId: seeded.operationId,
    acceptedRevision: 1,
    skillId: "city-guide.research.v1",
    agentIdentity: "city-guide-agent",
    endpointUrl: `http://127.0.0.1:${CITY_GUIDE_AGENT_PORT}`,
    snapshotId: seeded.snapshotId,
    inputFingerprint: "e".repeat(64),
    scope: {
      domains: (options.domains ?? ["breakfast", "lunch", "dinner", "attractions", "events"]) as never,
      snapshotId: seeded.snapshotId,
      allowRouteValidation: false,
      allowItinerary: false,
    },
  });
  return created.id;
}

export interface AgentTaskDataInput {
  readonly skillId: string;
  readonly tripId: string;
  readonly operationId: string;
  readonly delegationId: string;
  readonly snapshotId: string;
  readonly scenarioKey: string;
  readonly requestedDomains: readonly string[];
  readonly searchObjective?: "preserve_level" | "cheaper";
  readonly effectiveLevel?: string;
  readonly queryContext?: Record<string, unknown>;
  readonly continuation?: {
    readonly inputGeneration: number;
    readonly answerRequestId: string;
    readonly selectedOptionId: string;
  } | null;
}

export function agentTaskRequestData(input: AgentTaskDataInput): unknown {
  return {
    schemaVersion: 1,
    skillId: input.skillId,
    tripId: input.tripId,
    operationId: input.operationId,
    acceptedRevision: 1,
    delegationId: input.delegationId,
    traceId: `trace-${randomUUID().slice(0, 8)}`,
    snapshot: {
      snapshotId: input.snapshotId,
      scenarioKey: input.scenarioKey,
      routeApprovalFingerprint: "a".repeat(64),
      scheduleApprovalFingerprint: "b".repeat(64),
      domainFingerprints: { hotel: "c".repeat(64) },
    },
    inputFingerprint: "d".repeat(64),
    requestedDomains: input.requestedDomains,
    travelVariant: "two_nights",
    adults: 1,
    sightseeingDate: "2026-12-01",
    effectiveLevel: input.effectiveLevel ?? "standard",
    selectedOfferIds: [],
    confirmedOfferIds: [],
    preservationConstraints: [],
    searchObjective: input.searchObjective ?? "preserve_level",
    queryContext: input.queryContext ?? {},
    deadlineAt: new Date(Date.now() + 600_000).toISOString(),
    limits: { activeTimeMs: 90_000, mcpInvocations: 8, llmTransportAttempts: 2, maxTaskCostUsd: 0.1 },
    preferences: {
      travelVariant: "two_nights",
      defaultServiceLevel: input.effectiveLevel ?? "standard",
      serviceOverrides: {},
      activityPace: "moderate",
      interests: { culture: 3, relaxation: 2, entertainment: 1 },
      preferredActivityTags: [],
      minimumActivityCounts: {},
    },
    continuation: input.continuation ?? null,
  };
}

export function dataMessage(data: unknown, taskId = "", contextId = "") {
  return {
    messageId: randomUUID(),
    contextId,
    taskId,
    role: 1, // Role.ROLE_USER
    parts: [
      {
        content: { $case: "data" as const, value: data },
        mediaType: "application/json",
        filename: "",
        metadata: {},
      },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}
