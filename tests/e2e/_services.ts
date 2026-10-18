import { spawn, type ChildProcess } from "node:child_process";
import { Pool } from "pg";
import { createTrip } from "@odft/persistence";
import { resetDatabase } from "../integration/_setup.js";
import { createFixtureSession } from "../fixtures/session.js";
import { fixtureCreationInput } from "../fixtures/trip.js";
import {
  AGENT_TOKENS,
  setupProtocolRoles,
  startMcpHost,
  stopMcpHost,
  waitForHostReady,
} from "../integration/mcp/_setup.js";
import {
  startFlightAgent,
  stopFlightAgent,
  waitForFlightAgent,
} from "../integration/a2a/_setup.js";
import {
  startAccommodationAgent,
  startAccommodationAltAgent,
  startCityGuideAgent,
  stopAgent,
  waitForAgentReady,
} from "../integration/a2a/_setup-agents.js";
import { REPO_ROOT } from "../fixtures/protocols/roles.js";

/**
 * Phase 10 end-to-end services (ODTF_PLAN.md Phase 10): the real MCP host, all
 * specialist agents and a coordinator-enabled worker against the SAME isolated
 * database as the web server. The integration helpers are reused so the e2e
 * stack cannot drift from the tested protocol wiring; the only difference is
 * that `TEST_DATABASE_URL` points at the e2e database.
 */

const TSX = `${REPO_ROOT}/node_modules/.bin/tsx`;

export interface E2eServices {
  readonly pool: Pool;
  readonly mcpHost: ChildProcess;
  readonly flightAgent: ChildProcess;
  readonly accommodationAgent: ChildProcess;
  readonly accommodationAltAgent: ChildProcess;
  readonly cityGuideAgent: ChildProcess;
  readonly worker: ChildProcess;
  restartCityGuideHealthy(): Promise<void>;
  restartCityGuideCrashing(): Promise<void>;
  waitForCityGuideExit(): Promise<void>;
  stop(): Promise<void>;
}

export function databaseUrlOrThrow(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("DATABASE_URL is required for the e2e/benchmark stack");
  }
  let databaseName: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error("unsupported protocol");
    }
    databaseName = parsed.pathname.replace(/^\//, "");
  } catch {
    throw new Error("DATABASE_URL must be a valid postgres:// or postgresql:// URL");
  }
  // The stack resets odft_app/odft_protocol before every spec. Never let a
  // mis-pointed command destroy the application database.
  if (!databaseName) {
    throw new Error("DATABASE_URL must include a database name");
  }
  if (!databaseName.endsWith("_test")) {
    throw new Error(
      `the e2e/benchmark stack requires a disposable database whose name ends in _test (got ${databaseName})`,
    );
  }
  return url;
}

async function waitForWorkerHeartbeat(
  pool: Pool,
  startedAt: number,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await pool.query<{ fresh: boolean }>(
      `SELECT (extract(epoch FROM now() - max(last_heartbeat_at)) * 1000) < 5000 AS fresh
         FROM odft_app.worker_heartbeat`,
    );
    const fresh = result.rows[0]?.fresh === true;
    if (fresh && Date.now() > startedAt) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("coordinator worker did not record a fresh heartbeat");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function startCoordinatorWorker(registryPath: string): ChildProcess {
  const databaseUrl = databaseUrlOrThrow();
  return spawn(TSX, ["--tsconfig", "tsconfig.json", "apps/worker/src/main.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      AI_MODE: "fixture",
      WORKER_CONCURRENCY: "1",
      ODFT_AGENT_REGISTRY_PATH: registryPath,
      ODFT_AGENT_TOKEN_FLIGHT: AGENT_TOKENS.flight,
      ODFT_AGENT_TOKEN_ACCOMMODATION: AGENT_TOKENS.accommodation,
      ODFT_AGENT_TOKEN_ACCOMMODATION_ALT: AGENT_TOKENS.accommodationAlt,
      ODFT_AGENT_TOKEN_CITY_GUIDE: AGENT_TOKENS.cityGuide,
      ODFT_COORDINATOR_TOKEN: AGENT_TOKENS.coordinator,
      WIKIDATA_DISCOVERY: "false",
    },
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
}

export async function startE2eServices(
  options: {
    readonly registry?: "primary" | "replacement";
    readonly crashingCityGuide?: boolean;
  } = {},
): Promise<E2eServices> {
  const databaseUrl = databaseUrlOrThrow();
  // The integration helpers read TEST_DATABASE_URL at call time; point them at
  // the same isolated database the web server and worker use.
  process.env.TEST_DATABASE_URL = databaseUrl;
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  // Every spec starts from a clean, migrated database: the Phase 11 stack owns
  // the coordinator/agents/MCP and must not inherit another spec's trips.
  // Roles/grants are (re)applied AFTER the schema reset, otherwise the fresh
  // tables would have no privileges for the restricted agent roles.
  await resetDatabase(pool);
  setupProtocolRoles();
  const mcpHost = startMcpHost();
  await waitForHostReady(mcpHost);
  const flightAgent = startFlightAgent();
  await waitForFlightAgent(flightAgent);
  const accommodationAgent = startAccommodationAgent();
  await waitForAgentReady(accommodationAgent, "accommodation-agent");
  const accommodationAltAgent = startAccommodationAltAgent();
  await waitForAgentReady(accommodationAltAgent, "accommodation-agent-alt");
  let cityGuideAgent = options.crashingCityGuide
    ? startCityGuideAgent({ ODFT_CITY_GUIDE_AGENT_CRASH: "1" })
    : startCityGuideAgent();
  await waitForAgentReady(cityGuideAgent, "city-guide-agent");
  const registryPath = `${REPO_ROOT}/tests/fixtures/protocols/agent-registry-coordinator${
    options.registry === "replacement" ? "-alt" : ""
  }.json`;
  const startedAt = Date.now();
  const worker = startCoordinatorWorker(registryPath);
  await waitForWorkerHeartbeat(pool, startedAt);

  const restartCityGuide = async (crashing: boolean): Promise<void> => {
    await stopAgent(cityGuideAgent);
    cityGuideAgent = crashing
      ? startCityGuideAgent({ ODFT_CITY_GUIDE_AGENT_CRASH: "1" })
      : startCityGuideAgent();
    await waitForAgentReady(cityGuideAgent, "city-guide-agent");
  };

  return {
    pool,
    mcpHost,
    flightAgent,
    accommodationAgent,
    accommodationAltAgent,
    get cityGuideAgent() {
      return cityGuideAgent;
    },
    worker,
    restartCityGuideHealthy: () => restartCityGuide(false),
    restartCityGuideCrashing: () => restartCityGuide(true),
    async waitForCityGuideExit() {
      if (cityGuideAgent.exitCode !== null || cityGuideAgent.signalCode !== null) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("the City Guide process did not exit")),
          60_000,
        );
        cityGuideAgent.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    async stop() {
      await stopWorker(worker);
      await stopAgent(cityGuideAgent);
      await stopAgent(accommodationAltAgent);
      await stopAgent(accommodationAgent);
      await stopFlightAgent(flightAgent);
      await stopMcpHost(mcpHost);
      await pool.end();
    },
  };
}

export async function stopWorker(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    if (child.pid) {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    child.kill("SIGKILL");
  }
}

/** Seed a coordinator-engine trip for the browser session created via the API. */
export async function seedCoordinatorTrip(
  pool: Pool,
  sessionId: string,
): Promise<{ tripId: string; operationId: string }> {
  const created = await createTrip(pool, {
    sessionId,
    input: fixtureCreationInput(),
  });
  if (!("tripId" in created)) {
    throw new Error(`coordinator trip creation failed: ${JSON.stringify(created)}`);
  }
  return { tripId: created.tripId, operationId: created.operationId };
}

/** The current pending decision id/kind for a trip (polled by e2e specs). */
export async function pendingDecision(
  pool: Pool,
  tripId: string,
): Promise<
  { id: string; kind: string; allowedOfferIds: string[]; proposalId: string | null } | undefined
> {
  const result = await pool.query<{
    id: string;
    kind: string;
    allowed_offer_ids: string[];
    proposal_id: string | null;
  }>(
    `SELECT id, kind, allowed_offer_ids, proposal_id FROM odft_app.pending_decisions
      WHERE trip_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
    [tripId],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        kind: row.kind,
        allowedOfferIds: row.allowed_offer_ids,
        proposalId: row.proposal_id,
      }
    : undefined;
}

/** Poll a predicate against the database until it returns a value. */
export async function waitForDb<T>(
  read: () => Promise<T | undefined>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function seedSession(pool: Pool): Promise<string> {
  const client = await pool.connect();
  try {
    return await createFixtureSession(client);
  } finally {
    client.release();
  }
}
