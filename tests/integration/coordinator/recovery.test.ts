import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  admitResume,
  getActiveCoordinatorRun,
  getAgentDelegation,
  retryOperation,
} from "@odft/persistence";
import { runCoordinatorOperation } from "@odft/workflow";
import { createA2ADelegationTransport } from "../../../apps/worker/src/coordinator-transport.js";
import { createTravelPortsFactory } from "../../../apps/worker/src/travel/ports.js";
import { createTestAiService } from "../_setup.js";
import { startAccommodationAgent, stopAgent, waitForAgentReady } from "../a2a/_setup-agents.js";
import {
  claimCoordinator,
  coordinatorClientConfigForTest,
  coordinatorDriver,
  createCoordinatorTrip,
  driveUntilParked,
  startCoordinatorHarness,
  stopCoordinatorHarness,
  type CoordinatorHarness,
} from "./_setup.js";

/**
 * Phase 07 coordinator recovery (plan §3.14): a research operation that abandons
 * before the specialist finishes is resumed from the SAVED task by a later claim
 * (no repeated paid work, no second message), and a lost delivery
 * acknowledgement is re-delivered from the persisted outbound payload.
 */

let harness: CoordinatorHarness;

function specialistAgents() {
  return {
    flight: {
      agentIdentity: "flight-agent",
      endpointUrl: "http://127.0.0.1:4431",
      skillId: "flight.recommend.v1",
      cardVersion: "",
    },
    accommodation: {
      agentIdentity: "accommodation-agent",
      endpointUrl: "http://127.0.0.1:4432",
      skillId: "accommodation.recommend.v1",
      cardVersion: "",
    },
    cityGuide: {
      agentIdentity: "city-guide-agent",
      endpointUrl: "http://127.0.0.1:4433",
      skillId: "city-guide.research.v1",
      cardVersion: "",
    },
  };
}

/** Run one claim with a tiny delegation wait so the driver abandons mid-work. */
async function claimAndAbandon(tripId: string): Promise<string> {
  const claim = await claimCoordinator(harness.pools);
  if (!claim) {
    throw new Error("no claimable coordinator operation");
  }
  const portsFactory = createTravelPortsFactory(
    harness.pools.operations,
    createTestAiService(harness.pools),
  );
  await runCoordinatorOperation(
    {
      pool: harness.pools.operations,
      transport: createA2ADelegationTransport(coordinatorClientConfigForTest()),
      ports: portsFactory({
        operationId: claim.operationId,
        tripId,
        fencingToken: claim.fencingToken,
      }) as never,
      agents: specialistAgents(),
      delegationWaitMs: 1,
    },
    claim,
  );
  return claim.operationId;
}

async function expireLease(operationId: string): Promise<void> {
  await harness.pools.operations.query(
    `UPDATE odft_app.workflow_operations SET lease_expires_at = now() - interval '1 second'
      WHERE id = $1 AND status = 'running'`,
    [operationId],
  );
}

beforeAll(async () => {
  harness = await startCoordinatorHarness();
}, 180_000);

let restartedAccommodation: ChildProcess | undefined;

async function waitForProcessExit(child: ChildProcess, timeoutMs = 20_000): Promise<void> {
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

afterAll(async () => {
  if (restartedAccommodation) {
    await stopAgent(restartedAccommodation);
  }
  await stopCoordinatorHarness(harness);
});

describe("coordinator recovery", () => {
  it("resumes a research operation from the saved specialist task after an abandoned claim", async () => {
    const { tripId } = await createCoordinatorTrip(harness.pool);
    const operationId = await claimAndAbandon(tripId);
    const afterFirst = await getActiveCoordinatorRun(harness.pools.operations, tripId);
    expect(afterFirst?.status === "running" || afterFirst?.status === "waiting").toBe(true);

    const before = await harness.pool.query<{ id: string; task_id: string | null; count: string }>(
      `SELECT d.id, d.task_id, (SELECT count(*)::text FROM odft_app.protocol_outbound_messages om
          WHERE om.delegation_id = d.id) AS count
         FROM odft_app.agent_delegations d WHERE d.trip_id = $1`,
      [tripId],
    );
    const savedTaskId = before.rows[0]?.task_id as string;
    expect(savedTaskId).toBeTruthy();
    expect(before.rows[0]?.count).toBe("1");

    await expireLease(operationId);
    const parked = await driveUntilParked(harness.pools, tripId, 4);
    expect(parked?.waitReason).toBe("flight_choice");

    const after = await harness.pool.query<{ task_id: string | null; count: string }>(
      `SELECT d.task_id, (SELECT count(*)::text FROM odft_app.protocol_outbound_messages om
          WHERE om.delegation_id = d.id) AS count
         FROM odft_app.agent_delegations d WHERE d.trip_id = $1`,
      [tripId],
    );
    // The SAME saved task supplied the artifact and no second message was built.
    expect(after.rows[0]?.task_id).toBe(savedTaskId);
    expect(after.rows[0]?.count).toBe("1");
  }, 240_000);

  it("re-delivers from the persisted outbound payload when the acknowledgement was lost", async () => {
    const { tripId } = await createCoordinatorTrip(harness.pool);
    // First claim: the transport is DOWN, so the persisted outbound intent gets
    // no acknowledgement and the operation abandons at the research step.
    const claim = await claimCoordinator(harness.pools);
    if (!claim) {
      throw new Error("no claimable coordinator operation");
    }
    const portsFactory = createTravelPortsFactory(
      harness.pools.operations,
      createTestAiService(harness.pools),
    );
    const realTransport = createA2ADelegationTransport(coordinatorClientConfigForTest());
    await runCoordinatorOperation(
      {
        pool: harness.pools.operations,
        transport: {
          sendTask: async () => {
            throw new Error("simulated transport outage");
          },
          getTask: realTransport.getTask,
          cancelTask: realTransport.cancelTask,
        },
        ports: portsFactory({
          operationId: claim.operationId,
          tripId,
          fencingToken: claim.fencingToken,
        }) as never,
        agents: specialistAgents(),
        delegationWaitMs: 1,
      },
      claim,
    );

    const before = await harness.pool.query<{
      id: string;
      payload_hash: string;
      delivery_state: string;
    }>(
      `SELECT d.id, om.payload_hash, om.delivery_state
         FROM odft_app.agent_delegations d
         JOIN odft_app.protocol_outbound_messages om ON om.delegation_id = d.id
        WHERE d.trip_id = $1 ORDER BY d.created_at ASC LIMIT 1`,
      [tripId],
    );
    const delegationId = before.rows[0]?.id as string;
    const hashBefore = before.rows[0]?.payload_hash as string;
    expect(before.rows[0]?.delivery_state).toBe("failed");

    // A later claim with a healthy transport re-delivers the SAME persisted
    // payload (same message identity) and completes the flight research.
    await expireLease(claim.operationId);
    const parked = await driveUntilParked(harness.pools, tripId, 4);
    expect(parked?.waitReason).toBe("flight_choice");

    const after = await harness.pool.query<{ payload_hash: string; delivery_state: string }>(
      `SELECT payload_hash, delivery_state FROM odft_app.protocol_outbound_messages
        WHERE delegation_id = $1`,
      [delegationId],
    );
    expect(after.rows[0]?.payload_hash).toBe(hashBefore);
    expect(after.rows[0]?.delivery_state).toBe("acknowledged");
    const record = await getAgentDelegation(harness.pool, delegationId);
    expect(record?.status).toBe("completed");
    expect(record?.taskId).not.toBeNull();
  }, 240_000);

  it("replays a booking committed before the cursor advance exactly once", async () => {
    const { tripId, sessionId } = await createCoordinatorTrip(harness.pool);
    const flightPark = await driveUntilParked(harness.pools, tripId);
    expect(flightPark?.waitReason).toBe("flight_choice");
    const flightDecision = await harness.pool.query<{
      id: string;
      allowed_offer_ids: string[];
    }>(
      `SELECT id, allowed_offer_ids FROM odft_app.pending_decisions
        WHERE trip_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    );
    const flightChoice = flightDecision.rows[0];
    if (!flightChoice) {
      throw new Error("no pending flight choice");
    }
    const admittedChoice = await admitResume(harness.pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        decisionId: flightChoice.id,
        expectedRevision: 1,
        response: {
          action: "choose_offer",
          offerId: flightChoice.allowed_offer_ids[0],
        } as never,
      },
    });
    if (!("operationId" in admittedChoice)) {
      throw new Error("flight choice was not admitted");
    }
    const bookingPark = await driveUntilParked(harness.pools, tripId);
    expect(bookingPark?.waitReason).toBe("booking_confirmation");
    const bookingDecision = await harness.pool.query<{
      id: string;
      proposal_id: string;
    }>(
      `SELECT id, proposal_id FROM odft_app.pending_decisions
        WHERE trip_id = $1 AND kind = 'booking_confirmation' AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    );
    const booking = bookingDecision.rows[0];
    if (!booking?.proposal_id) {
      throw new Error("no pending booking confirmation");
    }
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
    if (!("operationId" in admittedBooking)) {
      throw new Error("booking confirmation was not admitted");
    }

    // Claim and run the operation with a ports wrapper that throws AFTER the
    // booking effect committed: this is the crash-before-cursor kill point.
    const claim = await claimCoordinator(harness.pools);
    if (!claim || claim.operationId !== admittedBooking.operationId) {
      throw new Error("the booking operation was not claimable");
    }
    const portsFactory = createTravelPortsFactory(
      harness.pools.operations,
      createTestAiService(harness.pools),
    );
    const ports = portsFactory({
      operationId: claim.operationId,
      tripId,
      fencingToken: claim.fencingToken,
    });
    const failingPorts = {
      ...ports,
      confirm: async (input: Parameters<typeof ports.confirm>[0]) => {
        await ports.confirm(input);
        throw new Error("simulated crash after the booking commit");
      },
    };
    await runCoordinatorOperation(
      {
        pool: harness.pools.operations,
        transport: createA2ADelegationTransport(coordinatorClientConfigForTest()),
        ports: failingPorts as never,
        agents: specialistAgents(),
        delegationWaitMs: 30_000,
      },
      claim,
    ).catch(() => undefined);
    await expireLease(claim.operationId);

    // The replay must reuse the committed reservation and continue into hotel
    // research instead of charging/booking a second flight.
    const resumed = await driveUntilParked(harness.pools, tripId, 8);
    expect(resumed?.waitReason).toBe("hotel_choice");
    const reservations = await harness.pool.query<{ service_key: string }>(
      `SELECT service_key FROM odft_app.reservations
        WHERE trip_id = $1 AND status = 'confirmed'`,
      [tripId],
    );
    expect(reservations.rows.filter((row) => row.service_key === "flights")).toHaveLength(1);
    const proposals = await harness.pool.query<{ service_key: string; status: string }>(
      `SELECT service_key, status FROM odft_app.selection_proposals WHERE trip_id = $1`,
      [tripId],
    );
    expect(proposals.rows.filter((row) => row.service_key === "flights")).toHaveLength(1);
  }, 300_000);

  it("replays a declined booking committed before the cursor advance", async () => {
    const { tripId, sessionId } = await createCoordinatorTrip(harness.pool);
    const flightPark = await driveUntilParked(harness.pools, tripId);
    expect(flightPark?.waitReason).toBe("flight_choice");
    const flightDecision = await harness.pool.query<{
      id: string;
      allowed_offer_ids: string[];
    }>(
      `SELECT id, allowed_offer_ids FROM odft_app.pending_decisions
        WHERE trip_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    );
    const flight = flightDecision.rows[0];
    if (!flight) {
      throw new Error("no pending flight choice");
    }
    await admitResume(harness.pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        decisionId: flight.id,
        expectedRevision: 1,
        response: { action: "choose_offer", offerId: flight.allowed_offer_ids[0] } as never,
      },
    });
    const bookingPark = await driveUntilParked(harness.pools, tripId);
    expect(bookingPark?.waitReason).toBe("booking_confirmation");
    const booking = await harness.pool.query<{ id: string; proposal_id: string }>(
      `SELECT id, proposal_id FROM odft_app.pending_decisions
        WHERE trip_id = $1 AND kind = 'booking_confirmation' AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    );
    const bookingDecision = booking.rows[0];
    if (!bookingDecision?.proposal_id) {
      throw new Error("no pending booking confirmation");
    }
    const admitted = await admitResume(harness.pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        decisionId: bookingDecision.id,
        expectedRevision: 1,
        response: {
          action: "decline_booking",
          proposalId: bookingDecision.proposal_id,
        } as never,
      },
    });
    if (!("operationId" in admitted)) {
      throw new Error("decline was not admitted");
    }
    const claim = await claimCoordinator(harness.pools);
    if (!claim || claim.operationId !== admitted.operationId) {
      throw new Error("the decline operation was not claimable");
    }
    const portsFactory = createTravelPortsFactory(
      harness.pools.operations,
      createTestAiService(harness.pools),
    );
    const ports = portsFactory({
      operationId: claim.operationId,
      tripId,
      fencingToken: claim.fencingToken,
    });
    const failingPorts = {
      ...ports,
      declineBooking: async (input: Parameters<typeof ports.declineBooking>[0]) => {
        await ports.declineBooking(input);
        throw new Error("simulated crash after the decline commit");
      },
    };
    await runCoordinatorOperation(
      {
        pool: harness.pools.operations,
        transport: createA2ADelegationTransport(coordinatorClientConfigForTest()),
        ports: failingPorts as never,
        agents: specialistAgents(),
        delegationWaitMs: 30_000,
      },
      claim,
    ).catch(() => undefined);
    await expireLease(claim.operationId);

    const resumed = await driveUntilParked(harness.pools, tripId, 8);
    expect(resumed?.waitReason).toBe("hotel_choice");
    const reservations = await harness.pool.query(
      `SELECT 1 FROM odft_app.reservations
        WHERE trip_id = $1 AND service_key = 'flights' AND status = 'confirmed'`,
      [tripId],
    );
    expect(reservations.rowCount).toBe(0);
    const selections = await harness.pool.query(
      `SELECT 1 FROM odft_app.trip_selections
        WHERE trip_id = $1 AND service_key = 'flights'`,
      [tripId],
    );
    expect(selections.rowCount).toBe(1);
    const effect = await harness.pool.query(
      `SELECT 1 FROM odft_app.workflow_effects
        WHERE operation_id = $1 AND node_name = 'decline_booking'`,
      [admitted.operationId],
    );
    expect(effect.rowCount).toBe(1);
  }, 300_000);

  it("parks flight_choice from a completed flight delegation after a crash before the park", async () => {
    const { tripId } = await createCoordinatorTrip(harness.pool);
    const parked = await driveUntilParked(harness.pools, tripId);
    expect(parked?.waitReason).toBe("flight_choice");
    const flight = await harness.pool.query<{ id: string }>(
      `SELECT id FROM odft_app.agent_delegations
        WHERE trip_id = $1 AND skill_id = 'flight.recommend.v1'`,
      [tripId],
    );
    const flightDelegationId = flight.rows[0]?.id;
    if (!flightDelegationId) {
      throw new Error("no completed flight delegation");
    }
    const run = await harness.pool.query<{ id: string; operation_id: string }>(
      `SELECT id, operation_id FROM odft_app.coordinator_runs WHERE trip_id = $1`,
      [tripId],
    );
    const runRow = run.rows[0];
    if (!runRow) {
      throw new Error("no coordinator run");
    }
    // Simulate the crash window: the flight artifact was accepted, but the
    // cursor never parked flight_choice. Put the saved run back into
    // researching with ONLY the completed flight delegation.
    await harness.pool.query(
      `UPDATE odft_app.pending_decisions SET status = 'cancelled'
        WHERE trip_id = $1 AND status = 'pending'`,
      [tripId],
    );
    await harness.pool.query(
      `UPDATE odft_app.coordinator_runs
          SET status = 'running', step = 'researching', wait_reason = NULL,
              run_data = jsonb_set(
                jsonb_set(run_data, '{delegationIds}', $1::jsonb),
                '{questionQueue}', '[]'::jsonb
              )
        WHERE id = $2`,
      [JSON.stringify([flightDelegationId]), runRow.id],
    );
    await harness.pool.query(
      `UPDATE odft_app.workflow_operations
          SET status = 'queued', lease_expires_at = NULL
        WHERE id = $1`,
      [runRow.operation_id],
    );
    const reparks = await driveUntilParked(harness.pools, tripId, 4);
    expect(reparks?.waitReason).toBe("flight_choice");
    const decision = await harness.pool.query(
      `SELECT 1 FROM odft_app.pending_decisions
        WHERE trip_id = $1 AND kind = 'flight_choice' AND status = 'pending'`,
      [tripId],
    );
    expect(decision.rowCount).toBe(1);
  }, 180_000);

  it("reopens a failed run on owner retry and re-dispatches only the failed hotel domain", async () => {
    // Replace the healthy accommodation process with one that crashes after
    // admission. The City Guide sibling completes and must survive the retry.
    await stopAgent(harness.accommodationAgent);
    const crashing = startAccommodationAgent({ ODFT_ACCOMMODATION_AGENT_CRASH: "1" });
    await waitForAgentReady(crashing, "accommodation-agent");

    const { tripId, sessionId } = await createCoordinatorTrip(harness.pool);
    const flightPark = await driveUntilParked(harness.pools, tripId);
    expect(flightPark?.waitReason).toBe("flight_choice");
    const flightChoice = await harness.pool.query<{
      id: string;
      allowed_offer_ids: string[];
    }>(
      `SELECT id, allowed_offer_ids FROM odft_app.pending_decisions
        WHERE trip_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    );
    const flight = flightChoice.rows[0];
    if (!flight) {
      throw new Error("no pending flight choice");
    }
    await admitResume(harness.pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        decisionId: flight.id,
        expectedRevision: 1,
        response: { action: "choose_offer", offerId: flight.allowed_offer_ids[0] } as never,
      },
    });
    const bookingPark = await driveUntilParked(harness.pools, tripId);
    expect(bookingPark?.waitReason).toBe("booking_confirmation");
    const booking = await harness.pool.query<{ id: string; proposal_id: string }>(
      `SELECT id, proposal_id FROM odft_app.pending_decisions
        WHERE trip_id = $1 AND kind = 'booking_confirmation' AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    );
    const bookingDecision = booking.rows[0];
    if (!bookingDecision?.proposal_id) {
      throw new Error("no pending booking confirmation");
    }
    await admitResume(harness.pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        decisionId: bookingDecision.id,
        expectedRevision: 1,
        response: {
          action: "confirm_booking",
          proposalId: bookingDecision.proposal_id,
          acceptedDemoDisclaimer: true,
        } as never,
      },
    });

    const driver = coordinatorDriver(harness.pools);
    const claim = await claimCoordinator(harness.pools);
    if (!claim) {
      throw new Error("no coordinator claim for research");
    }
    const running = driver.runOperation(claim).catch(() => undefined);
    await waitForProcessExit(crashing);
    const restarted = startAccommodationAgent();
    restartedAccommodation = restarted;
    await waitForAgentReady(restarted, "accommodation-agent");
    await running;
    // The blocking hotel failure finalizes the run as recovery-required.
    await driveUntilParked(harness.pools, tripId, 8);
    const failedRun = await harness.pool.query<{
      operation_id: string;
      status: string;
      failure_code: string | null;
    }>(
      `SELECT operation_id, status, failure_code FROM odft_app.coordinator_runs
        WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    );
    expect(failedRun.rows[0]?.status).toBe("failed");
    expect(failedRun.rows[0]?.failure_code).toBe("AGENT_RESTARTED");
    const recovery = await harness.pool.query<{ recovery_required: boolean }>(
      `SELECT recovery_required FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    expect(recovery.rows[0]?.recovery_required).toBe(true);
    const cityBefore = await harness.pool.query<{ id: string }>(
      `SELECT id FROM odft_app.agent_delegations
        WHERE trip_id = $1 AND skill_id = 'city-guide.research.v1' AND status = 'completed'`,
      [tripId],
    );
    expect(cityBefore.rowCount).toBe(1);

    const failedOperationId = failedRun.rows[0]?.operation_id;
    if (!failedOperationId) {
      throw new Error("failed run has no operation");
    }
    const retried = await retryOperation(harness.pool, {
      tripId,
      sessionId,
      operationId: failedOperationId,
      controlRequestId: randomUUID(),
      expectedRevision: 1,
    });
    if ("code" in retried) {
      throw new Error(`retry refused: ${JSON.stringify(retried)}`);
    }
    const hotelPark = await driveUntilParked(harness.pools, tripId, 10);
    expect(hotelPark?.waitReason).toBe("hotel_choice");

    const delegations = await harness.pool.query<{
      skill_id: string;
      status: string;
      id: string;
    }>(
      `SELECT skill_id, status, id FROM odft_app.agent_delegations
        WHERE trip_id = $1 ORDER BY created_at ASC`,
      [tripId],
    );
    const hotel = delegations.rows.filter((row) => row.skill_id === "accommodation.recommend.v1");
    const city = delegations.rows.filter((row) => row.skill_id === "city-guide.research.v1");
    expect(hotel.map((row) => row.status).sort()).toEqual(["completed", "failed"]);
    // The completed City Guide sibling was reused, never re-run.
    expect(city).toHaveLength(1);
    expect(city[0]?.id).toBe(cityBefore.rows[0]?.id);
    const recoveredRun = await harness.pool.query<{ status: string; wait_reason: string }>(
      `SELECT status, wait_reason FROM odft_app.coordinator_runs
        WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    );
    expect(recoveredRun.rows[0]).toMatchObject({
      status: "waiting",
      wait_reason: "hotel_choice",
    });
  }, 300_000);
});
