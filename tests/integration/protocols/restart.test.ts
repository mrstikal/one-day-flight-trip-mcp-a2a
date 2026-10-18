import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskState, type Task } from "@a2a-js/sdk";
import { claimNextOperation, admitResume } from "@odft/persistence";
import { A2AClient } from "@odft/protocols";
import {
  createFlightDelegation,
  flightAgentClientConfig,
  flightDataMessage,
  flightTaskRequestData,
  startFlightAgent,
  stopFlightAgent,
  waitForFlightAgent,
} from "../a2a/_setup.js";
import {
  accommodationAgentClientConfig,
  createAccommodationDelegation,
  dataMessage,
  agentTaskRequestData,
  startAccommodationAgent,
  startCityGuideAgent,
  stopAgent,
  waitForAgentReady,
} from "../a2a/_setup-agents.js";
import { seedDelegatedSnapshot, type SeededSnapshot } from "../mcp/_setup.js";
import {
  claimCoordinator,
  coordinatorDriver,
  createCoordinatorTrip,
  driveUntilParked,
  startCoordinatorHarness,
  stopCoordinatorHarness,
  type CoordinatorHarness,
} from "../coordinator/_setup.js";

/**
 * Phase 10 independent restarts (plan §3.13, scenarios D/E/F):
 * - each agent process can be restarted alone; startup reconciliation turns an
 *   interrupted task into AGENT_RESTARTED and a new task succeeds;
 * - a coordinator claim that dies before work is re-claimed after its lease
 *   expires and completes the same operation exactly once.
 */

let harness: CoordinatorHarness;
let seeded: SeededSnapshot;
let restartedFlight: ChildProcess | undefined;
let restartedAccommodation: ChildProcess | undefined;
let slowCityGuide: ChildProcess | undefined;

function statusText(task: Task): string {
  const part = task.status?.message?.parts?.[0]?.content;
  return part?.$case === "text" ? part.value : "";
}

async function waitForDb<T>(
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForExit(child: ChildProcess, timeoutMs = 20_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("process did not exit")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function sendFlightCompleted(data: unknown): Promise<Task> {
  const client = new A2AClient({ config: flightAgentClientConfig() });
  const result = await client.sendMessage("flight-agent", {
    message: flightDataMessage(data),
    tenant: "",
    configuration: undefined,
    metadata: undefined,
  });
  if (!("status" in result)) {
    throw new Error("expected a task result");
  }
  return result as Task;
}

async function sendAccommodationCompleted(data: unknown): Promise<Task> {
  const client = new A2AClient({ config: accommodationAgentClientConfig() });
  const result = await client.sendMessage("accommodation-agent", {
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

async function sendFlightInterrupted(data: unknown): Promise<string> {
  const messageId = randomUUID();
  const client = new A2AClient({ config: flightAgentClientConfig() });
  await client
    .sendMessage("flight-agent", {
      message: { ...flightDataMessage(data), messageId },
      tenant: "",
      configuration: undefined,
      metadata: undefined,
    })
    .catch(() => undefined);
  const row = await harness.pool.query<{ task_id: string | null }>(
    `SELECT task_id FROM odft_app.protocol_inbound_messages
      WHERE agent_identity = 'flight-agent' AND message_id = $1`,
    [messageId],
  );
  const taskId = row.rows[0]?.task_id;
  if (!taskId) {
    throw new Error("the flight task was not admitted before the crash");
  }
  return taskId;
}

async function sendAccommodationInterrupted(data: unknown): Promise<string> {
  const messageId = randomUUID();
  const client = new A2AClient({ config: accommodationAgentClientConfig() });
  await client
    .sendMessage("accommodation-agent", {
      message: { ...dataMessage(data), messageId },
      tenant: "",
      configuration: undefined,
      metadata: undefined,
    })
    .catch(() => undefined);
  const row = await harness.pool.query<{ task_id: string | null }>(
    `SELECT task_id FROM odft_app.protocol_inbound_messages
      WHERE agent_identity = 'accommodation-agent' AND message_id = $1`,
    [messageId],
  );
  const taskId = row.rows[0]?.task_id;
  if (!taskId) {
    throw new Error("the accommodation task was not admitted before the crash");
  }
  return taskId;
}

beforeAll(async () => {
  harness = await startCoordinatorHarness();
  seeded = await seedDelegatedSnapshot(harness.pool, harness.pools);
}, 240_000);

afterAll(async () => {
  if (slowCityGuide) {
    await stopAgent(slowCityGuide);
  }
  if (restartedFlight) {
    await stopFlightAgent(restartedFlight);
  }
  if (restartedAccommodation) {
    await stopAgent(restartedAccommodation);
  }
  await stopCoordinatorHarness(harness);
});

describe("independent restarts", () => {
  it("restarts the Flight Agent alone and fails only the interrupted task", async () => {
    await stopFlightAgent(harness.flightAgent);
    const crashing = startFlightAgent({ ODFT_FLIGHT_AGENT_CRASH: "1" });
    await waitForFlightAgent(crashing);
    const delegationId = await createFlightDelegation(harness.pool, seeded);
    const interruptedTaskId = await sendFlightInterrupted(
      flightTaskRequestData({
        tripId: seeded.tripId,
        operationId: seeded.operationId,
        delegationId,
        snapshotId: seeded.snapshotId,
        scenarioKey: "seeded",
      }),
    );
    // The crash hook exits the process after admission; the HTTP call may fail
    // or return the admitted task. Wait for the exit, then restart.
    await waitForExit(crashing);
    const restarted = startFlightAgent();
    restartedFlight = restarted;
    await waitForFlightAgent(restarted);
    const client = new A2AClient({ config: flightAgentClientConfig() });
    const reconciled = await client.getTask("flight-agent", {
      id: interruptedTaskId,
      tenant: "",
    });
    expect(reconciled.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(statusText(reconciled as Task)).toMatch(/^AGENT_RESTARTED:/);

    const freshDelegation = await createFlightDelegation(harness.pool, seeded);
    const fresh = await sendFlightCompleted(
      flightTaskRequestData({
        tripId: seeded.tripId,
        operationId: seeded.operationId,
        delegationId: freshDelegation,
        snapshotId: seeded.snapshotId,
        scenarioKey: "seeded",
      }),
    );
    expect(fresh.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  }, 180_000);

  it("restarts the Accommodation Agent alone and fails only the interrupted task", async () => {
    await stopAgent(harness.accommodationAgent);
    const crashing = startAccommodationAgent({ ODFT_ACCOMMODATION_AGENT_CRASH: "1" });
    await waitForAgentReady(crashing, "accommodation-agent");
    const delegationId = await createAccommodationDelegation(harness.pool, seeded);
    const interruptedTaskId = await sendAccommodationInterrupted(
      agentTaskRequestData({
        skillId: "accommodation.recommend.v1",
        tripId: seeded.tripId,
        operationId: seeded.operationId,
        delegationId,
        snapshotId: seeded.snapshotId,
        scenarioKey: "seeded",
        requestedDomains: ["hotel"],
      }),
    );
    await waitForExit(crashing);
    const restarted = startAccommodationAgent();
    restartedAccommodation = restarted;
    await waitForAgentReady(restarted, "accommodation-agent");
    const client = new A2AClient({ config: accommodationAgentClientConfig() });
    const reconciled = await client.getTask("accommodation-agent", {
      id: interruptedTaskId,
      tenant: "",
    });
    expect(reconciled.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(statusText(reconciled as Task)).toMatch(/^AGENT_RESTARTED:/);

    const freshDelegation = await createAccommodationDelegation(harness.pool, seeded);
    const fresh = await sendAccommodationCompleted(
      agentTaskRequestData({
        skillId: "accommodation.recommend.v1",
        tripId: seeded.tripId,
        operationId: seeded.operationId,
        delegationId: freshDelegation,
        snapshotId: seeded.snapshotId,
        scenarioKey: "seeded",
        requestedDomains: ["hotel"],
      }),
    );
    expect(fresh.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  }, 180_000);

  it("re-claims a coordinator operation after a claim dies before work, exactly once", async () => {
    const { tripId, sessionId } = await createCoordinatorTrip(harness.pool);
    const flightPark = await driveUntilParked(harness.pools, tripId);
    expect(flightPark?.waitReason).toBe("flight_choice");
    const decision = await harness.pool.query<{ id: string; allowed_offer_ids: string[] }>(
      `SELECT id, allowed_offer_ids FROM odft_app.pending_decisions
        WHERE trip_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    );
    const flightDecision = decision.rows[0];
    if (!flightDecision) {
      throw new Error("no pending flight choice");
    }
    const admitted = await admitResume(harness.pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        decisionId: flightDecision.id,
        expectedRevision: 1,
        response: {
          action: "choose_offer",
          offerId: flightDecision.allowed_offer_ids[0],
        } as never,
      },
    });
    if (!("operationId" in admitted)) {
      throw new Error(`admitResume refused: ${JSON.stringify(admitted)}`);
    }
    // Claim with a 1ms lease and never run the driver: this is the coordinator
    // crash after claim, before work. The next claim after expiry must execute.
    const deadClaim = await claimNextOperation(harness.pool, {
      workerId: "dead-coordinator",
      leaseMs: 1,
      engines: ["coordinator-v1"],
    });
    expect(deadClaim?.operationId).toBe(admitted.operationId);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const parked = await driveUntilParked(harness.pools, tripId, 8);
    expect(parked?.waitReason).toBe("booking_confirmation");
    // Exactly one pending booking confirmation: no duplicate decision/proposal.
    const confirmations = await harness.pool.query(
      `SELECT id FROM odft_app.pending_decisions
        WHERE trip_id = $1 AND kind = 'booking_confirmation' AND status = 'pending'`,
      [tripId],
    );
    expect(confirmations.rowCount).toBe(1);
    const proposals = await harness.pool.query(
      `SELECT id FROM odft_app.selection_proposals WHERE trip_id = $1`,
      [tripId],
    );
    expect(proposals.rowCount).toBe(1);
  }, 180_000);

  it("promotes a queued hotel question only after a working City Guide sibling drains across a coordinator restart", async () => {
    await stopAgent(harness.cityGuideAgent);
    slowCityGuide = startCityGuideAgent({ ODFT_CITY_GUIDE_AGENT_STEP_DELAY_MS: "2000" });
    await waitForAgentReady(slowCityGuide, "city-guide-agent");

    const { tripId, sessionId } = await createCoordinatorTrip(harness.pool);
    const flightPark = await driveUntilParked(harness.pools, tripId);
    expect(flightPark?.waitReason).toBe("flight_choice");
    const flightDecision = await waitForDb(
      async () => {
        const result = await harness.pool.query<{
          id: string;
          allowed_offer_ids: string[];
        }>(
          `SELECT id, allowed_offer_ids FROM odft_app.pending_decisions
            WHERE trip_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
          [tripId],
        );
        return result.rows[0];
      },
      30_000,
      "the flight choice",
    );
    const admittedFlight = await admitResume(harness.pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        decisionId: flightDecision.id,
        expectedRevision: 1,
        response: {
          action: "choose_offer",
          offerId: flightDecision.allowed_offer_ids[0],
        } as never,
      },
    });
    expect("operationId" in admittedFlight).toBe(true);
    const bookingPark = await driveUntilParked(harness.pools, tripId, 6, {
      hotelObjective: "cheaper",
    });
    expect(bookingPark?.waitReason).toBe("booking_confirmation");
    const booking = await waitForDb(
      async () => {
        const result = await harness.pool.query<{ id: string; proposal_id: string }>(
          `SELECT id, proposal_id FROM odft_app.pending_decisions
            WHERE trip_id = $1 AND kind = 'booking_confirmation' AND status = 'pending'
            ORDER BY created_at DESC LIMIT 1`,
          [tripId],
        );
        return result.rows[0];
      },
      30_000,
      "the booking confirmation",
    );
    const admittedBooking = await admitResume(harness.pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        decisionId: booking.id,
        expectedRevision: 1,
        response: {
          action: "confirm_booking",
          proposalId: booking.proposal_id,
          acceptedDemoDisclaimer: true,
        } as never,
      },
    });
    expect("operationId" in admittedBooking).toBe(true);

    // First claim: the hotel asks its question, the City Guide is still working,
    // and the short wait abandons the claim (simulated coordinator restart).
    const claim = await claimCoordinator(harness.pools);
    if (!claim) {
      throw new Error("no coordinator claim for research");
    }
    await coordinatorDriver(harness.pools, {
      hotelObjective: "cheaper",
      delegationWaitMs: 500,
    }).runOperation(claim);
    // The abandoned claim's lease must expire before the restarted claim can
    // resume the same operation (the worker would do this by lease timeout).
    await harness.pools.operations.query(
      `UPDATE odft_app.workflow_operations
          SET lease_expires_at = now() - interval '1 second'
        WHERE id = $1 AND status = 'running'`,
      [claim.operationId],
    );
    const runAfterAbandon = await harness.pool.query<{
      status: string;
      step: string;
      run_data: { questionQueue?: unknown[] };
    }>(
      `SELECT status, step, run_data FROM odft_app.coordinator_runs
        WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    );
    expect(runAfterAbandon.rows[0]?.status).toBe("running");
    expect(runAfterAbandon.rows[0]?.step).toBe("researching");
    expect(runAfterAbandon.rows[0]?.run_data.questionQueue).toHaveLength(1);
    const promotedEarly = await harness.pool.query(
      `SELECT 1 FROM odft_app.pending_decisions
        WHERE trip_id = $1 AND kind = 'agent_input'`,
      [tripId],
    );
    expect(promotedEarly.rowCount).toBe(0);
    const hotelBefore = await harness.pool.query<{ task_id: string }>(
      `SELECT task_id FROM odft_app.agent_delegations
        WHERE trip_id = $1 AND skill_id = 'accommodation.recommend.v1'`,
      [tripId],
    );
    const hotelTaskId = hotelBefore.rows[0]?.task_id;
    expect(hotelTaskId).toBeTruthy();

    // The slow City Guide finishes while no claim is active; the next claim
    // drains it and only then promotes the queued question. The delegation row
    // is coordinator-owned, so wait for the AGENT task state instead.
    const cityTask = await harness.pool.query<{ task_id: string }>(
      `SELECT task_id FROM odft_app.agent_delegations
        WHERE trip_id = $1 AND skill_id = 'city-guide.research.v1'`,
      [tripId],
    );
    const cityTaskId = cityTask.rows[0]?.task_id;
    if (!cityTaskId) {
      throw new Error("the City Guide task was not admitted");
    }
    await waitForDb(
      async () => {
        const result = await harness.pool.query<{ state: string }>(
          `SELECT state FROM odft_app.protocol_task_control
            WHERE agent_identity = 'city-guide-agent' AND task_id = $1`,
          [cityTaskId],
        );
        return result.rows[0]?.state === "completed" ? result.rows[0] : undefined;
      },
      30_000,
      "the slow City Guide completion",
    );
    const parked = await driveUntilParked(harness.pools, tripId, 8, {
      hotelObjective: "cheaper",
    });
    expect(parked?.waitReason).toBe("agent_input");
    const question = await waitForDb(
      async () => {
        const result = await harness.pool.query<{
          id: string;
          allowed_option_ids: string[];
        }>(
          `SELECT id, allowed_option_ids FROM odft_app.pending_decisions
            WHERE trip_id = $1 AND kind = 'agent_input' AND status = 'pending'
            ORDER BY created_at DESC LIMIT 1`,
          [tripId],
        );
        return result.rows[0];
      },
      30_000,
      "the promoted hotel question",
    );
    const revision = await harness.pool.query<{ revision: number }>(
      `SELECT revision FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    expect(revision.rows[0]?.revision).toBe(1);
    const hotelAfter = await harness.pool.query<{ task_id: string; status: string }>(
      `SELECT task_id, status FROM odft_app.agent_delegations
        WHERE trip_id = $1 AND skill_id = 'accommodation.recommend.v1'`,
      [tripId],
    );
    expect(hotelAfter.rows[0]?.task_id).toBe(hotelTaskId);
    const hotelControl = await harness.pool.query<{ state: string }>(
      `SELECT state FROM odft_app.protocol_task_control
        WHERE agent_identity = 'accommodation-agent' AND task_id = $1`,
      [hotelTaskId],
    );
    expect(hotelControl.rows[0]?.state).toBe("input_required");

    const answered = await admitResume(harness.pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        decisionId: question.id,
        expectedRevision: 1,
        response: {
          action: "choose_option",
          optionId: question.allowed_option_ids[0],
        } as never,
      },
    });
    expect("operationId" in answered).toBe(true);
    const hotelPark = await driveUntilParked(harness.pools, tripId, 8, {
      hotelObjective: "cheaper",
    });
    expect(hotelPark?.waitReason).toBe("hotel_choice");
    const city = await harness.pool.query(
      `SELECT id FROM odft_app.agent_delegations
        WHERE trip_id = $1 AND skill_id = 'city-guide.research.v1'`,
      [tripId],
    );
    expect(city.rowCount).toBe(1);
  }, 300_000);
});
