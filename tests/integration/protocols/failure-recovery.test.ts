import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskState, type Task } from "@a2a-js/sdk";
import { admitResume } from "@odft/persistence";
import { A2AClient } from "@odft/protocols";
import {
  accommodationAgentClientConfig,
  createAccommodationDelegation,
  dataMessage,
  agentTaskRequestData,
  startCityGuideAgent,
  stopAgent,
  waitForAgentReady,
} from "../a2a/_setup-agents.js";
import {
  seedDelegatedSnapshot,
  startMcpHost,
  stopMcpHost,
  waitForHostReady,
} from "../mcp/_setup.js";
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
 * Phase 10 failure recovery (plan §3.12/§3.13, scenarios F/G/J):
 * - a real City Guide process crashes AFTER durable admission, is restarted,
 *   and startup reconciliation turns the interrupted task into AGENT_RESTARTED;
 * - the coordinator keeps the completed hotel, parks the hotel choice, and only
 *   the failed City Guide domain is re-researched (no duplicate hotel work);
 * - an MCP host outage yields an explicit MCP_UNAVAILABLE task failure, and a
 *   fresh task succeeds after the host is restarted.
 */

let harness: CoordinatorHarness;
let restartedCityGuide: ChildProcess | undefined;

async function pendingDecision(tripId: string): Promise<{
  id: string;
  kind: string;
  proposalId: string | null;
  allowedOfferIds: string[];
}> {
  const result = await harness.pool.query<{
    id: string;
    kind: string;
    proposal_id: string | null;
    allowed_offer_ids: string[];
  }>(
    `SELECT id, kind, proposal_id, allowed_offer_ids FROM odft_app.pending_decisions
      WHERE trip_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
    [tripId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("no pending decision");
  }
  return {
    id: row.id,
    kind: row.kind,
    proposalId: row.proposal_id,
    allowedOfferIds: row.allowed_offer_ids,
  };
}

async function resume(
  tripId: string,
  sessionId: string,
  decisionId: string,
  response: Record<string, unknown>,
): Promise<void> {
  const admitted = await admitResume(harness.pool, {
    tripId,
    sessionId,
    request: {
      requestId: randomUUID(),
      decisionId,
      expectedRevision: 1,
      response: response as never,
    },
  });
  if (!("operationId" in admitted)) {
    throw new Error(`admitResume refused: ${JSON.stringify(admitted)}`);
  }
}

async function waitFor<T>(
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
    await new Promise((resolve) => setTimeout(resolve, 200));
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

async function sendAccommodationTask(delegationId: string, tripId: string, operationId: string, snapshotId: string): Promise<Task> {
  const client = new A2AClient({ config: accommodationAgentClientConfig() });
  const result = await client.sendMessage("accommodation-agent", {
    message: dataMessage(
      agentTaskRequestData({
        skillId: "accommodation.recommend.v1",
        tripId,
        operationId,
        delegationId,
        snapshotId,
        scenarioKey: "seeded",
        requestedDomains: ["hotel"],
      }),
    ),
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
  harness = await startCoordinatorHarness();
}, 180_000);

afterAll(async () => {
  if (restartedCityGuide) {
    await stopAgent(restartedCityGuide);
  }
  await stopCoordinatorHarness(harness);
});

describe("failure recovery and scoped retry", () => {
  it("turns a crashed City Guide task into AGENT_RESTARTED and keeps the completed hotel", async () => {
    // Replace the healthy City Guide with a process that crashes after the
    // durable admission but before any work.
    await stopAgent(harness.cityGuideAgent);
    const crashingCityGuide = startCityGuideAgent({ ODFT_CITY_GUIDE_AGENT_CRASH: "1" });
    await waitForAgentReady(crashingCityGuide, "city-guide-agent");

    const { tripId, sessionId } = await createCoordinatorTrip(harness.pool);
    const flightPark = await driveUntilParked(harness.pools, tripId);
    expect(flightPark?.waitReason).toBe("flight_choice");
    const flightChoice = await pendingDecision(tripId);
    await resume(tripId, sessionId, flightChoice.id, {
      action: "choose_offer",
      offerId: flightChoice.allowedOfferIds[0],
    });
    const bookingPark = await driveUntilParked(harness.pools, tripId);
    expect(bookingPark?.waitReason).toBe("booking_confirmation");
    const booking = await pendingDecision(tripId);
    await resume(tripId, sessionId, booking.id, {
      action: "confirm_booking",
      proposalId: booking.proposalId,
      acceptedDemoDisclaimer: true,
    });

    // The research operation now runs in the background: the hotel succeeds,
    // the City Guide task is admitted and the process crashes.
    const driver = coordinatorDriver(harness.pools);
    const claim = await claimCoordinator(harness.pools);
    if (!claim) {
      throw new Error("no coordinator claim after booking confirmation");
    }
    const running = driver.runOperation(claim);
    // The crash hook runs AFTER durable admission: the process exits, but the
    // remote task/message row exists. The coordinator cannot bind the task id
    // because the acknowledgement was lost.
    await waitForExit(crashingCityGuide);
    const hotelBefore = await waitFor(
      async () => {
        const result = await harness.pool.query<{ status: string; id: string }>(
          `SELECT id, status FROM odft_app.agent_delegations
            WHERE trip_id = $1 AND skill_id = 'accommodation.recommend.v1'`,
          [tripId],
        );
        const row = result.rows[0];
        return row?.status === "completed" ? result.rows : undefined;
      },
      30_000,
      "the completed hotel delegation",
    );
    expect(hotelBefore.map((row) => row.status)).toEqual(["completed"]);

    // Restart the SAME agent identity: startup reconciliation marks the orphaned
    // task failed with an explicit AGENT_RESTARTED reason. The next re-delivery
    // of the SAME message id replays that canonical task and binds it.
    const restarted = startCityGuideAgent();
    restartedCityGuide = restarted;
    await waitForAgentReady(restarted, "city-guide-agent");
    const cityTask = await waitFor(
      async () => {
        const result = await harness.pool.query<{ id: string; task_id: string | null; status: string }>(
          `SELECT id, task_id, status FROM odft_app.agent_delegations
            WHERE trip_id = $1 AND skill_id = 'city-guide.research.v1'
            ORDER BY created_at DESC LIMIT 1`,
          [tripId],
        );
        return result.rows[0]?.task_id ? result.rows[0] : undefined;
      },
      30_000,
      "the city-guide task binding",
    );
    await running;
    const hotelPark = await driveUntilParked(harness.pools, tripId, 8);
    expect(hotelPark?.waitReason).toBe("hotel_choice");

    const cityAfter = await harness.pool.query<{
      id: string;
      status: string;
      task_id: string | null;
    }>(
      `SELECT id, status, task_id FROM odft_app.agent_delegations
        WHERE trip_id = $1 AND skill_id = 'city-guide.research.v1'
        ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    );
    expect(cityAfter.rows[0]?.id).toBe(cityTask.id);
    expect(cityAfter.rows[0]?.status).toBe("failed");
    const failure = await harness.pool.query<{ reason: string | null }>(
      `SELECT payload->>'reason' AS reason FROM odft_app.execution_events
        WHERE trip_id = $1 AND type = 'research.domain_finished'
          AND payload->>'status' = 'unavailable'
        ORDER BY id DESC LIMIT 1`,
      [tripId],
    );
    expect(failure.rows[0]?.reason).toContain("AGENT_RESTARTED");
    // The hotel delegation was not duplicated by the failure/restart.
    expect(hotelBefore).toHaveLength(1);

    // Confirm the hotel: only the failed City Guide domains are re-researched,
    // and the new delegation/task completes against the restarted process.
    const hotelChoice = await pendingDecision(tripId);
    expect(hotelChoice.kind).toBe("hotel_choice");
    await resume(tripId, sessionId, hotelChoice.id, {
      action: "choose_offer",
      offerId: hotelChoice.allowedOfferIds[0],
    });
    const hotelBookingPark = await driveUntilParked(harness.pools, tripId);
    expect(hotelBookingPark?.waitReason).toBe("booking_confirmation");
    const hotelBooking = await pendingDecision(tripId);
    await resume(tripId, sessionId, hotelBooking.id, {
      action: "confirm_booking",
      proposalId: hotelBooking.proposalId,
      acceptedDemoDisclaimer: true,
    });
    const programPark = await driveUntilParked(harness.pools, tripId, 10);
    expect(programPark?.waitReason).toBe("program_choices");
    const cityDelegations = await harness.pool.query<{
      id: string;
      status: string;
    }>(
      `SELECT id, status FROM odft_app.agent_delegations
        WHERE trip_id = $1 AND skill_id = 'city-guide.research.v1'
        ORDER BY created_at ASC`,
      [tripId],
    );
    expect(cityDelegations.rows).toHaveLength(2);
    expect(cityDelegations.rows[0]?.status).toBe("failed");
    expect(cityDelegations.rows[1]?.status).toBe("completed");
    expect(cityDelegations.rows[1]?.id).not.toBe(cityDelegations.rows[0]?.id);
    const hotelDelegations = await harness.pool.query(
      `SELECT id FROM odft_app.agent_delegations
        WHERE trip_id = $1 AND skill_id = 'accommodation.recommend.v1'`,
      [tripId],
    );
    expect(hotelDelegations.rowCount).toBe(1);
  }, 300_000);

  it("fails a task explicitly on MCP outage and succeeds after the host restarts", async () => {
    const seeded = await seedDelegatedSnapshot(harness.pool, harness.pools);
    // A completed control task proves the path before the outage.
    const healthyDelegation = await createAccommodationDelegation(harness.pool, seeded);
    const healthy = await sendAccommodationTask(
      healthyDelegation,
      seeded.tripId,
      seeded.operationId,
      seeded.snapshotId,
    );
    expect(healthy.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);

    await stopMcpHost(harness.mcpHost);
    const outageDelegation = await createAccommodationDelegation(harness.pool, seeded);
    const outage = await sendAccommodationTask(
      outageDelegation,
      seeded.tripId,
      seeded.operationId,
      seeded.snapshotId,
    );
    expect(outage.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    const failureText = outage.status?.message?.parts?.[0]?.content;
    expect(failureText?.$case === "text" ? failureText.value : "").toMatch(
      /^MCP_UNAVAILABLE:/,
    );

    const restartedHost = startMcpHost();
    await waitForHostReady(restartedHost);
    const recoveredDelegation = await createAccommodationDelegation(harness.pool, seeded);
    const recovered = await sendAccommodationTask(
      recoveredDelegation,
      seeded.tripId,
      seeded.operationId,
      seeded.snapshotId,
    );
    expect(recovered.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    await stopMcpHost(restartedHost);
  }, 180_000);
});
