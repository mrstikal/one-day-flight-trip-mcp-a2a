import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getActiveCoordinatorRun, getAgentDelegation } from "@odft/persistence";
import { runCoordinatorOperation } from "@odft/workflow";
import { createA2ADelegationTransport } from "../../../apps/worker/src/coordinator-transport.js";
import { createTravelPortsFactory } from "../../../apps/worker/src/travel/ports.js";
import { createTestAiService } from "../graph/_setup.js";
import {
  claimCoordinator,
  coordinatorClientConfigForTest,
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

afterAll(async () => {
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

    const before = await harness.pool.query<{ id: string; payload_hash: string; delivery_state: string }>(
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
});
