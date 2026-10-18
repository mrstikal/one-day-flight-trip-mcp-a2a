import type { ChildProcess } from "node:child_process";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskState, type Task } from "@a2a-js/sdk";
import { A2AClient } from "@odft/protocols";
import {
  accommodationAgentClientConfig,
  accommodationAgentDatabaseUrl,
  createAccommodationDelegation,
  dataMessage,
  agentTaskRequestData,
  startAccommodationAgent,
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
 * Phase 06 Accommodation agent: card/artifact validation, the delegated hotel
 * query with effective level and objective facts, the genuine tradeoff question
 * and its same-task continuation, and the least-privilege write denial.
 */

let pool: Pool;
let pools: WorkerPools;
let mcpHost: ChildProcess;
let agent: ChildProcess;
let seeded: SeededSnapshot;

/** Deterministic standard-level fixture orders, resolved from the seeded snapshot. */
let standardPriceOrder: string[] = [];
let closestStandardId = "";

async function send(data: unknown, taskId = "", contextId = ""): Promise<Task> {
  const client = new A2AClient({ config: accommodationAgentClientConfig() });
  const result = await client.sendMessage("accommodation-agent", {
    message: dataMessage(data, taskId, contextId),
    tenant: "",
    configuration: undefined,
    metadata: undefined,
  });
  if (!("status" in result)) {
    throw new Error("expected a task result");
  }
  return result as Task;
}

function artifactOf(task: Task, name: string): unknown {
  const artifact = task.artifacts?.find((entry) => entry.name === name);
  const part = artifact?.parts?.find(
    (candidate) => candidate.content?.$case === "data" && candidate.content.value !== undefined,
  );
  return part && part.content?.$case === "data" ? part.content.value : undefined;
}

beforeAll(async () => {
  pool = createMcpTestPool();
  pools = createMcpTestWorkerPools();
  await resetMcpDatabase(pool);
  setupProtocolRoles();
  seeded = await seedDelegatedSnapshot(pool, pools);
  const standard = await pool.query<{ id: string; dist: string }>(
    `SELECT h->>'id' AS id, h->>'centerDistanceKm' AS dist
       FROM odft_app.scenario_snapshots s, lateral jsonb_array_elements(s.inventory->'hotels') h
      WHERE s.id = $1 AND h->>'level' = 'standard'
      ORDER BY (h->>'partyTotalMinor')::int, h->>'id'`,
    [seeded.snapshotId],
  );
  standardPriceOrder = standard.rows.map((row) => row.id);
  closestStandardId =
    [...standard.rows].sort(
      (a, b) => Number(a.dist) - Number(b.dist) || a.id.localeCompare(b.id),
    )[0]?.id ?? "";
  mcpHost = startMcpHost();
  await waitForHostReady(mcpHost);
  agent = startAccommodationAgent();
  await waitForAgentReady(agent, "accommodation-agent");
}, 120_000);

afterAll(async () => {
  await stopAgent(agent);
  await stopMcpHost(mcpHost);
  await endWorkerPools(pools);
  await pool.end();
});

describe("accommodation agent", () => {
  it("completes a fully specified request without a tradeoff question", async () => {
    const delegationId = await createAccommodationDelegation(pool, seeded);
    const task = await send(
      agentTaskRequestData({
        skillId: "accommodation.recommend.v1",
        tripId: seeded.tripId,
        operationId: seeded.operationId,
        delegationId,
        snapshotId: seeded.snapshotId,
        scenarioKey: "seeded",
        requestedDomains: ["hotel"],
        searchObjective: "preserve_level",
      }),
    );
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(artifactOf(task, "agent-input-request")).toBeUndefined();
    const artifact = artifactOf(task, "accommodation-recommendations") as {
      rankedHotelOfferIds: string[];
      effectiveLevel: string;
      searchObjective: string;
    };
    expect(artifact.effectiveLevel).toBe("standard");
    expect(artifact.searchObjective).toBe("preserve_level");
    expect(artifact.rankedHotelOfferIds).toEqual(standardPriceOrder);
  }, 60_000);

  it("asks a genuine tradeoff question for an ambiguous cheaper search", async () => {
    const delegationId = await createAccommodationDelegation(pool, seeded, {
      objective: "cheaper",
    });
    const task = await send(
      agentTaskRequestData({
        skillId: "accommodation.recommend.v1",
        tripId: seeded.tripId,
        operationId: seeded.operationId,
        delegationId,
        snapshotId: seeded.snapshotId,
        scenarioKey: "seeded",
        requestedDomains: ["hotel"],
        searchObjective: "cheaper",
      }),
    );
    expect(task.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    const request = artifactOf(task, "agent-input-request") as {
      requestId: string;
      taskId: string;
      contextId: string;
      inputGeneration: number;
      options: { id: string; label: string }[];
      expiresAt: string;
    };
    expect(request.taskId).toBe(task.id);
    expect(request.contextId).toBe(task.contextId);
    expect(request.inputGeneration).toBe(1);
    expect(request.options.map((option) => option.id).sort()).toEqual(["central", "cheapest"]);
    const control = await pool.query<{
      state: string;
      input_count: number;
      input_request_id: string | null;
    }>(
      `SELECT state, input_count, input_request_id FROM odft_app.protocol_task_control
        WHERE agent_identity = 'accommodation-agent' AND task_id = $1`,
      [task.id],
    );
    expect(control.rows[0]?.state).toBe("input_required");
    expect(control.rows[0]?.input_count).toBe(1);
    expect(control.rows[0]?.input_request_id).toBe(request.requestId);
  }, 60_000);

  it("answers the question in the same task and ranks for the chosen tradeoff", async () => {
    const delegationId = await createAccommodationDelegation(pool, seeded, {
      objective: "cheaper",
    });
    const asked = await send(
      agentTaskRequestData({
        skillId: "accommodation.recommend.v1",
        tripId: seeded.tripId,
        operationId: seeded.operationId,
        delegationId,
        snapshotId: seeded.snapshotId,
        scenarioKey: "seeded",
        requestedDomains: ["hotel"],
        searchObjective: "cheaper",
      }),
    );
    expect(asked.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    const completed = await send(
      agentTaskRequestData({
        skillId: "accommodation.recommend.v1",
        tripId: seeded.tripId,
        operationId: seeded.operationId,
        delegationId,
        snapshotId: seeded.snapshotId,
        scenarioKey: "seeded",
        requestedDomains: ["hotel"],
        searchObjective: "cheaper",
        continuation: {
          inputGeneration: 2,
          answerRequestId: `accommodation-tradeoff:${asked.id}`,
          selectedOptionId: "central",
        },
      }),
      asked.id,
      asked.contextId,
    );
    expect(completed.id).toBe(asked.id);
    expect(completed.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const artifact = artifactOf(completed, "accommodation-recommendations") as {
      rankedHotelOfferIds: string[];
      searchObjective: string;
    };
    expect(artifact.searchObjective).toBe("cheaper");
    expect(artifact.rankedHotelOfferIds[0]).toBe(closestStandardId);
    const control = await pool.query<{
      state: string;
      input_count: number;
      input_request_id: string | null;
      mcp_invocations: number;
    }>(
      `SELECT state, input_count, input_request_id, mcp_invocations FROM odft_app.protocol_task_control
        WHERE agent_identity = 'accommodation-agent' AND task_id = $1`,
      [asked.id],
    );
    expect(control.rows[0]?.state).toBe("completed");
    // The pending question was consumed exactly once and the counters are cumulative.
    expect(control.rows[0]?.input_request_id).toBeNull();
    expect(control.rows[0]?.input_count).toBe(1);
    expect(control.rows[0]?.mcp_invocations).toBe(4);
  }, 90_000);

  it("refuses a continuation that does not match the pending question", async () => {
    const delegationId = await createAccommodationDelegation(pool, seeded, {
      objective: "cheaper",
    });
    const asked = await send(
      agentTaskRequestData({
        skillId: "accommodation.recommend.v1",
        tripId: seeded.tripId,
        operationId: seeded.operationId,
        delegationId,
        snapshotId: seeded.snapshotId,
        scenarioKey: "seeded",
        requestedDomains: ["hotel"],
        searchObjective: "cheaper",
      }),
    );
    const failed = await send(
      agentTaskRequestData({
        skillId: "accommodation.recommend.v1",
        tripId: seeded.tripId,
        operationId: seeded.operationId,
        delegationId,
        snapshotId: seeded.snapshotId,
        scenarioKey: "seeded",
        requestedDomains: ["hotel"],
        searchObjective: "cheaper",
        continuation: {
          inputGeneration: 2,
          answerRequestId: "some-other-question",
          selectedOptionId: "cheapest",
        },
      }),
      asked.id,
      asked.contextId,
    );
    expect(failed.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(failed.artifacts ?? []).toHaveLength(1); // only the question artifact
  }, 90_000);

  it("refuses a request of another specialist's skill", async () => {
    const delegationId = await createAccommodationDelegation(pool, seeded);
    const task = await send(
      agentTaskRequestData({
        skillId: "city-guide.research.v1",
        tripId: seeded.tripId,
        operationId: seeded.operationId,
        delegationId,
        snapshotId: seeded.snapshotId,
        scenarioKey: "seeded",
        requestedDomains: ["breakfast"],
      }),
    );
    expect(task.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(task.artifacts ?? []).toHaveLength(0);
  }, 60_000);

  it("proves the accommodation role cannot mutate trip state or book", async () => {
    const delegationId = await createAccommodationDelegation(pool, seeded);
    const agentPool = new Pool({ connectionString: accommodationAgentDatabaseUrl(), max: 1 });
    try {
      await expect(
        agentPool.query(`UPDATE odft_app.trips SET revision = revision + 1 WHERE id = $1`, [
          seeded.tripId,
        ]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        agentPool.query(
          `INSERT INTO odft_app.reservations (id, trip_id, service_key, offer_id, status)
           VALUES (gen_random_uuid(), $1, 'hotel', 'x', 'confirmed')`,
          [seeded.tripId],
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        agentPool.query(`UPDATE odft_app.agent_delegations SET status = 'revoked' WHERE id = $1`, [
          delegationId,
        ]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        agentPool.query(
          `INSERT INTO odft_app.trip_selections (trip_id, service_key, offer_id) VALUES ($1, 'hotel', 'x')`,
          [seeded.tripId],
        ),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await agentPool.end();
    }
  }, 30_000);
});
