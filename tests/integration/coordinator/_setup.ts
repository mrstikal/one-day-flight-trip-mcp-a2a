import type { ChildProcess } from "node:child_process";
import type { Pool } from "pg";
import {
  claimNextOperation,
  createTrip,
  getActiveCoordinatorRun,
  type ClaimedOperation,
  type CoordinatorRunRecord,
} from "@odft/persistence";
import { runCoordinatorOperation, type TravelPorts } from "@odft/workflow";
import type { OperationDriver } from "../../../apps/worker/src/driver.js";
import { createA2ADelegationTransport } from "../../../apps/worker/src/coordinator-transport.js";
import { createTravelPortsFactory } from "../../../apps/worker/src/travel/ports.js";
import { createFixtureSession } from "../../fixtures/session.js";
import { fixtureCreationInput } from "../../fixtures/trip.js";
import { createTestAiService } from "../_setup.js";
import type { WorkerPools } from "../_setup.js";
import {
  createMcpTestPool,
  createMcpTestWorkerPools,
  resetMcpDatabase,
  setupProtocolRoles,
  startMcpHost,
  stopMcpHost,
  waitForHostReady,
} from "../mcp/_setup.js";
import {
  FLIGHT_AGENT_PORT,
  FLIGHT_AGENT_TOKEN,
  flightAgentClientConfig,
  startFlightAgent,
  stopFlightAgent,
  waitForFlightAgent,
} from "../a2a/_setup.js";
import {
  ACCOMMODATION_AGENT_PORT,
  ACCOMMODATION_AGENT_TOKEN,
  ACCOMMODATION_ALT_AGENT_PORT,
  ACCOMMODATION_ALT_AGENT_TOKEN,
  CITY_GUIDE_AGENT_PORT,
  CITY_GUIDE_AGENT_TOKEN,
  startAccommodationAgent,
  startAccommodationAltAgent,
  startCityGuideAgent,
  stopAgent,
  waitForAgentReady,
} from "../a2a/_setup-agents.js";

/**
 * Phase 07 coordinator test harness: real PostgreSQL, the real MCP host and the
 * real Flight Agent over HTTP, an in-process coordinator driver, and fixtures
 * for coordinator-engine trips.
 */

export interface CoordinatorHarness {
  readonly pool: Pool;
  readonly pools: WorkerPools;
  readonly mcpHost: ChildProcess;
  readonly flightAgent: ChildProcess;
  readonly accommodationAgent: ChildProcess;
  readonly accommodationAltAgent?: ChildProcess;
  readonly cityGuideAgent: ChildProcess;
}

export async function startCoordinatorHarness(
  options: { readonly accommodationAlt?: boolean } = {},
): Promise<CoordinatorHarness> {
  const pool = createMcpTestPool();
  const pools = createMcpTestWorkerPools();
  await resetMcpDatabase(pool);
  setupProtocolRoles();
  const mcpHost = startMcpHost();
  await waitForHostReady(mcpHost);
  const flightAgent = startFlightAgent();
  await waitForFlightAgent(flightAgent);
  const accommodationAgent = startAccommodationAgent();
  await waitForAgentReady(accommodationAgent, "accommodation-agent");
  const accommodationAltAgent = options.accommodationAlt ? startAccommodationAltAgent() : undefined;
  if (accommodationAltAgent) {
    await waitForAgentReady(accommodationAltAgent, "accommodation-agent-alt");
  }
  const cityGuideAgent = startCityGuideAgent();
  await waitForAgentReady(cityGuideAgent, "city-guide-agent");
  return {
    pool,
    pools,
    mcpHost,
    flightAgent,
    accommodationAgent,
    ...(accommodationAltAgent ? { accommodationAltAgent } : {}),
    cityGuideAgent,
  };
}

export async function stopCoordinatorHarness(harness: CoordinatorHarness): Promise<void> {
  if (harness.accommodationAltAgent) {
    await stopAgent(harness.accommodationAltAgent);
  }
  await stopAgent(harness.accommodationAgent);
  await stopAgent(harness.cityGuideAgent);
  await stopFlightAgent(harness.flightAgent);
  await stopMcpHost(harness.mcpHost);
  const { endWorkerPools } = await import("../_setup.js");
  await endWorkerPools(harness.pools);
  await harness.pool.end();
}

/** The in-process coordinator driver (same code path as the worker loop). */
/** The coordinator's client view of all three specialists (one registry). */
export function coordinatorClientConfigForTest(
  options: { readonly accommodationAlt?: boolean } = {},
) {
  const base = flightAgentClientConfig();
  const accommodation = options.accommodationAlt
    ? {
        agentIdentity: "accommodation-agent-alt",
        endpointUrl: `http://127.0.0.1:${ACCOMMODATION_ALT_AGENT_PORT}`,
        cardUrl: `http://127.0.0.1:${ACCOMMODATION_ALT_AGENT_PORT}/.well-known/agent-card.json`,
        credentialRef: "TEST_TOKEN_ACCOMMODATION_ALT",
        requiredSkills: ["accommodation.recommend.v1" as const],
      }
    : {
        agentIdentity: "accommodation-agent",
        endpointUrl: `http://127.0.0.1:${ACCOMMODATION_AGENT_PORT}`,
        cardUrl: `http://127.0.0.1:${ACCOMMODATION_AGENT_PORT}/.well-known/agent-card.json`,
        credentialRef: "TEST_TOKEN_ACCOMMODATION",
        requiredSkills: ["accommodation.recommend.v1" as const],
      };
  return {
    ...base,
    registry: {
      schemaVersion: 1 as const,
      agents: [
        ...base.registry.agents,
        accommodation,
        {
          agentIdentity: "city-guide-agent",
          endpointUrl: `http://127.0.0.1:${CITY_GUIDE_AGENT_PORT}`,
          cardUrl: `http://127.0.0.1:${CITY_GUIDE_AGENT_PORT}/.well-known/agent-card.json`,
          credentialRef: "TEST_TOKEN_CITY_GUIDE",
          requiredSkills: ["city-guide.research.v1" as const, "itinerary.propose.v1" as const],
        },
      ],
    },
    resolveCredential: (ref: string) => {
      if (ref === "TEST_TOKEN") {
        return FLIGHT_AGENT_TOKEN;
      }
      if (ref === "TEST_TOKEN_ACCOMMODATION") {
        return ACCOMMODATION_AGENT_TOKEN;
      }
      if (ref === "TEST_TOKEN_ACCOMMODATION_ALT") {
        return ACCOMMODATION_ALT_AGENT_TOKEN;
      }
      if (ref === "TEST_TOKEN_CITY_GUIDE") {
        return CITY_GUIDE_AGENT_TOKEN;
      }
      return undefined;
    },
  };
}

export function coordinatorDriver(
  pools: WorkerPools,
  options: {
    readonly hotelObjective?: "preserve_level" | "cheaper";
    readonly accommodationAlt?: boolean;
    readonly delegationWaitMs?: number;
    readonly ai?: ReturnType<typeof createTestAiService>;
  } = {},
): OperationDriver {
  const ai = options.ai ?? createTestAiService(pools);
  const portsFactory = createTravelPortsFactory(pools.operations, ai);
  const transport = createA2ADelegationTransport(
    coordinatorClientConfigForTest({ accommodationAlt: options.accommodationAlt }),
  );
  const accommodationBinding = options.accommodationAlt
    ? {
        agentIdentity: "accommodation-agent-alt",
        endpointUrl: `http://127.0.0.1:${ACCOMMODATION_ALT_AGENT_PORT}`,
        skillId: "accommodation.recommend.v1",
        cardVersion: "",
      }
    : {
        agentIdentity: "accommodation-agent",
        endpointUrl: `http://127.0.0.1:${ACCOMMODATION_AGENT_PORT}`,
        skillId: "accommodation.recommend.v1",
        cardVersion: "",
      };
  return {
    async runOperation(claim: ClaimedOperation) {
      const ctx = {
        operationId: claim.operationId,
        tripId: claim.tripId,
        fencingToken: claim.fencingToken,
      };
      await runCoordinatorOperation(
        {
          pool: pools.operations,
          transport,
          ports: portsFactory(ctx) as TravelPorts,
          agents: {
            flight: {
              agentIdentity: "flight-agent",
              endpointUrl: `http://127.0.0.1:${FLIGHT_AGENT_PORT}`,
              skillId: "flight.recommend.v1",
              cardVersion: "",
            },
            accommodation: accommodationBinding,
            cityGuide: {
              agentIdentity: "city-guide-agent",
              endpointUrl: `http://127.0.0.1:${CITY_GUIDE_AGENT_PORT}`,
              skillId: "city-guide.research.v1",
              cardVersion: "",
            },
            itinerary: {
              agentIdentity: "city-guide-agent",
              endpointUrl: `http://127.0.0.1:${CITY_GUIDE_AGENT_PORT}`,
              skillId: "itinerary.propose.v1",
              cardVersion: "",
            },
          },
          delegationWaitMs: options.delegationWaitMs ?? 30_000,
          ...(options.hotelObjective ? { hotelObjective: options.hotelObjective } : {}),
        },
        claim,
      );
    },
  };
}

export async function claimCoordinator(pools: WorkerPools): Promise<ClaimedOperation | null> {
  return claimNextOperation(pools.operations, {
    workerId: "coordinator-test",
    leaseMs: 30_000,
    engines: ["coordinator-v1"],
  });
}

/** Create a coordinator-engine fixture trip and return its ids. */
export async function createCoordinatorTrip(
  pool: Pool,
  overrides: Parameters<typeof fixtureCreationInput>[0] = {},
): Promise<{ tripId: string; operationId: string; sessionId: string }> {
  const sessionClient = await pool.connect();
  let sessionId: string;
  try {
    sessionId = await createFixtureSession(sessionClient);
  } finally {
    sessionClient.release();
  }
  const created = await createTrip(pool, {
    sessionId,
    input: fixtureCreationInput(overrides),
  });
  if (!("tripId" in created)) {
    throw new Error("fixture createTrip failed");
  }
  return { tripId: created.tripId, operationId: created.operationId, sessionId };
}

/** Run the coordinator driver until the run parks or the claim budget runs out. */
export async function driveUntilParked(
  pools: WorkerPools,
  tripId: string,
  maxRounds = 6,
  options: {
    readonly hotelObjective?: "preserve_level" | "cheaper";
    readonly accommodationAlt?: boolean;
    readonly delegationWaitMs?: number;
    readonly ai?: ReturnType<typeof createTestAiService>;
  } = {},
): Promise<CoordinatorRunRecord | undefined> {
  const driver = coordinatorDriver(pools, options);
  let claim = await claimCoordinator(pools);
  let rounds = 0;
  while (claim && rounds < maxRounds) {
    await driver.runOperation(claim);
    const run = await getActiveCoordinatorRun(pools.operations, tripId);
    if (run?.status === "waiting" || run?.status === "completed" || run?.status === "failed") {
      return run;
    }
    claim = await claimCoordinator(pools);
    rounds += 1;
  }
  return getActiveCoordinatorRun(pools.operations, tripId);
}
