import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admitResume, claimNextOperation } from "@odft/persistence";
import {
  claimCoordinator,
  createCoordinatorTrip,
  driveUntilParked,
  startCoordinatorHarness,
  stopCoordinatorHarness,
  type CoordinatorHarness,
} from "./_setup.js";

/**
 * Phase 07 coordinator flight slice: engine-filtered claims, the run row, route
 * preparation, the REAL flight delegation over HTTP and the parked
 * `flight_choice` decision with the artifact's ranked ids.
 */

let harness: CoordinatorHarness;

beforeAll(async () => {
  harness = await startCoordinatorHarness();
}, 120_000);

afterAll(async () => {
  await stopCoordinatorHarness(harness);
});

describe("coordinator admission and flight slice", () => {
  it("creates a coordinator trip, claims it by engine, and parks a flight_choice decision", async () => {
    // Bidirectional isolation on a controlled fixture: retire any pre-existing
    // claimable operation, then prove that a legacy-engine operation is visible
    // to the legacy filter and invisible to the coordinator filter. New trips
    // cannot be created on the legacy engine anymore, so the row is relabeled
    // directly (the Phase 11 migration does the same to historical rows).
    await harness.pools.operations.query(
      `UPDATE odft_app.workflow_operations SET status = 'cancelled'
        WHERE status IN ('queued', 'running')`,
    );
    const legacyTrip = await createCoordinatorTrip(harness.pool);
    await harness.pool.query(`UPDATE odft_app.trips SET engine = 'langgraph' WHERE id = $1`, [
      legacyTrip.tripId,
    ]);
    await harness.pool.query(
      `UPDATE odft_app.workflow_operations SET engine = 'langgraph' WHERE trip_id = $1`,
      [legacyTrip.tripId],
    );
    const coordinatorSees = await claimNextOperation(harness.pools.operations, {
      workerId: "coordinator-test",
      leaseMs: 30_000,
      engines: ["coordinator-v1"],
    });
    expect(coordinatorSees).toBeNull();
    const legacySees = await claimNextOperation(harness.pools.operations, {
      workerId: "legacy-test",
      leaseMs: 30_000,
      engines: ["langgraph"],
    });
    expect(legacySees?.tripId).toBe(legacyTrip.tripId);
    // Retire the legacy fixture claim so the later filter check starts clean.
    await harness.pools.operations.query(
      `UPDATE odft_app.workflow_operations SET status = 'cancelled' WHERE id = $1`,
      [legacySees?.operationId],
    );

    const { tripId } = await createCoordinatorTrip(harness.pool);

    // Engine dispatch: the graph worker must NOT see this operation...
    const graphClaim = await claimNextOperation(harness.pools.operations, {
      workerId: "graph-test",
      leaseMs: 30_000,
      engines: ["langgraph"],
    });
    expect(graphClaim).toBeNull();
    // ...and the coordinator claim must.
    const claim = await claimCoordinator(harness.pools);
    expect(claim?.tripId).toBe(tripId);
    await harness.pools.operations.query(
      `UPDATE odft_app.workflow_operations SET status = 'queued', lease_expires_at = NULL, claimed_by = NULL WHERE id = $1`,
      [claim?.operationId],
    );

    const run = await driveUntilParked(harness.pools, tripId);
    expect(run?.step).toBe("awaiting_user");
    expect(run?.waitReason).toBe("flight_choice");
    expect(run?.status).toBe("waiting");

    const decision = await harness.pool.query<{
      kind: string;
      engine: string;
      coordinator_run_id: string | null;
      thread_id: string | null;
      graph_version: string | null;
      allowed_offer_ids: string[];
      source_fingerprint: string;
    }>(
      `SELECT kind, engine, coordinator_run_id, thread_id, graph_version, allowed_offer_ids, source_fingerprint
         FROM odft_app.pending_decisions
        WHERE trip_id = $1 AND status = 'pending'`,
      [tripId],
    );
    const row = decision.rows[0];
    expect(row?.kind).toBe("flight_choice");
    expect(row?.engine).toBe("coordinator-v1");
    expect(row?.coordinator_run_id).toBe(run?.id);
    expect(row?.thread_id).toBeNull();
    expect(row?.graph_version).toBeNull();
    expect((row?.allowed_offer_ids ?? []).length).toBeGreaterThan(0);

    // The ranked ids come from the REAL flight specialist artifact: every id is
    // a schedule-valid combination of the trip's active snapshot.
    const schedule = await harness.pool.query<{ ids: string[] }>(
      `SELECT result->'validCombinationIds' AS ids FROM odft_app.schedule_validations
        WHERE snapshot_id = (SELECT active_scenario_snapshot_id FROM odft_app.trips WHERE id = $1)
        ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    );
    const validIds = new Set(schedule.rows[0]?.ids ?? []);
    expect(validIds.size).toBeGreaterThan(0);
    for (const id of row?.allowed_offer_ids ?? []) {
      expect(validIds.has(id)).toBe(true);
    }

    // The delegation persisted before delivery and was acknowledged.
    const delegation = await harness.pool.query<{
      status: string;
      accepted_artifact_hash: string | null;
    }>(
      `SELECT status, accepted_artifact_hash FROM odft_app.agent_delegations
        WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    );
    expect(delegation.rows[0]?.status).toBe("completed");
    expect(delegation.rows[0]?.accepted_artifact_hash).toBe(row?.source_fingerprint);
  }, 180_000);

  it("admits the flight choice at the unchanged revision, proposes the booking and parks its confirmation", async () => {
    const { tripId, sessionId } = await createCoordinatorTrip(harness.pool);
    const parked = await driveUntilParked(harness.pools, tripId);
    expect(parked?.waitReason).toBe("flight_choice");
    const decision = await harness.pool.query<{ id: string; allowed_offer_ids: string[] }>(
      `SELECT id, allowed_offer_ids FROM odft_app.pending_decisions
        WHERE trip_id = $1 AND status = 'pending' AND kind = 'flight_choice'`,
      [tripId],
    );
    const decisionId = decision.rows[0]?.id as string;
    const offerId = (decision.rows[0]?.allowed_offer_ids ?? [])[0] as string;

    const admitted = await admitResume(harness.pool, {
      tripId,
      sessionId,
      request: {
        requestId: crypto.randomUUID(),
        decisionId,
        expectedRevision: 1,
        response: { action: "choose_offer", offerId },
      },
    });
    if (!("operationId" in admitted)) {
      throw new Error(`admitResume refused: ${JSON.stringify(admitted)}`);
    }
    const engine = await harness.pool.query<{ engine: string }>(
      `SELECT engine FROM odft_app.workflow_operations WHERE id = $1`,
      [admitted.operationId],
    );
    expect(engine.rows[0]?.engine).toBe("coordinator-v1");

    const claim = await claimCoordinator(harness.pools);
    expect(claim?.operationId).toBe(admitted.operationId);
    const { coordinatorDriver } = await import("./_setup.js");
    await coordinatorDriver(harness.pools).runOperation(claim as never);

    const next = await harness.pool.query<{
      kind: string;
      proposal_id: string | null;
      allowed_offer_ids: string[];
      engine: string;
    }>(
      `SELECT kind, proposal_id, allowed_offer_ids, engine FROM odft_app.pending_decisions
        WHERE trip_id = $1 AND status = 'pending'`,
      [tripId],
    );
    expect(next.rows[0]?.kind).toBe("booking_confirmation");
    expect(next.rows[0]?.engine).toBe("coordinator-v1");
    expect(next.rows[0]?.proposal_id).not.toBeNull();

    // The accepted choice was retired by the same transition.
    const retired = await harness.pool.query<{ status: string }>(
      `SELECT status FROM odft_app.pending_decisions WHERE id = $1`,
      [decisionId],
    );
    expect(retired.rows[0]?.status).not.toBe("pending");

    // The proposal is bound to the chosen offer and the accepted revision.
    const proposal = await harness.pool.query<{
      service_key: string;
      offer_id: string;
      status: string;
    }>(
      `SELECT service_key, offer_id, status FROM odft_app.selection_proposals
        WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    );
    expect(proposal.rows[0]?.service_key).toBe("flights");
    expect(proposal.rows[0]?.offer_id).toBe(offerId);

    // The revision did not move: a decision resume never bumps it.
    const revision = await harness.pool.query<{ revision: number }>(
      `SELECT revision FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    expect(revision.rows[0]?.revision).toBe(1);
  }, 180_000);
});
