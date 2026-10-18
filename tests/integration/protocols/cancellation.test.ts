import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptDelegationArtifact,
  admitResume,
  cancelOperation,
  revokeDelegation,
} from "@odft/persistence";
import {
  createAccommodationDelegation,
  startAccommodationAgent,
  stopAgent,
  waitForAgentReady,
} from "../a2a/_setup-agents.js";
import { seedDelegatedSnapshot } from "../mcp/_setup.js";
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
 * Phase 10 cancellation races (plan §3.8/§3.14, scenarios H/I):
 * - cancellation of a RUNNING coordinator operation revokes the delegation while
 *   the specialist is still computing; the late artifact is never ingested;
 * - a cancel racing an agent question answer settles consistently (one winner,
 *   no lock-order/40P01 failure, no orphaned pending question).
 */

let harness: CoordinatorHarness;
let delayedAccommodation: ChildProcess | undefined;

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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function pendingDecision(tripId: string): Promise<{
  id: string;
  kind: string;
  allowedOfferIds: string[];
}> {
  const result = await harness.pool.query<{
    id: string;
    kind: string;
    allowed_offer_ids: string[];
  }>(
    `SELECT id, kind, allowed_offer_ids FROM odft_app.pending_decisions
      WHERE trip_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
    [tripId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("no pending decision");
  }
  return { id: row.id, kind: row.kind, allowedOfferIds: row.allowed_offer_ids };
}

async function resume(
  tripId: string,
  sessionId: string,
  decisionId: string,
  response: Record<string, unknown>,
): Promise<unknown> {
  return admitResume(harness.pool, {
    tripId,
    sessionId,
    request: {
      requestId: randomUUID(),
      decisionId,
      expectedRevision: 1,
      response: response as never,
    },
  });
}

async function revisionOf(tripId: string): Promise<number> {
  const result = await harness.pool.query<{ revision: number }>(
    `SELECT revision FROM odft_app.trips WHERE id = $1`,
    [tripId],
  );
  return result.rows[0]?.revision ?? 0;
}

beforeAll(async () => {
  harness = await startCoordinatorHarness();
  // A slow accommodation process widens the running window deterministically.
  await stopAgent(harness.accommodationAgent);
  delayedAccommodation = startAccommodationAgent({
    ODFT_ACCOMMODATION_AGENT_STEP_DELAY_MS: "2000",
  });
  await waitForAgentReady(delayedAccommodation, "accommodation-agent");
}, 240_000);

afterAll(async () => {
  if (delayedAccommodation) {
    await stopAgent(delayedAccommodation);
  }
  await stopCoordinatorHarness(harness);
});

describe("cancellation races", () => {
  it("never resurrects a revoked delegation when a late artifact is accepted", async () => {
    const seeded = await seedDelegatedSnapshot(harness.pool, harness.pools);
    const delegationId = await createAccommodationDelegation(harness.pool, seeded);
    await revokeDelegation(harness.pool, {
      delegationId,
      reason: "cancelled before the artifact was accepted",
    });
    const accepted = await acceptDelegationArtifact(harness.pool, {
      delegationId,
      artifactHash: "a".repeat(64),
    });
    expect(accepted).toBe(false);
    const row = await harness.pool.query<{ status: string; accepted_artifact_hash: string | null }>(
      `SELECT status, accepted_artifact_hash FROM odft_app.agent_delegations WHERE id = $1`,
      [delegationId],
    );
    expect(row.rows[0]).toEqual({ status: "revoked", accepted_artifact_hash: null });
  }, 60_000);

  it("revokes a running delegation and never ingests its late artifact", async () => {
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
      proposalId: (
        await harness.pool.query<{ proposal_id: string }>(
          `SELECT proposal_id FROM odft_app.pending_decisions WHERE id = $1`,
          [booking.id],
        )
      ).rows[0]?.proposal_id,
      acceptedDemoDisclaimer: true,
    });

    const driver = coordinatorDriver(harness.pools);
    const claim = await claimCoordinator(harness.pools);
    if (!claim) {
      throw new Error("no coordinator claim for the research operation");
    }
    const running = driver.runOperation(claim).catch(() => undefined);
    const delegation = await waitFor(
      async () => {
        const result = await harness.pool.query<{
          id: string;
          task_id: string | null;
          status: string;
        }>(
          `SELECT id, task_id, status FROM odft_app.agent_delegations
            WHERE trip_id = $1 AND skill_id = 'accommodation.recommend.v1'
            ORDER BY created_at DESC LIMIT 1`,
          [tripId],
        );
        const row = result.rows[0];
        return row?.task_id ? row : undefined;
      },
      30_000,
      "the accommodation task binding",
    );
    const cancelled = await cancelOperation(harness.pool, {
      tripId,
      sessionId,
      operationId: claim.operationId,
      controlRequestId: randomUUID(),
      expectedRevision: await revisionOf(tripId),
    });
    expect("status" in cancelled && cancelled.status).toBe("cancelled");
    await running;

    const after = await harness.pool.query<{
      status: string;
      cancellation_state: string | null;
    }>(`SELECT status, cancellation_state FROM odft_app.agent_delegations WHERE id = $1`, [
      delegation.id,
    ]);
    expect(after.rows[0]?.status).toBe("revoked");
    expect(["pending", "acknowledged", "failed"]).toContain(
      after.rows[0]?.cancellation_state ?? "",
    );
    const run = await harness.pool.query<{ status: string }>(
      `SELECT status FROM odft_app.coordinator_runs
        WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    );
    expect(run.rows[0]?.status).toBe("cancelled");
    const trip = await harness.pool.query<{ workflow_status: string }>(
      `SELECT workflow_status FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    // Older answered decisions stay `waiting` as audit rows; they must not keep
    // the cancelled trip stuck in queued/waiting_user.
    expect(trip.rows[0]?.workflow_status).toBe("ready");
    const hotelDecision = await harness.pool.query(
      `SELECT 1 FROM odft_app.pending_decisions
        WHERE trip_id = $1 AND kind = 'hotel_choice' AND status = 'pending'`,
      [tripId],
    );
    expect(hotelDecision.rowCount).toBe(0);

    // The agent may still finish its paid work; its artifact must never become
    // an accepted recommendation of the cancelled operation.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const artifact = await harness.pool.query(
      `SELECT 1 FROM odft_app.recommendation_artifacts
        WHERE trip_id = $1 AND service_key = 'hotel'`,
      [tripId],
    );
    expect(artifact.rowCount).toBe(0);
  }, 240_000);

  it("settles a cancel racing an agent question answer without a lock-order failure", async () => {
    const { tripId, sessionId } = await createCoordinatorTrip(harness.pool);
    const flightPark = await driveUntilParked(harness.pools, tripId, 6, {
      hotelObjective: "cheaper",
    });
    expect(flightPark?.waitReason).toBe("flight_choice");
    const flightChoice = await pendingDecision(tripId);
    await resume(tripId, sessionId, flightChoice.id, {
      action: "choose_offer",
      offerId: flightChoice.allowedOfferIds[0],
    });
    const bookingPark = await driveUntilParked(harness.pools, tripId, 6, {
      hotelObjective: "cheaper",
    });
    expect(bookingPark?.waitReason).toBe("booking_confirmation");
    const booking = await pendingDecision(tripId);
    await resume(tripId, sessionId, booking.id, {
      action: "confirm_booking",
      proposalId: (
        await harness.pool.query<{ proposal_id: string }>(
          `SELECT proposal_id FROM odft_app.pending_decisions WHERE id = $1`,
          [booking.id],
        )
      ).rows[0]?.proposal_id,
      acceptedDemoDisclaimer: true,
    });
    const questionPark = await driveUntilParked(harness.pools, tripId, 10, {
      hotelObjective: "cheaper",
    });
    expect(questionPark?.waitReason).toBe("agent_input");
    const question = await pendingDecision(tripId);
    const operation = await harness.pool.query<{ id: string }>(
      `SELECT id FROM odft_app.workflow_operations
        WHERE trip_id = $1 AND status IN ('queued','running','waiting')
        ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    );
    const operationId = operation.rows[0]?.id;
    if (!operationId) {
      throw new Error("no active operation for the question");
    }
    const option = await harness.pool.query<{ option_payload: { options: { id: string }[] } }>(
      `SELECT option_payload FROM odft_app.pending_decisions WHERE id = $1`,
      [question.id],
    );
    const optionId = option.rows[0]?.option_payload.options[0]?.id;
    if (!optionId) {
      throw new Error("the pending question has no options");
    }
    const [cancelResult, answerResult] = await Promise.allSettled([
      cancelOperation(harness.pool, {
        tripId,
        sessionId,
        operationId,
        controlRequestId: randomUUID(),
        expectedRevision: await revisionOf(tripId),
      }),
      resume(tripId, sessionId, question.id, {
        action: "choose_option",
        optionId,
      }),
    ]);
    // Neither path may throw a database/lock-order error (40P01 or similar).
    for (const result of [cancelResult, answerResult]) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
    const decision = await harness.pool.query<{ status: string }>(
      `SELECT status FROM odft_app.pending_decisions WHERE id = $1`,
      [question.id],
    );
    const cancelled =
      cancelResult.status === "fulfilled" &&
      "status" in cancelResult.value &&
      cancelResult.value.status === "cancelled";
    if (cancelled) {
      expect(decision.rows[0]?.status).toBe("cancelled");
    } else {
      // The answer won: the question is resolved and the cancellation either
      // lost the newest-operation race or settled the old operation.
      expect(["resolved", "cancelled"]).toContain(decision.rows[0]?.status ?? "");
    }
    const pending = await harness.pool.query(
      `SELECT 1 FROM odft_app.pending_decisions WHERE trip_id = $1 AND status = 'pending'`,
      [tripId],
    );
    expect(pending.rowCount).toBe(0);
  }, 240_000);
});
