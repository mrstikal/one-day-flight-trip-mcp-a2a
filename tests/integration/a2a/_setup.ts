import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { insertAgentDelegation } from "@odft/persistence";
import {
  DEFAULT_PROTOCOL_TIMEOUTS,
  trustedRegistrySchema,
  type ProtocolConfig,
} from "@odft/protocols";
import {
  FLIGHT_AGENT_PASSWORD,
  PROTOCOL_PASSWORD,
  READONLY_PASSWORD,
  REPO_ROOT,
  runProtocolRoleSetup,
} from "../../fixtures/protocols/roles.js";
import { endWorkerPools, type WorkerPools } from "../_setup.js";
import {
  MCP_TEST_PORTS,
  AGENT_TOKENS,
  createMcpTestPool,
  createMcpTestWorkerPools,
  readOnlyDatabaseUrl,
  resetMcpDatabase,
  seedDelegatedSnapshot,
  startMcpHost,
  stopMcpHost,
  waitForHostReady,
  type SeededSnapshot,
} from "../mcp/_setup.js";

/**
 * Phase 05 A2A setup: the Phase 04 MCP host, the Flight Agent process and a
 * delegated frozen snapshot, all over real HTTP with real PostgreSQL.
 */

const TSX = `${REPO_ROOT}/node_modules/.bin/tsx`;

export const FLIGHT_AGENT_PORT = 4431;
export const FLIGHT_AGENT_TOKEN = AGENT_TOKENS.flight;

export {
  AGENT_TOKENS,
  FLIGHT_AGENT_PASSWORD,
  MCP_TEST_PORTS,
  PROTOCOL_PASSWORD,
  READONLY_PASSWORD,
  REPO_ROOT,
  createMcpTestPool,
  createMcpTestWorkerPools,
  endWorkerPools,
  readOnlyDatabaseUrl,
  resetMcpDatabase,
  seedDelegatedSnapshot,
  startMcpHost,
  stopMcpHost,
  waitForHostReady,
  type SeededSnapshot,
  type WorkerPools,
};

export function flightAgentDatabaseUrl(): string {
  const base = new URL(process.env.TEST_DATABASE_URL as string);
  return `postgres://odft_flight_agent:${FLIGHT_AGENT_PASSWORD}@${base.hostname}:${base.port}${base.pathname}`;
}

/** Run the documented role setup (protocol + read-only + flight agent roles). */
export function setupProtocolRoles(): void {
  runProtocolRoleSetup(process.env.TEST_DATABASE_URL as string);
}

export function startFlightAgent(env: Record<string, string> = {}): ChildProcess {
  return spawn(TSX, ["apps/flight-agent/src/main.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: flightAgentDatabaseUrl(),
      ODFT_FLIGHT_AGENT_PORT: String(FLIGHT_AGENT_PORT),
      ODFT_FLIGHT_AGENT_REGISTRY_PATH: `${REPO_ROOT}/tests/fixtures/protocols/mcp-host-registry.json`,
      ODFT_MCP_REGISTRY_PATH: `${REPO_ROOT}/tests/fixtures/protocols/mcp-services-registry.json`,
      ODFT_AGENT_TOKEN_FLIGHT: FLIGHT_AGENT_TOKEN,
      ODFT_COORDINATOR_TOKEN: AGENT_TOKENS.coordinator,
      AI_MODE: "fixture",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
}

export function waitForFlightAgent(child: ChildProcess, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error(`flight agent not ready: ${buffer}`)),
      timeoutMs,
    );
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("flight-agent ready")) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        resolve(buffer);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`flight agent exited with ${code}: ${buffer}`));
    });
  });
}

export async function stopFlightAgent(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    try {
      if (child.pid) {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch {
      child.kill("SIGKILL");
    }
    setTimeout(resolve, 5_000);
  });
}

/** Coordinator-side client config for the Flight Agent (test tokens). */
export function flightAgentClientConfig(): ProtocolConfig {
  const endpointUrl = `http://127.0.0.1:${FLIGHT_AGENT_PORT}`;
  return {
    selfAgentIdentity: "coordinator",
    registry: trustedRegistrySchema.parse({
      schemaVersion: 1,
      agents: [
        {
          agentIdentity: "flight-agent",
          endpointUrl,
          cardUrl: `${endpointUrl}/.well-known/agent-card.json`,
          credentialRef: "TEST_TOKEN",
          requiredSkills: ["flight.recommend.v1"],
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
    resolveCredential: (ref) => (ref === "TEST_TOKEN" ? FLIGHT_AGENT_TOKEN : undefined),
  };
}

/** Insert a FRESH flight delegation for one canonical task (one task per delegation). */
export async function createFlightDelegation(pool: Pool, seeded: SeededSnapshot): Promise<string> {
  return createFlightDelegationFor(pool, {
    tripId: seeded.tripId,
    operationId: seeded.operationId,
    snapshotId: seeded.snapshotId,
  });
}

/** Insert a flight delegation for an explicit trip/operation/snapshot binding. */
export async function createFlightDelegationFor(
  pool: Pool,
  input: {
    tripId: string;
    operationId: string;
    snapshotId: string;
    inputFingerprint?: string;
  },
): Promise<string> {
  const created = await insertAgentDelegation(pool, {
    tripId: input.tripId,
    originatingOperationId: input.operationId,
    acceptedRevision: 1,
    skillId: "flight.recommend.v1",
    agentIdentity: "flight-agent",
    endpointUrl: "http://127.0.0.1:4431",
    snapshotId: input.snapshotId,
    inputFingerprint: input.inputFingerprint ?? "e".repeat(64),
    scope: {
      domains: ["flights"],
      snapshotId: input.snapshotId,
      allowRouteValidation: true,
      allowItinerary: false,
    },
  });
  return created.id;
}

/** Seed one frozen snapshot and resolve its flight delegation. */
export async function seedFlightDelegation(
  pool: Pool,
  pools: WorkerPools,
): Promise<SeededSnapshot & { delegationId: string }> {
  const seeded = await seedDelegatedSnapshot(pool, pools);
  const delegation = await pool.query<{ id: string }>(
    `SELECT id FROM odft_app.agent_delegations
      WHERE trip_id = $1 AND agent_identity = 'flight-agent'
      ORDER BY created_at DESC LIMIT 1`,
    [seeded.tripId],
  );
  const delegationId = delegation.rows[0]?.id;
  if (!delegationId) {
    throw new Error("flight delegation missing after seeding");
  }
  return { ...seeded, delegationId };
}

export interface FlightTaskMessageInput {
  readonly tripId: string;
  readonly operationId: string;
  readonly delegationId: string;
  readonly snapshotId: string;
  readonly scenarioKey: string;
  readonly acceptedRevision?: number;
  readonly inputFingerprint?: string;
}

export function flightTaskRequestData(input: FlightTaskMessageInput): unknown {
  return {
    schemaVersion: 1,
    skillId: "flight.recommend.v1",
    tripId: input.tripId,
    operationId: input.operationId,
    acceptedRevision: input.acceptedRevision ?? 1,
    delegationId: input.delegationId,
    traceId: `trace-${randomUUID().slice(0, 8)}`,
    snapshot: {
      snapshotId: input.snapshotId,
      scenarioKey: input.scenarioKey,
      routeApprovalFingerprint: "a".repeat(64),
      scheduleApprovalFingerprint: "b".repeat(64),
      domainFingerprints: { hotel: "c".repeat(64) },
    },
    inputFingerprint: input.inputFingerprint ?? "d".repeat(64),
    requestedDomains: ["hotel"],
    travelVariant: "one_night",
    adults: 1,
    sightseeingDate: "2026-12-01",
    effectiveLevel: "standard",
    selectedOfferIds: [],
    confirmedOfferIds: [],
    preservationConstraints: [],
    searchObjective: "preserve_level",
    queryContext: {},
    deadlineAt: new Date(Date.now() + 600_000).toISOString(),
    limits: {
      activeTimeMs: 60_000,
      mcpInvocations: 4,
      llmTransportAttempts: 2,
      maxTaskCostUsd: 0.1,
    },
    preferences: {
      travelVariant: "one_night",
      defaultServiceLevel: "standard",
      serviceOverrides: {},
      activityPace: "moderate",
      interests: { culture: 3, relaxation: 2, entertainment: 1 },
      preferredActivityTags: [],
      minimumActivityCounts: {},
    },
    continuation: null,
  };
}

export function flightDataMessage(data: unknown, taskId = "", contextId = "") {
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
