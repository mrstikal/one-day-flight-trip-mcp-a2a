import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admitResume } from "@odft/persistence";
import {
  createCoordinatorTrip,
  driveUntilParked,
  startCoordinatorHarness,
  stopCoordinatorHarness,
  type CoordinatorHarness,
} from "./_setup.js";

/**
 * Phase 07 decision admission edge cases (plan §3.13/§3.10): duplicate resume
 * request ids replay the SAME operation, stale revisions and offers are
 * refused, and the revision never moves on a decision resume.
 */

let harness: CoordinatorHarness;

async function parkedChoice(tripId: string): Promise<{ id: string; offers: string[] }> {
  const result = await harness.pool.query<{ id: string; allowed_offer_ids: string[] }>(
    `SELECT id, allowed_offer_ids FROM odft_app.pending_decisions
      WHERE trip_id = $1 AND status = 'pending' AND kind = 'flight_choice'`,
    [tripId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("no parked flight choice");
  }
  return { id: row.id, offers: row.allowed_offer_ids };
}

beforeAll(async () => {
  harness = await startCoordinatorHarness();
}, 180_000);

afterAll(async () => {
  await stopCoordinatorHarness(harness);
});

describe("coordinator decision admission", () => {
  it("replays a duplicate resume under the same request id without a second operation", async () => {
    const { tripId, sessionId } = await createCoordinatorTrip(harness.pool);
    await driveUntilParked(harness.pools, tripId);
    const choice = await parkedChoice(tripId);
    const request = {
      requestId: crypto.randomUUID(),
      decisionId: choice.id,
      expectedRevision: 1,
      response: { action: "choose_offer", offerId: choice.offers[0] } as never,
    };
    const first = await admitResume(harness.pool, { tripId, sessionId, request });
    expect("operationId" in first).toBe(true);
    const replay = await admitResume(harness.pool, { tripId, sessionId, request });
    if (!("operationId" in first) || !("operationId" in replay)) {
      throw new Error("resume refused");
    }
    expect(replay.operationId).toBe(first.operationId);
    expect((replay as { deduped?: boolean }).deduped).toBe(true);
    const count = await harness.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.workflow_operations
        WHERE trip_id = $1 AND kind = 'decision'`,
      [tripId],
    );
    expect(count.rows[0]?.count).toBe("1");
  }, 120_000);

  it("refuses a stale revision and an offer that was not offered", async () => {
    const { tripId, sessionId } = await createCoordinatorTrip(harness.pool);
    await driveUntilParked(harness.pools, tripId);
    const choice = await parkedChoice(tripId);

    const staleRevision = await admitResume(harness.pool, {
      tripId,
      sessionId,
      request: {
        requestId: crypto.randomUUID(),
        decisionId: choice.id,
        expectedRevision: 7,
        response: { action: "choose_offer", offerId: choice.offers[0] } as never,
      },
    });
    expect("code" in staleRevision ? staleRevision.code : "accepted").toBe("STALE_REVISION");

    const foreignOffer = await admitResume(harness.pool, {
      tripId,
      sessionId,
      request: {
        requestId: crypto.randomUUID(),
        decisionId: choice.id,
        expectedRevision: 1,
        response: { action: "choose_offer", offerId: "not-an-offered-id" } as never,
      },
    });
    expect("code" in foreignOffer ? foreignOffer.code : "accepted").toBe("STALE_DECISION");

    // Nothing was admitted: the choice is still pending and no decision op exists.
    const pending = await harness.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.pending_decisions
        WHERE trip_id = $1 AND status = 'pending'`,
      [tripId],
    );
    expect(pending.rows[0]?.count).toBe("1");
    const operations = await harness.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.workflow_operations
        WHERE trip_id = $1 AND kind = 'decision'`,
      [tripId],
    );
    expect(operations.rows[0]?.count).toBe("0");
  }, 120_000);
});
