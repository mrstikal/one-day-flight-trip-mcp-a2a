import type { ChildProcess } from "node:child_process";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskState, type Task } from "@a2a-js/sdk";
import { A2AClient } from "@odft/protocols";
import { flightRecommendationsSchema } from "@odft/contracts";
import {
  createFlightDelegation,
  createMcpTestPool,
  createMcpTestWorkerPools,
  endWorkerPools,
  flightAgentClientConfig,
  flightDataMessage,
  flightTaskRequestData,
  resetMcpDatabase,
  seedFlightDelegation,
  setupProtocolRoles,
  startFlightAgent,
  startMcpHost,
  stopFlightAgent,
  stopMcpHost,
  waitForFlightAgent,
  waitForHostReady,
  type SeededSnapshot,
  type WorkerPools,
} from "./_setup.js";

/**
 * Phase 05 Flight Agent end-to-end: real MCP reads, deterministic ranking,
 * validated artifact, streamed lifecycle, restart persistence and the
 * crash-before-work reconciliation boundary.
 */

let pool: Pool;
let pools: WorkerPools;
let mcpHost: ChildProcess;
let agent: ChildProcess;
let seeded: SeededSnapshot & { delegationId: string };

async function sendAndAwait(message: ReturnType<typeof flightDataMessage>): Promise<Task> {
  const client = new A2AClient({ config: flightAgentClientConfig() });
  const result = await client.sendMessage("flight-agent", {
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

beforeAll(async () => {
  pool = createMcpTestPool();
  pools = createMcpTestWorkerPools();
  await resetMcpDatabase(pool);
  setupProtocolRoles();
  seeded = await seedFlightDelegation(pool, pools);
  mcpHost = startMcpHost();
  await waitForHostReady(mcpHost);
  agent = startFlightAgent();
  await waitForFlightAgent(agent);
}, 120_000);

afterAll(async () => {
  await stopFlightAgent(agent);
  await stopMcpHost(mcpHost);
  await endWorkerPools(pools);
  await pool.end();
});

describe("flight agent", () => {
  it("discovers the card and completes a task with a validated artifact", async () => {
    const client = new A2AClient({ config: flightAgentClientConfig() });
    const { card } = await client.discoverCard("flight-agent");
    expect(card.skills.map((skill) => skill.id)).toContain("flight.recommend.v1");

    const task = await sendAndAwait(
      flightDataMessage(
        flightTaskRequestData({
          tripId: seeded.tripId,
          operationId: seeded.operationId,
          delegationId: seeded.delegationId,
          snapshotId: seeded.snapshotId,
          scenarioKey: "seeded",
        }),
      ),
    );
    if (task.status?.state !== TaskState.TASK_STATE_COMPLETED) {
      throw new Error(
        `task failed: ${JSON.stringify(task.status?.message?.parts?.[0]?.content)} meta=${JSON.stringify(task.status?.message?.metadata)}`,
      );
    }
    const part = task.artifacts[0]?.parts.find(
      (candidate) => candidate.mediaType === "application/vnd.odft.flight-recommendations.v1+json",
    );
    const artifact = flightRecommendationsSchema.parse(
      part?.content?.$case === "data" ? part.content.value : undefined,
    );
    expect(artifact.correlation.delegationId).toBe(seeded.delegationId);
    expect(artifact.correlation.snapshotId).toBe(seeded.snapshotId);
    expect(artifact.rankedCombinationIds.length).toBeGreaterThan(0);

    // Every ranked id is schedule-valid for the seeded trip.
    const valid = await pool.query<{ result: { validCombinationIds: string[] } }>(
      `SELECT sv.result FROM odft_app.schedule_validations sv
         JOIN odft_app.trips t ON t.current_schedule_validation_id = sv.id
        WHERE t.id = $1`,
      [seeded.tripId],
    );
    const validIds = new Set(valid.rows[0]?.result.validCombinationIds ?? []);
    for (const id of artifact.rankedCombinationIds) {
      expect(validIds.has(id)).toBe(true);
    }
    // Counters were accrued on the canonical task.
    const control = await pool.query<{ mcp_invocations: number; state: string }>(
      `SELECT mcp_invocations, state FROM odft_app.protocol_task_control
        WHERE agent_identity = 'flight-agent' AND task_id = $1`,
      [task.id],
    );
    expect(control.rows[0]?.mcp_invocations).toBe(2);
    expect(control.rows[0]?.state).toBe("completed");
  }, 60_000);

  it("streams real progress, the artifact and the terminal status", async () => {
    const client = new A2AClient({ config: flightAgentClientConfig() });
    const kinds: string[] = [];
    let finalState: number | undefined;
    const delegationId = await createFlightDelegation(pool, seeded);
    for await (const event of client.sendMessageStream("flight-agent", {
      message: flightDataMessage(
        flightTaskRequestData({
          tripId: seeded.tripId,
          operationId: seeded.operationId,
          delegationId,
          snapshotId: seeded.snapshotId,
          scenarioKey: "seeded",
        }),
      ),
      tenant: "",
      configuration: undefined,
      metadata: undefined,
    })) {
      const payload = (event as { payload?: { $case?: string; value?: unknown } }).payload;
      if (!payload?.$case) {
        continue;
      }
      kinds.push(payload.$case);
      if (payload.$case === "statusUpdate") {
        finalState = (payload.value as { status?: { state?: number } }).status?.state;
      }
    }
    expect(kinds[0]).toBe("task");
    expect(kinds).toContain("statusUpdate");
    expect(kinds).toContain("artifactUpdate");
    expect(finalState).toBe(TaskState.TASK_STATE_COMPLETED);
  }, 60_000);

  it("persists completed output across an agent restart", async () => {
    const delegationId = await createFlightDelegation(pool, seeded);
    const task = await sendAndAwait(
      flightDataMessage(
        flightTaskRequestData({
          tripId: seeded.tripId,
          operationId: seeded.operationId,
          delegationId,
          snapshotId: seeded.snapshotId,
          scenarioKey: "seeded",
        }),
      ),
    );
    await stopFlightAgent(agent);
    agent = startFlightAgent();
    await waitForFlightAgent(agent);
    const client = new A2AClient({ config: flightAgentClientConfig() });
    const retrieved = await client.getTask("flight-agent", {
      id: task.id,
      tenant: "",
      historyLength: undefined,
    });
    expect(retrieved.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(retrieved.artifacts.length).toBeGreaterThan(0);
  }, 60_000);

  it("reconciles a crash before first work into AGENT_RESTARTED", async () => {
    await stopFlightAgent(agent);
    const crashing = startFlightAgent({ ODFT_FLIGHT_AGENT_CRASH: "1" });
    await waitForFlightAgent(crashing);
    const crashDelegationId = await createFlightDelegation(pool, seeded);
    const message = flightDataMessage(
      flightTaskRequestData({
        tripId: seeded.tripId,
        operationId: seeded.operationId,
        delegationId: crashDelegationId,
        snapshotId: seeded.snapshotId,
        scenarioKey: "seeded",
      }),
    );
    await expect(sendAndAwait(message)).rejects.toBeTruthy();
    await new Promise<void>((resolve) => {
      if (crashing.exitCode !== null) {
        resolve();
        return;
      }
      crashing.once("exit", () => resolve());
    });
    agent = startFlightAgent();
    await waitForFlightAgent(agent);
    const mapped = await pool.query<{ task_id: string }>(
      `SELECT task_id FROM odft_app.protocol_inbound_messages
        WHERE agent_identity = 'flight-agent' AND message_id = $1`,
      [message.messageId],
    );
    const taskId = mapped.rows[0]?.task_id;
    expect(taskId).toBeTruthy();
    const client = new A2AClient({ config: flightAgentClientConfig() });
    const recovered = await client.getTask("flight-agent", {
      id: taskId as string,
      tenant: "",
      historyLength: undefined,
    });
    expect(recovered.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    const replay = await sendAndAwait(message);
    expect(replay.id).toBe(taskId);
    expect(replay.status?.state).toBe(TaskState.TASK_STATE_FAILED);
  }, 90_000);

  it("refuses to cancel a terminal task (honest SDK semantics)", async () => {
    const client = new A2AClient({ config: flightAgentClientConfig() });
    const delegationId = await createFlightDelegation(pool, seeded);
    const task = await sendAndAwait(
      flightDataMessage(
        flightTaskRequestData({
          tripId: seeded.tripId,
          operationId: seeded.operationId,
          delegationId,
          snapshotId: seeded.snapshotId,
          scenarioKey: "seeded",
        }),
      ),
    );
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    // A completed task is not cancelable; the flight task is too short-lived to
    // deterministically hit the live window in fixture mode. The executor
    // implements accepted cancellation as local revocation (cancel_requested_at
    // + control state, checked before any late artifact); the wide input-required
    // window that exercises it end to end arrives with the Phase 06 agent.
    await expect(
      client.cancelTask("flight-agent", { id: task.id, tenant: "", metadata: undefined }),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("rejects a task whose request is not a flight request", async () => {
    const task = await sendAndAwait(flightDataMessage({ skillId: "not-a-skill" }));
    expect(task.status?.state).toBe(TaskState.TASK_STATE_FAILED);
  }, 60_000);
});
