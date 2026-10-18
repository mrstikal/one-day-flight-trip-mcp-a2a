import { spawn, type ChildProcess } from "node:child_process";
import type { Pool } from "pg";
import {
  claimNextOperation,
  completeOperation,
  getTrip,
  insertAgentDelegation,
} from "@odft/persistence";
import { createTravelScenarioService } from "@odft/services";
import { DEFAULT_PROTOCOL_TIMEOUTS, type ProtocolConfig } from "@odft/protocols";
import {
  FLIGHT_AGENT_PASSWORD,
  PROTOCOL_PASSWORD,
  READONLY_PASSWORD,
  REPO_ROOT,
  runProtocolRoleSetup,
} from "../../fixtures/protocols/roles.js";
import {
  createFixtureTrip,
  createTestPool,
  createWorkerPools,
  resetDatabase,
  type WorkerPools,
} from "../_setup.js";

/**
 * Phase 04 MCP integration setup: real PostgreSQL with the read-only role,
 * a frozen snapshot seeded by the real worker harness, delegations for the
 * three agent identities, and the spawned MCP host on test ports.
 */

const TSX = `${REPO_ROOT}/node_modules/.bin/tsx`;

export const MCP_TEST_PORTS = { geography: 4421, travelData: 4422, itineraryTools: 4423 } as const;
export const AGENT_TOKENS = {
  flight: "test-token-flight-agent-0123456789",
  accommodation: "test-token-accommodation-0123456789",
  accommodationAlt: "test-token-accommodation-alt-0123456789",
  cityGuide: "test-token-city-guide-0123456789",
  coordinator: "test-token-coordinator-0123456789",
} as const;
export { FLIGHT_AGENT_PASSWORD, PROTOCOL_PASSWORD, READONLY_PASSWORD, REPO_ROOT };

export interface SeededSnapshot {
  readonly tripId: string;
  readonly sessionId: string;
  readonly snapshotId: string;
  readonly operationId: string;
  readonly routeApprovalId: string;
}

export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL is required for MCP integration tests");
  }
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to run against non-test database "${name}"`);
  }
  return url;
}

export function createMcpTestPool(max = 8): Pool {
  return createTestPool(max);
}

export function createMcpTestWorkerPools(max = 8): WorkerPools {
  return createWorkerPools(max);
}

export async function resetMcpDatabase(pool: Pool): Promise<void> {
  await resetDatabase(pool);
}

/** Seed one frozen snapshot via the real worker harness and create delegations. */
export async function seedDelegatedSnapshot(
  pool: Pool,
  pools: WorkerPools,
): Promise<SeededSnapshot> {
  const { tripId, sessionId } = await createFixtureTrip(pool);
  const claim = await claimNextOperation(pools.operations, {
    workerId: "mcp-seed",
    leaseMs: 30_000,
    engines: ["coordinator-v1"],
  });
  if (!claim) {
    throw new Error("fixture trip has no claimable creation operation");
  }
  const scenario = createTravelScenarioService({
    pool,
    authority: {
      kind: "operation",
      tripId,
      operationId: claim.operationId,
      fencingToken: claim.fencingToken,
    },
  });
  await scenario.evaluateRoute(tripId);
  const materialized = await scenario.materializeFlights(tripId);
  if (!materialized) {
    throw new Error("fixture trip has no materialized flight snapshot");
  }
  await scenario.validateSchedules({ tripId, snapshotId: materialized.snapshotId });
  // MCP/A2A evidence needs the hotel, meal, attraction and event domains of the
  // SAME frozen snapshot, exactly like the coordinator's research step extends
  // it before delegating. Extending changes the active snapshot, so Stage B is
  // revalidated on the extended version (the original setup ran the graph
  // research fan-out, which did this implicitly).
  const ensured = await scenario.ensureDomains(tripId);
  await scenario.validateSchedules({ tripId, snapshotId: ensured.snapshotId });
  const trip = await getTrip(pool, tripId);
  const snapshotId = trip?.activeScenarioSnapshotId;
  if (!snapshotId) {
    throw new Error("fixture trip has no frozen snapshot");
  }
  const route = await pool.query<{ id: string }>(
    `SELECT current_route_validation_id AS id FROM odft_app.trips WHERE id = $1`,
    [tripId],
  );
  const operationId = claim.operationId;
  await completeOperation(pools.operations, {
    operationId,
    fencingToken: claim.fencingToken,
    status: "waiting",
    result: { seeded: true },
  });

  const delegation = async (
    agentIdentity: string,
    domains: string[],
    flags: { allowRouteValidation?: boolean; allowItinerary?: boolean } = {},
  ): Promise<string> => {
    const created = await insertAgentDelegation(pool, {
      tripId,
      originatingOperationId: operationId,
      acceptedRevision: 1,
      skillId:
        domains[0] === "flights"
          ? "flight.recommend.v1"
          : domains[0] === "hotel"
            ? "accommodation.recommend.v1"
            : "city-guide.research.v1",
      agentIdentity,
      endpointUrl: "http://127.0.0.1:9999",
      snapshotId,
      inputFingerprint: "a".repeat(64),
      scope: {
        domains,
        snapshotId,
        allowRouteValidation: flags.allowRouteValidation ?? false,
        allowItinerary: flags.allowItinerary ?? false,
      },
    });
    return created.id;
  };

  const flightDelegation = await delegation("flight-agent", ["flights"], {
    allowRouteValidation: true,
  });
  await delegation("accommodation-agent", ["hotel"]);
  const cityGuideDelegation = await delegation(
    "city-guide-agent",
    ["breakfast", "lunch", "dinner", "attractions", "events"],
    { allowItinerary: true },
  );
  void flightDelegation;
  void cityGuideDelegation;

  return {
    tripId,
    sessionId,
    snapshotId,
    operationId,
    routeApprovalId: route.rows[0]?.id ?? "",
  };
}

/** The delegation id of one identity in the seeded snapshot. */
export async function delegationOf(
  pool: Pool,
  input: { tripId: string; agentIdentity: string },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM odft_app.agent_delegations
      WHERE trip_id = $1 AND agent_identity = $2 ORDER BY created_at DESC LIMIT 1`,
    [input.tripId, input.agentIdentity],
  );
  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error(`no delegation for ${input.agentIdentity}`);
  }
  return id;
}

export function readOnlyDatabaseUrl(): string {
  const base = new URL(requireTestDatabaseUrl());
  return `postgres://odft_mcp_readonly:${READONLY_PASSWORD}@${base.hostname}:${base.port}${base.pathname}`;
}

/** Run the documented role setup (ALL protocol roles) against the test database. */
export function setupProtocolRoles(): void {
  runProtocolRoleSetup(requireTestDatabaseUrl());
}

export function startMcpHost(env: Record<string, string> = {}): ChildProcess {
  return spawn(TSX, ["apps/mcp-server/src/main.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: requireTestDatabaseUrl(),
      ODFT_MCP_READONLY_DATABASE_URL: readOnlyDatabaseUrl(),
      ODFT_MCP_AGENT_REGISTRY_PATH: `${REPO_ROOT}/tests/fixtures/protocols/mcp-host-registry.json`,
      ODFT_MCP_HOST: "127.0.0.1",
      ODFT_MCP_GEOGRAPHY_PORT: String(MCP_TEST_PORTS.geography),
      ODFT_MCP_TRAVEL_DATA_PORT: String(MCP_TEST_PORTS.travelData),
      ODFT_MCP_ITINERARY_TOOLS_PORT: String(MCP_TEST_PORTS.itineraryTools),
      ODFT_AGENT_TOKEN_FLIGHT: AGENT_TOKENS.flight,
      ODFT_AGENT_TOKEN_ACCOMMODATION: AGENT_TOKENS.accommodation,
      ODFT_AGENT_TOKEN_ACCOMMODATION_ALT: AGENT_TOKENS.accommodationAlt,
      ODFT_AGENT_TOKEN_CITY_GUIDE: AGENT_TOKENS.cityGuide,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
}

export function waitForHostReady(child: ChildProcess, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      reject(new Error(`MCP host did not become ready: ${buffer}`));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const readyLines = buffer.split("\n").filter((line) => line.includes("mcp-host ready"));
      if (readyLines.length >= 3) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        resolve(buffer);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`MCP host exited with ${code}: ${buffer}`));
    });
  });
}

export async function stopMcpHost(child: ChildProcess | undefined): Promise<void> {
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

/** MCP client config for one authenticated agent identity (test tokens). */
export function mcpConfigFor(
  identity: "flight-agent" | "accommodation-agent" | "city-guide-agent",
): ProtocolConfig {
  const token =
    identity === "flight-agent"
      ? AGENT_TOKENS.flight
      : identity === "accommodation-agent"
        ? AGENT_TOKENS.accommodation
        : AGENT_TOKENS.cityGuide;
  return {
    selfAgentIdentity: identity,
    registry: {
      schemaVersion: 1,
      agents: [
        {
          agentIdentity: identity,
          endpointUrl: `http://127.0.0.1:${MCP_TEST_PORTS.geography}`,
          cardUrl: `http://127.0.0.1:${MCP_TEST_PORTS.geography}/geography/mcp`,
          credentialRef: "TEST_TOKEN",
          requiredSkills: ["flight.recommend.v1"],
        },
      ],
    },
    mcpRegistry: {
      schemaVersion: 1,
      services: [
        {
          serviceName: "odft-geography",
          endpointUrl: `http://127.0.0.1:${MCP_TEST_PORTS.geography}/geography/mcp`,
          credentialRef: "TEST_TOKEN",
        },
        {
          serviceName: "odft-travel-data",
          endpointUrl: `http://127.0.0.1:${MCP_TEST_PORTS.travelData}/travel-data/mcp`,
          credentialRef: "TEST_TOKEN",
        },
        {
          serviceName: "odft-itinerary-tools",
          endpointUrl: `http://127.0.0.1:${MCP_TEST_PORTS.itineraryTools}/itinerary-tools/mcp`,
          credentialRef: "TEST_TOKEN",
        },
      ],
    },
    timeouts: DEFAULT_PROTOCOL_TIMEOUTS,
    resolveCredential: (ref) => (ref === "TEST_TOKEN" ? token : undefined),
  };
}

export { DEFAULT_PROTOCOL_TIMEOUTS };
