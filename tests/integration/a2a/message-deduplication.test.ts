import type { ChildProcess } from "node:child_process";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskState, type Task } from "@a2a-js/sdk";
import { A2AClient } from "@odft/protocols";
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
 * Phase 05 durable message admission: one canonical task per message, replay on
 * duplicates (including concurrent sends and lost acknowledgements), and safe
 * conflicts for a reused message id with a different payload.
 */

let pool: Pool;
let pools: WorkerPools;
let mcpHost: ChildProcess;
let agent: ChildProcess;
let seeded: SeededSnapshot & { delegationId: string };

async function send(message: ReturnType<typeof flightDataMessage>): Promise<Task> {
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

describe("message deduplication", () => {
  it("executes one canonical message exactly once across concurrent sends", async () => {
    const delegationId = await createFlightDelegation(pool, seeded);
    const message = flightDataMessage(
      flightTaskRequestData({
        tripId: seeded.tripId,
        operationId: seeded.operationId,
        delegationId,
        snapshotId: seeded.snapshotId,
        scenarioKey: "seeded",
      }),
    );
    const [a, b] = await Promise.all([send(message), send(message)]);
    expect(a.id).toBe(b.id);
    const rows = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM odft_app.protocol_inbound_messages
        WHERE agent_identity = 'flight-agent' AND message_id = $1`,
      [message.messageId],
    );
    expect(rows.rows[0]?.count).toBe("1");
    const control = await pool.query<{ state: string }>(
      `SELECT state FROM odft_app.protocol_task_control
        WHERE agent_identity = 'flight-agent' AND task_id = $1`,
      [a.id],
    );
    expect(control.rows[0]?.state).toBe("completed");
  }, 60_000);

  it("replays a lost acknowledgement without a second execution", async () => {
    const delegationId = await createFlightDelegation(pool, seeded);
    const message = flightDataMessage(
      flightTaskRequestData({
        tripId: seeded.tripId,
        operationId: seeded.operationId,
        delegationId,
        snapshotId: seeded.snapshotId,
        scenarioKey: "seeded",
      }),
    );
    const first = await send(message);
    const replay = await send(message);
    expect(replay.id).toBe(first.id);
    expect(replay.artifacts[0]?.artifactId).toBe(first.artifacts[0]?.artifactId);
    expect(replay.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  }, 60_000);

  it("rejects a reused message id with a different payload", async () => {
    const delegationId = await createFlightDelegation(pool, seeded);
    const request = flightTaskRequestData({
      tripId: seeded.tripId,
      operationId: seeded.operationId,
      delegationId,
      snapshotId: seeded.snapshotId,
      scenarioKey: "seeded",
    });
    const message = flightDataMessage(request);
    await send(message);
    const conflicting = flightDataMessage(
      flightTaskRequestData({
        tripId: seeded.tripId,
        operationId: seeded.operationId,
        delegationId,
        snapshotId: seeded.snapshotId,
        scenarioKey: "seeded",
        inputFingerprint: "f".repeat(64),
      }),
    );
    conflicting.messageId = message.messageId;
    await expect(send(conflicting)).rejects.toThrow(/already admitted with a different payload/);
  }, 60_000);
});
