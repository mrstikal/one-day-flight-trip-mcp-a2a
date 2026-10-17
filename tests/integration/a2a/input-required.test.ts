import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskState, type Task } from "@a2a-js/sdk";
import { A2AClient, loadTaskAllowance } from "@odft/protocols";
import {
  accommodationAgentClientConfig,
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
 * Phase 06 input-required lifecycle: the genuine question, a properly rebound
 * continuation on the same task/context, duplicate answers, expiry, restart
 * while awaiting input, revoked authority and cumulative caps that survive the
 * continuation.
 */

let pool: Pool;
let pools: WorkerPools;
let mcpHost: ChildProcess;
let agent: ChildProcess;
let seeded: SeededSnapshot;

function client(): A2AClient {
  return new A2AClient({ config: accommodationAgentClientConfig() });
}

async function send(data: unknown, messageId?: string, taskId = "", contextId = ""): Promise<Task> {
  const message = dataMessage(data, taskId, contextId);
  if (messageId) {
    message.messageId = messageId as never;
  }
  const result = await client().sendMessage("accommodation-agent", {
    message,
    tenant: "",
    configuration: undefined,
    metadata: undefined,
  });
  if (!("status" in result)) {
    throw new Error("expected a task result");
  }
  return result as Task;
}

function cheaperRequest(delegationId: string, extra: Record<string, unknown> = {}): unknown {
  return agentTaskRequestData({
    skillId: "accommodation.recommend.v1",
    tripId: seeded.tripId,
    operationId: seeded.operationId,
    delegationId,
    snapshotId: seeded.snapshotId,
    scenarioKey: "seeded",
    requestedDomains: ["hotel"],
    searchObjective: "cheaper",
    ...extra,
  });
}

async function ask(): Promise<{ task: Task; delegationId: string }> {
  const delegationId = await createAccommodationDelegation(pool, seeded, { objective: "cheaper" });
  const task = await send(cheaperRequest(delegationId));
  expect(task.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
  return { task, delegationId };
}

function answer(task: Task, delegationId: string, selectedOptionId: string, operationId?: string) {
  return agentTaskRequestData({
    skillId: "accommodation.recommend.v1",
    tripId: seeded.tripId,
    operationId: operationId ?? seeded.operationId,
    delegationId,
    snapshotId: seeded.snapshotId,
    scenarioKey: "seeded",
    requestedDomains: ["hotel"],
    searchObjective: "cheaper",
    continuation: {
      inputGeneration: 2,
      answerRequestId: `accommodation-tradeoff:${task.id}`,
      selectedOptionId,
    },
  });
}

beforeAll(async () => {
  pool = createMcpTestPool();
  pools = createMcpTestWorkerPools();
  await resetMcpDatabase(pool);
  setupProtocolRoles();
  seeded = await seedDelegatedSnapshot(pool, pools);
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

describe("input-required lifecycle", () => {
  it("answers a duplicate message with the persisted canonical outcome (no second execution)", async () => {
    const { task, delegationId } = await ask();
    // The skill's documented limits are wired to the real task row: after one
    // question and one invocation the remaining allowances are the remainder.
    const allowance = await loadTaskAllowance(pool, {
      agentIdentity: "accommodation-agent",
      taskId: task.id,
      skillId: "accommodation.recommend.v1",
    });
    expect(allowance.remainingInputs).toBe(1);
    expect(allowance.remainingMcp).toBe(2);
    const messageId = `answer-${randomUUID().slice(0, 8)}`;
    const data = answer(task, delegationId, "cheapest");
    const completed = await send(data, messageId, task.id, task.contextId);
    expect(completed.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const replay = await send(data, messageId, task.id, task.contextId);
    expect(replay.id).toBe(completed.id);
    expect(replay.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const control = await pool.query<{ input_count: number; mcp_invocations: number; state: string }>(
      `SELECT input_count, mcp_invocations, state FROM odft_app.protocol_task_control
        WHERE agent_identity = 'accommodation-agent' AND task_id = $1`,
      [task.id],
    );
    expect(control.rows[0]?.mcp_invocations).toBe(4);
    expect(control.rows[0]?.input_count).toBe(1);
    expect(control.rows[0]?.state).toBe("completed");
  }, 90_000);

  it("refuses an expired question with INPUT_EXPIRED", async () => {
    const { task, delegationId } = await ask();
    await pool.query(
      `UPDATE odft_app.protocol_task_control SET input_expires_at = now() - interval '1 second'
        WHERE agent_identity = 'accommodation-agent' AND task_id = $1`,
      [task.id],
    );
    const failed = await send(answer(task, delegationId, "cheapest"), undefined, task.id, task.contextId);
    expect(failed.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(
      failed.status?.message?.parts?.[0]?.content?.$case === "text"
        ? failed.status.message.parts[0].content.value
        : "",
    ).toMatch(/expired/i);
  }, 90_000);

  it("keeps the task awaiting input across an agent restart and completes afterwards", async () => {
    const { task, delegationId } = await ask();
    // Restart the agent: reconciliation must NOT fail an input-required task.
    await stopAgent(agent);
    agent = startAccommodationAgent();
    await waitForAgentReady(agent, "accommodation-agent");
    const reloaded = await client().getTask("accommodation-agent", {
      id: task.id,
      tenant: "",
    });
    expect(reloaded.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    const newOperationId = randomUUID();
    const completed = await send(
      answer(task, delegationId, "central", newOperationId),
      undefined,
      task.id,
      task.contextId,
    );
    expect(completed.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const artifact = completed.artifacts?.find(
      (entry) => entry.name === "accommodation-recommendations",
    );
    const part = artifact?.parts?.find((candidate) => candidate.content?.$case === "data");
    const value =
      part && part.content?.$case === "data"
        ? (part.content.value as { correlation: { operationId: string } })
        : undefined;
    // The continuation ran under a new authorized operation at the unchanged revision.
    expect(value?.correlation.operationId).toBe(newOperationId);
  }, 120_000);

  it("fails an unknown answer option without re-asking or re-accepting", async () => {
    const { task, delegationId } = await ask();
    const failed = await send(
      answer(task, delegationId, "bogus-option"),
      undefined,
      task.id,
      task.contextId,
    );
    expect(failed.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(
      failed.status?.message?.parts?.[0]?.content?.$case === "text"
        ? failed.status.message.parts[0].content.value
        : "",
    ).toMatch(/unknown option/i);
    // The pending binding was consumed by the CAS: the same answer can never be
    // accepted later, and no new question was published.
    const control = await pool.query<{ input_request_id: string | null; input_count: number; state: string }>(
      `SELECT input_request_id, input_count, state FROM odft_app.protocol_task_control
        WHERE agent_identity = 'accommodation-agent' AND task_id = $1`,
      [task.id],
    );
    expect(control.rows[0]?.input_request_id).toBeNull();
    expect(control.rows[0]?.input_count).toBe(1);
    expect(control.rows[0]?.state).toBe("failed");
    const artifacts = failed.artifacts ?? [];
    expect(artifacts.filter((entry) => entry.name === "agent-input-request")).toHaveLength(1);
  }, 90_000);

  it("refuses a continuation whose delegation was revoked", async () => {
    const { task, delegationId } = await ask();
    await pool.query(`UPDATE odft_app.agent_delegations SET status = 'revoked', revoked_at = now() WHERE id = $1`, [
      delegationId,
    ]);
    const failed = await send(answer(task, delegationId, "cheapest"), undefined, task.id, task.contextId);
    expect(failed.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(
      failed.status?.message?.parts?.[0]?.content?.$case === "text"
        ? failed.status.message.parts[0].content.value
        : "",
    ).toMatch(/revoked/i);
  }, 90_000);
});
