import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskState, type Task } from "@a2a-js/sdk";
import { admitResume } from "@odft/persistence";
import { A2AClient, trustedRegistrySchema } from "@odft/protocols";
import { loadCoordinatorTransportConfig } from "../../../apps/worker/src/coordinator-transport.js";
import {
  ACCOMMODATION_AGENT_PORT,
  ACCOMMODATION_ALT_AGENT_PORT,
  ACCOMMODATION_ALT_AGENT_TOKEN,
  accommodationAgentClientConfig,
  accommodationAltAgentClientConfig,
  createAccommodationDelegation,
  dataMessage,
  agentTaskRequestData,
} from "../a2a/_setup-agents.js";
import {
  seedDelegatedSnapshot,
  type SeededSnapshot,
} from "../mcp/_setup.js";
import {
  createCoordinatorTrip,
  driveUntilParked,
  startCoordinatorHarness,
  stopCoordinatorHarness,
  type CoordinatorHarness,
} from "../coordinator/_setup.js";

/**
 * Phase 10 compatible agent replacement (plan §3.17): the SAME coordinator
 * source and public contracts work with Accommodation Agent B after an operator
 * switches the trusted registry. Tasks already bound to A keep their endpoint
 * and task table; new accommodation work goes to B only.
 */

let harness: CoordinatorHarness;
let pool: Pool;
let seeded: SeededSnapshot;
let oldDelegationId: string;
let oldTask: Task;

async function sendWith(config: ReturnType<typeof accommodationAgentClientConfig>, identity: string, data: unknown): Promise<Task> {
  const client = new A2AClient({ config });
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
      requestId: crypto.randomUUID(),
      decisionId,
      expectedRevision: 1,
      response: response as never,
    },
  });
  if (!("operationId" in admitted)) {
    throw new Error(`admitResume refused: ${JSON.stringify(admitted)}`);
  }
}

beforeAll(async () => {
  harness = await startCoordinatorHarness({ accommodationAlt: true });
  pool = harness.pool;
  // The harness already migrated and loaded reference data; seed a frozen
  // snapshot for the direct A/B task contract checks.
  seeded = await seedDelegatedSnapshot(pool, harness.pools);

  // An OLD task bound to Agent A before the switch.
  oldDelegationId = await createAccommodationDelegation(pool, seeded);
  oldTask = await sendWith(
    accommodationAgentClientConfig(),
    "accommodation-agent",
    agentTaskRequestData({
      skillId: "accommodation.recommend.v1",
      tripId: seeded.tripId,
      operationId: seeded.operationId,
      delegationId: oldDelegationId,
      snapshotId: seeded.snapshotId,
      scenarioKey: "seeded",
      requestedDomains: ["hotel"],
    }),
  );
  expect(oldTask.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
}, 240_000);

afterAll(async () => {
  await stopCoordinatorHarness(harness);
});

describe("compatible agent replacement", () => {
  it("serves the same contract from B and records its own endpoint/task table", async () => {
    const delegationId = await createAccommodationDelegation(pool, seeded, {
      agentIdentity: "accommodation-agent-alt",
      endpointUrl: `http://127.0.0.1:${ACCOMMODATION_ALT_AGENT_PORT}`,
    });
    const task = await sendWith(
      accommodationAltAgentClientConfig(),
      "accommodation-agent-alt",
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
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const row = await pool.query<{ agent_identity: string; endpoint_url: string; status: string }>(
      `SELECT agent_identity, endpoint_url, status FROM odft_app.agent_delegations WHERE id = $1`,
      [delegationId],
    );
    expect(row.rows[0]).toMatchObject({
      agent_identity: "accommodation-agent-alt",
      endpoint_url: `http://127.0.0.1:${ACCOMMODATION_ALT_AGENT_PORT}`,
      status: "pending",
    });
  }, 120_000);

  it("switches the trusted registry binding without any coordinator source change", () => {
    const directory = mkdtempSync(join(tmpdir(), "odft-registry-"));
    const registryPath = join(directory, "agent-registry.json");
    const switched = trustedRegistrySchema.parse({
      schemaVersion: 1,
      agents: [
        {
          agentIdentity: "flight-agent",
          endpointUrl: "http://127.0.0.1:4431",
          cardUrl: "http://127.0.0.1:4431/.well-known/agent-card.json",
          credentialRef: "TEST_TOKEN",
          requiredSkills: ["flight.recommend.v1"],
        },
        {
          agentIdentity: "accommodation-agent-alt",
          endpointUrl: `http://127.0.0.1:${ACCOMMODATION_ALT_AGENT_PORT}`,
          cardUrl: `http://127.0.0.1:${ACCOMMODATION_ALT_AGENT_PORT}/.well-known/agent-card.json`,
          credentialRef: "TEST_TOKEN_ACCOMMODATION_ALT",
          requiredSkills: ["accommodation.recommend.v1"],
        },
        {
          agentIdentity: "city-guide-agent",
          endpointUrl: "http://127.0.0.1:4433",
          cardUrl: "http://127.0.0.1:4433/.well-known/agent-card.json",
          credentialRef: "TEST_TOKEN_CITY_GUIDE",
          requiredSkills: ["city-guide.research.v1", "itinerary.propose.v1"],
        },
      ],
    });
    writeFileSync(registryPath, JSON.stringify(switched));
    const config = loadCoordinatorTransportConfig({
      ...process.env,
      ODFT_AGENT_REGISTRY_PATH: registryPath,
      TEST_TOKEN_ACCOMMODATION_ALT: ACCOMMODATION_ALT_AGENT_TOKEN,
    });
    expect(config.accommodation).toMatchObject({
      agentIdentity: "accommodation-agent-alt",
      endpointUrl: `http://127.0.0.1:${ACCOMMODATION_ALT_AGENT_PORT}`,
      skillId: "accommodation.recommend.v1",
    });
    // The old binding is untouched by the switch.
    expect(oldTask.id).toBeTruthy();
  });

  it("keeps the old A task retrievable from A after the switch", async () => {
    const client = new A2AClient({ config: accommodationAgentClientConfig() });
    const persisted = await client.getTask("accommodation-agent", {
      id: oldTask.id,
      tenant: "",
    });
    expect(persisted.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const row = await pool.query<{ agent_identity: string; endpoint_url: string }>(
      `SELECT agent_identity, endpoint_url FROM odft_app.agent_delegations WHERE id = $1`,
      [oldDelegationId],
    );
    expect(row.rows[0]).toMatchObject({
      agent_identity: "accommodation-agent",
      endpoint_url: `http://127.0.0.1:${ACCOMMODATION_AGENT_PORT}`,
    });
  }, 60_000);

  it("runs a NEW coordinator trip through B with the unchanged coordinator driver", async () => {
    const { tripId, sessionId } = await createCoordinatorTrip(harness.pool);
    const flightPark = await driveUntilParked(harness.pools, tripId, 6, {
      accommodationAlt: true,
    });
    expect(flightPark?.waitReason).toBe("flight_choice");
    const flightChoice = await pendingDecision(tripId);
    await resume(tripId, sessionId, flightChoice.id, {
      action: "choose_offer",
      offerId: flightChoice.allowedOfferIds[0],
    });
    const bookingPark = await driveUntilParked(harness.pools, tripId, 6, {
      accommodationAlt: true,
    });
    expect(bookingPark?.waitReason).toBe("booking_confirmation");
    const booking = await pendingDecision(tripId);
    await resume(tripId, sessionId, booking.id, {
      action: "confirm_booking",
      proposalId: booking.proposalId,
      acceptedDemoDisclaimer: true,
    });
    const hotelPark = await driveUntilParked(harness.pools, tripId, 8, {
      accommodationAlt: true,
    });
    expect(hotelPark?.waitReason).toBe("hotel_choice");
    const delegation = await harness.pool.query<{
      agent_identity: string;
      endpoint_url: string;
      status: string;
    }>(
      `SELECT agent_identity, endpoint_url, status FROM odft_app.agent_delegations
        WHERE trip_id = $1 AND skill_id = 'accommodation.recommend.v1'
        ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    );
    expect(delegation.rows[0]).toMatchObject({
      agent_identity: "accommodation-agent-alt",
      endpoint_url: `http://127.0.0.1:${ACCOMMODATION_ALT_AGENT_PORT}`,
      status: "completed",
    });
    // No delegation of this trip ever pointed at A.
    const oldEndpoint = await harness.pool.query(
      `SELECT 1 FROM odft_app.agent_delegations
        WHERE trip_id = $1 AND endpoint_url = $2`,
      [tripId, `http://127.0.0.1:${ACCOMMODATION_AGENT_PORT}`],
    );
    expect(oldEndpoint.rowCount).toBe(0);
  }, 240_000);

  it("switches the accommodation binding between operations and keeps the flight binding", async () => {
    const { tripId, sessionId } = await createCoordinatorTrip(harness.pool);
    const flightPark = await driveUntilParked(harness.pools, tripId, 6);
    expect(flightPark?.waitReason).toBe("flight_choice");
    const flightChoice = await pendingDecision(tripId);
    await resume(tripId, sessionId, flightChoice.id, {
      action: "choose_offer",
      offerId: flightChoice.allowedOfferIds[0],
    });
    // The operator switch happens between operations: the booking/research
    // driver now uses the B binding while the flight delegation stays on A.
    const bookingPark = await driveUntilParked(harness.pools, tripId, 6, {
      accommodationAlt: true,
    });
    expect(bookingPark?.waitReason).toBe("booking_confirmation");
    const booking = await pendingDecision(tripId);
    await resume(tripId, sessionId, booking.id, {
      action: "confirm_booking",
      proposalId: booking.proposalId,
      acceptedDemoDisclaimer: true,
    });
    const hotelPark = await driveUntilParked(harness.pools, tripId, 8, {
      accommodationAlt: true,
    });
    expect(hotelPark?.waitReason).toBe("hotel_choice");
    const rows = await harness.pool.query<{
      skill_id: string;
      agent_identity: string;
      endpoint_url: string;
    }>(
      `SELECT skill_id, agent_identity, endpoint_url FROM odft_app.agent_delegations
        WHERE trip_id = $1 ORDER BY created_at ASC`,
      [tripId],
    );
    const flight = rows.rows.find((row) => row.skill_id === "flight.recommend.v1");
    const hotel = rows.rows.find((row) => row.skill_id === "accommodation.recommend.v1");
    expect(flight).toMatchObject({
      agent_identity: "flight-agent",
      endpoint_url: "http://127.0.0.1:4431",
    });
    expect(hotel).toMatchObject({
      agent_identity: "accommodation-agent-alt",
      endpoint_url: `http://127.0.0.1:${ACCOMMODATION_ALT_AGENT_PORT}`,
    });
  }, 240_000);
});
