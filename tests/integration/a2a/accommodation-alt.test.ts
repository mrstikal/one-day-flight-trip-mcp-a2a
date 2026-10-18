import type { ChildProcess } from "node:child_process";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskState, type Task } from "@a2a-js/sdk";
import { accommodationRecommendationsSchema } from "@odft/contracts";
import { A2AClient } from "@odft/protocols";
import {
  ACCOMMODATION_ALT_AGENT_PORT,
  accommodationAltAgentClientConfig,
  accommodationAgentDatabaseUrl,
  createAccommodationDelegation,
  dataMessage,
  agentTaskRequestData,
  startAccommodationAltAgent,
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
 * Phase 10 Accommodation Agent B (plan §3.17): an independently implemented
 * replacement that preserves the public card, request, input-required and
 * artifact contracts while using its own value-score strategy and task table.
 */

let pool: Pool;
let pools: WorkerPools;
let mcpHost: ChildProcess;
let agent: ChildProcess;
let seeded: SeededSnapshot;
let standardIds: string[] = [];
let closestStandardId = "";

async function send(data: unknown, taskId = "", contextId = ""): Promise<Task> {
  const client = new A2AClient({ config: accommodationAltAgentClientConfig() });
  const result = await client.sendMessage("accommodation-agent-alt", {
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
      WHERE s.id = $1 AND h->>'level' = 'standard'`,
    [seeded.snapshotId],
  );
  standardIds = standard.rows.map((row) => row.id).sort();
  closestStandardId =
    [...standard.rows].sort(
      (a, b) => Number(a.dist) - Number(b.dist) || a.id.localeCompare(b.id),
    )[0]?.id ?? "";
  mcpHost = startMcpHost();
  await waitForHostReady(mcpHost);
  agent = startAccommodationAltAgent();
  await waitForAgentReady(agent, "accommodation-agent-alt");
}, 120_000);

afterAll(async () => {
  await stopAgent(agent);
  await stopMcpHost(mcpHost);
  await endWorkerPools(pools);
  await pool.end();
});

describe("accommodation agent B (replacement)", () => {
  it("serves its own card on its own port with the same public skill", async () => {
    const response = await fetch(
      `http://127.0.0.1:${ACCOMMODATION_ALT_AGENT_PORT}/.well-known/agent-card.json`,
    );
    expect(response.status).toBe(200);
    const card = (await response.json()) as {
      name: string;
      skills: { id: string }[];
      supportedInterfaces: { url: string }[];
    };
    expect(card.name).toBe("accommodation-agent-alt");
    expect(card.skills.map((skill) => skill.id)).toContain("accommodation.recommend.v1");
    expect(card.supportedInterfaces[0]?.url).toBe(
      `http://127.0.0.1:${ACCOMMODATION_ALT_AGENT_PORT}`,
    );
  }, 60_000);

  it("completes a fully specified request with the SAME artifact contract", async () => {
    const delegationId = await createAccommodationDelegation(pool, seeded, {
      agentIdentity: "accommodation-agent-alt",
      endpointUrl: `http://127.0.0.1:${ACCOMMODATION_ALT_AGENT_PORT}`,
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
        searchObjective: "preserve_level",
      }),
    );
    const failureText = task.status?.message?.parts?.[0]?.content;
    expect(
      task.status?.state,
      failureText?.$case === "text" ? failureText.value : "no failure text",
    ).toBe(TaskState.TASK_STATE_COMPLETED);
    const artifact = accommodationRecommendationsSchema.parse(
      artifactOf(task, "accommodation-recommendations"),
    );
    // Same eligible set (standard level) and a complete deterministic order.
    expect([...artifact.rankedHotelOfferIds].sort()).toEqual(standardIds);
    expect(artifact.effectiveLevel).toBe("standard");
    expect(artifact.searchObjective).toBe("preserve_level");
    expect(artifact.comparisons).toHaveLength(artifact.rankedHotelOfferIds.length);
    // The alternative task table is used, never the primary agent's.
    const altRow = await pool.query<{ owner: string }>(
      `SELECT owner FROM odft_protocol.agent_tasks_accommodation_alt WHERE id = $1`,
      [task.id],
    );
    expect(altRow.rows[0]?.owner).toBe("accommodation-agent-alt");
    const primaryRow = await pool.query(
      `SELECT 1 FROM odft_protocol.agent_tasks_accommodation WHERE id = $1`,
      [task.id],
    );
    expect(primaryRow.rowCount).toBe(0);
  }, 60_000);

  it("asks the same genuine tradeoff question with its own request binding", async () => {
    const delegationId = await createAccommodationDelegation(pool, seeded, {
      objective: "cheaper",
      agentIdentity: "accommodation-agent-alt",
      endpointUrl: `http://127.0.0.1:${ACCOMMODATION_ALT_AGENT_PORT}`,
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
      options: { id: string }[];
      inputGeneration: number;
    };
    expect(request.requestId).toBe(`accommodation-alt-tradeoff:${task.id}`);
    expect(request.inputGeneration).toBe(1);
    expect(request.options.map((option) => option.id).sort()).toEqual(["central", "cheapest"]);
  }, 60_000);

  it("consumes the answer in the same task and applies the chosen order", async () => {
    const delegationId = await createAccommodationDelegation(pool, seeded, {
      objective: "cheaper",
      agentIdentity: "accommodation-agent-alt",
      endpointUrl: `http://127.0.0.1:${ACCOMMODATION_ALT_AGENT_PORT}`,
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
          answerRequestId: `accommodation-alt-tradeoff:${asked.id}`,
          selectedOptionId: "central",
        },
      }),
      asked.id,
      asked.contextId,
    );
    expect(completed.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const artifact = accommodationRecommendationsSchema.parse(
      artifactOf(completed, "accommodation-recommendations"),
    );
    expect(artifact.rankedHotelOfferIds[0]).toBe(closestStandardId);
    const control = await pool.query<{ state: string; input_request_id: string | null }>(
      `SELECT state, input_request_id FROM odft_app.protocol_task_control
        WHERE agent_identity = 'accommodation-agent-alt' AND task_id = $1`,
      [asked.id],
    );
    expect(control.rows[0]?.state).toBe("completed");
    expect(control.rows[0]?.input_request_id).toBeNull();
  }, 90_000);

  it("refuses another specialist's skill with a safe failure code", async () => {
    const delegationId = await createAccommodationDelegation(pool, seeded, {
      agentIdentity: "accommodation-agent-alt",
      endpointUrl: `http://127.0.0.1:${ACCOMMODATION_ALT_AGENT_PORT}`,
    });
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
    const text = task.status?.message?.parts?.[0]?.content;
    expect(text?.$case === "text" ? text.value : "").toMatch(/^INVALID_ARTIFACT:/);
  }, 60_000);

  it("keeps the same least-privilege write denial", async () => {
    const agentPool = new Pool({ connectionString: accommodationAgentDatabaseUrl(), max: 1 });
    try {
      await expect(
        agentPool.query(`UPDATE odft_app.trips SET revision = revision + 1 WHERE id = $1`, [
          seeded.tripId,
        ]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await agentPool.end();
    }
  }, 60_000);
});
