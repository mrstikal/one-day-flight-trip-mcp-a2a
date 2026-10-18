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
 * Phase 07 genuine specialist input (plan §3.10): the accommodation specialist
 * asks its real price-versus-location question, the coordinator drains the
 * in-flight siblings, promotes ONE agent_input decision, and the accepted answer
 * is delivered as a continuation of the ANSWERING task at the unchanged
 * revision — no second task, no repeated sibling work.
 */

let harness: CoordinatorHarness;

async function pending(tripId: string): Promise<{ id: string; kind: string; offers: string[]; options: string[] }> {
  const result = await harness.pool.query<{
    id: string;
    kind: string;
    allowed_offer_ids: string[];
    allowed_option_ids: string[];
  }>(
    `SELECT id, kind, allowed_offer_ids, allowed_option_ids FROM odft_app.pending_decisions
      WHERE trip_id = $1 AND status = 'pending'`,
    [tripId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("no pending decision");
  }
  return { id: row.id, kind: row.kind, offers: row.allowed_offer_ids, options: row.allowed_option_ids };
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
  harness = await startCoordinatorHarness();
}, 180_000);

afterAll(async () => {
  await stopCoordinatorHarness(harness);
});

describe("coordinator input-required bridge", () => {
  it("promotes the accommodation question after the drain and continues the same task", async () => {
    // The hotel research objective makes the accommodation specialist ask its
    // genuine cheaper-tradeoff question (fixture data is deterministic).
    const { tripId, sessionId } = await createCoordinatorTrip(harness.pool);
    const flightPark = await driveUntilParked(harness.pools, tripId, 6, { hotelObjective: "cheaper" });
    expect(flightPark?.waitReason).toBe("flight_choice");
    const flightChoice = await pending(tripId);
    await resume(tripId, sessionId, flightChoice.id, {
      action: "choose_offer",
      offerId: flightChoice.offers[0],
    });
    const bookingPark = await driveUntilParked(harness.pools, tripId, 6, { hotelObjective: "cheaper" });
    expect(bookingPark?.waitReason).toBe("booking_confirmation");
    const booking = await pending(tripId);
    await resume(tripId, sessionId, booking.id, {
      action: "confirm_booking",
      proposalId: (await harness.pool.query<{ proposal_id: string }>(
        `SELECT proposal_id FROM odft_app.pending_decisions WHERE id = $1`,
        [booking.id],
      )).rows[0]?.proposal_id,
      acceptedDemoDisclaimer: true,
    });

    // The coordinator drains: the question appears only after both submitted
    // siblings (accommodation + city guide) reached a terminal state.
    const asked = await driveUntilParked(harness.pools, tripId, 8, { hotelObjective: "cheaper" });
    expect(asked?.waitReason).toBe("agent_input");
    const question = await pending(tripId);
    expect(question.kind).toBe("agent_input");
    expect(question.options.sort()).toEqual(["central", "cheapest"]);
    const drainCheck = await harness.pool.query<{ skill_id: string; status: string }>(
      `SELECT skill_id, status FROM odft_app.agent_delegations
        WHERE trip_id = $1 AND skill_id = 'city-guide.research.v1'`,
      [tripId],
    );
    expect(drainCheck.rows[0]?.status).toBe("completed");

    // The answer continues the SAME accommodation task.
    const answering = await harness.pool.query<{ id: string; task_id: string }>(
      `SELECT id, task_id FROM odft_app.agent_delegations
        WHERE trip_id = $1 AND skill_id = 'accommodation.recommend.v1'`,
      [tripId],
    );
    const answeringTaskId = answering.rows[0]?.task_id as string;
    await resume(tripId, sessionId, question.id, {
      action: "choose_option",
      optionId: "central",
    });
    const hotelPark = await driveUntilParked(harness.pools, tripId, 8, { hotelObjective: "cheaper" });
    expect(hotelPark?.waitReason).toBe("hotel_choice");
    // The answered "closest to the centre" preference must survive persistence:
    // the stored artifact order is the specialist's distance order, not a
    // coordinator re-sort by price.
    const hotelDecision = await pending(tripId);
    const storedHotel = await harness.pool.query<{ ranked_offers: string[] }>(
      `SELECT ranked_offers FROM odft_app.recommendation_artifacts
        WHERE trip_id = $1 AND service_key = 'hotel'
        ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    );
    expect(storedHotel.rows[0]?.ranked_offers).toEqual(hotelDecision.offers);

    // Same task, one input, unchanged revision.
    const after = await harness.pool.query<{ task_id: string; status: string }>(
      `SELECT task_id, status FROM odft_app.agent_delegations WHERE id = $1`,
      [answering.rows[0]?.id],
    );
    expect(after.rows[0]?.task_id).toBe(answeringTaskId);
    expect(after.rows[0]?.status).toBe("completed");
    const taskCount = await harness.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.protocol_outbound_messages
        WHERE delegation_id = $1`,
      [answering.rows[0]?.id],
    );
    // 1 initial request + 1 continuation answer.
    expect(taskCount.rows[0]?.count).toBe("2");
    const control = await harness.pool.query<{ input_count: number }>(
      `SELECT input_count FROM odft_app.protocol_task_control
        WHERE agent_identity = 'accommodation-agent' AND task_id = $1`,
      [answeringTaskId],
    );
    expect(control.rows[0]?.input_count).toBe(1);
    const revision = await harness.pool.query<{ revision: number }>(
      `SELECT revision FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    expect(revision.rows[0]?.revision).toBe(1);
  }, 300_000);
});
