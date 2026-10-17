import type { ChildProcess } from "node:child_process";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskState, type Task } from "@a2a-js/sdk";
import { A2AClient } from "@odft/protocols";
import {
  accommodationAgentClientConfig,
  cityGuideAgentClientConfig,
  createAccommodationDelegation,
  createCityGuideDelegation,
  dataMessage,
  agentTaskRequestData,
  startAccommodationAgent,
  startCityGuideAgent,
  stopAgent,
  waitForAgentReady,
} from "./_setup-agents.js";
import {
  createMcpTestPool,
  createMcpTestWorkerPools,
  endWorkerPools,
  resetMcpDatabase,
  seedDelegatedSnapshot,
  setupProtocolRoles,
  startMcpHost,
  stopMcpHost,
  waitForHostReady,
  type SeededSnapshot,
  type WorkerPools,
} from "./_setup.js";

/**
 * Phase 06 parallel research (plan §3.11): the Accommodation and City Guide
 * tasks run SIMULTANEOUSLY with overlapping execution windows — independent
 * services, independent ports, no global serialization.
 */

let pool: Pool;
let pools: WorkerPools;
let mcpHost: ChildProcess;
let accommodationAgent: ChildProcess;
let cityGuideAgent: ChildProcess;
let seeded: SeededSnapshot;

async function send(client: A2AClient, identity: string, data: unknown): Promise<Task> {
  const result = await client.sendMessage(identity, {
    message: dataMessage(data),
    tenant: "",
    configuration: undefined,
    metadata: undefined,
  });
  if (!("status" in result)) {
    throw new Error("expected a task result");
  }
  return result as Task;
}

beforeAll(async () => {
  pool = createMcpTestPool();
  pools = createMcpTestWorkerPools();
  await resetMcpDatabase(pool);
  setupProtocolRoles();
  seeded = await seedDelegatedSnapshot(pool, pools);
  mcpHost = startMcpHost();
  await waitForHostReady(mcpHost);
  // The documented test-only step delays widen the observable working window.
  accommodationAgent = startAccommodationAgent({ ODFT_ACCOMMODATION_AGENT_STEP_DELAY_MS: "1500" });
  cityGuideAgent = startCityGuideAgent({ ODFT_CITY_GUIDE_AGENT_STEP_DELAY_MS: "1200" });
  await waitForAgentReady(accommodationAgent, "accommodation-agent");
  await waitForAgentReady(cityGuideAgent, "city-guide-agent");
}, 120_000);

afterAll(async () => {
  await stopAgent(accommodationAgent);
  await stopAgent(cityGuideAgent);
  await stopMcpHost(mcpHost);
  await endWorkerPools(pools);
  await pool.end();
});

describe("parallel research", () => {
  it("runs both specialists with overlapping working windows", async () => {
    const accommodationDelegation = await createAccommodationDelegation(pool, seeded);
    const cityGuideDelegation = await createCityGuideDelegation(pool, seeded);
    const accommodationClient = new A2AClient({ config: accommodationAgentClientConfig() });
    const cityGuideClient = new A2AClient({ config: cityGuideAgentClientConfig() });

    let maxConcurrentWorking = 0;
    let done = 0;
    const monitor = (async () => {
      while (done < 2) {
        const rows = await pool.query<{ working: string }>(
          `SELECT count(*)::text AS working FROM odft_app.protocol_task_control
            WHERE agent_identity IN ('accommodation-agent', 'city-guide-agent')
              AND state = 'working'`,
        );
        const working = Number(rows.rows[0]?.working ?? 0);
        maxConcurrentWorking = Math.max(maxConcurrentWorking, working);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })();

    try {
      const [accommodation, cityGuide] = await Promise.all([
        send(
          accommodationClient,
          "accommodation-agent",
          agentTaskRequestData({
            skillId: "accommodation.recommend.v1",
            tripId: seeded.tripId,
            operationId: seeded.operationId,
            delegationId: accommodationDelegation,
            snapshotId: seeded.snapshotId,
            scenarioKey: "seeded",
            requestedDomains: ["hotel"],
            searchObjective: "preserve_level",
          }),
        ).finally(() => {
          done += 1;
        }),
        send(
          cityGuideClient,
          "city-guide-agent",
          agentTaskRequestData({
            skillId: "city-guide.research.v1",
            tripId: seeded.tripId,
            operationId: seeded.operationId,
            delegationId: cityGuideDelegation,
            snapshotId: seeded.snapshotId,
            scenarioKey: "seeded",
            requestedDomains: ["lunch", "attractions", "events"],
          }),
        ).finally(() => {
          done += 1;
        }),
      ]);
      expect(accommodation.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
      expect(cityGuide.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
      expect(accommodation.artifacts?.some((entry) => entry.name === "accommodation-recommendations")).toBe(true);
      expect(cityGuide.artifacts?.some((entry) => entry.name === "city-guide-recommendations")).toBe(true);
    } finally {
      await monitor;
    }
    // Both tasks were in `working` at the same observed moment: real overlap,
    // not two fast sequential runs.
    expect(maxConcurrentWorking).toBe(2);
  }, 120_000);
});
