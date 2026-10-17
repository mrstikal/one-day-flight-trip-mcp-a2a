import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admitOperation, admitResume } from "@odft/persistence";
import {
  createCoordinatorTrip,
  driveUntilParked,
  startCoordinatorHarness,
  stopCoordinatorHarness,
  type CoordinatorHarness,
} from "./_setup.js";

/**
 * Phase 08 end-to-end coordinator itinerary flow: program choices -> delegated
 * City Guide proposal -> local reassembly/validation -> reviewer policy ->
 * approval, all through the real A2A specialists and the fixture AI roles.
 */

let harness: CoordinatorHarness;

interface PendingDecision {
  id: string;
  kind: string;
  proposalId: string | null;
  allowedOfferIds: string[];
  allowedOptionIds: string[];
  optionPayload: Record<string, unknown> | null;
}

async function resume(
  tripId: string,
  sessionId: string,
  decisionId: string,
  response: Record<string, unknown>,
): Promise<void> {
  const current = await harness.pool.query<{ revision: number }>(
    `SELECT revision FROM odft_app.trips WHERE id = $1`,
    [tripId],
  );
  const admitted = await admitResume(harness.pool, {
    tripId,
    sessionId,
    request: {
      requestId: crypto.randomUUID(),
      decisionId,
      expectedRevision: current.rows[0]?.revision ?? 0,
      response: response as never,
    },
  });
  if (!("operationId" in admitted)) {
    throw new Error(`admitResume refused: ${JSON.stringify(admitted)}`);
  }
}

async function pendingDecision(tripId: string): Promise<PendingDecision> {
  const result = await harness.pool.query<{
    id: string;
    kind: string;
    proposal_id: string | null;
    allowed_offer_ids: string[];
    allowed_option_ids: string[];
    option_payload: Record<string, unknown> | null;
  }>(
    `SELECT id, kind, proposal_id, allowed_offer_ids, allowed_option_ids, option_payload
       FROM odft_app.pending_decisions
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
    allowedOptionIds: row.allowed_option_ids,
    optionPayload: row.option_payload,
  };
}

async function driveToProgramChoices(
  tripId: string,
  sessionId: string,
): Promise<{ program: PendingDecision; snapshotId: string }> {
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
  const hotelPark = await driveUntilParked(harness.pools, tripId, 8);
  expect(hotelPark?.waitReason).toBe("hotel_choice");
  const hotelChoice = await pendingDecision(tripId);
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
  const programPark = await driveUntilParked(harness.pools, tripId);
  expect(programPark?.waitReason).toBe("program_choices");
  const snapshot = await harness.pool.query<{ active_scenario_snapshot_id: string }>(
    `SELECT active_scenario_snapshot_id FROM odft_app.trips WHERE id = $1`,
    [tripId],
  );
  return {
    program: await pendingDecision(tripId),
    snapshotId: snapshot.rows[0]?.active_scenario_snapshot_id as string,
  };
}

async function submitProgram(
  tripId: string,
  sessionId: string,
  program: PendingDecision,
): Promise<{ breakfast: string; lunch: string; dinner: string; activityIds: string[] }> {
  const snapshot = await harness.pool.query<{
    restaurants: { id: string; meal: string }[];
    activities: { id: string }[];
  }>(
    `SELECT (SELECT jsonb_agg(r) FROM odft_app.scenario_snapshots s,
               lateral jsonb_array_elements(s.inventory->'restaurants') r
              WHERE s.id = $1) AS restaurants,
            (SELECT jsonb_agg(a) FROM odft_app.scenario_snapshots s,
               lateral jsonb_array_elements(s.inventory->'activities') a
              WHERE s.id = $1) AS activities`,
    [
      (
        await harness.pool.query<{ active_scenario_snapshot_id: string }>(
          `SELECT active_scenario_snapshot_id FROM odft_app.trips WHERE id = $1`,
          [tripId],
        )
      ).rows[0]?.active_scenario_snapshot_id,
    ],
  );
  const offered = new Set(program.allowedOfferIds);
  const byMeal = (meal: string): string =>
    snapshot.rows[0]?.restaurants.find((offer) => offer.meal === meal && offered.has(offer.id))
      ?.id ?? "";
  const breakfast = byMeal("breakfast");
  const lunch = byMeal("lunch");
  const dinner = byMeal("dinner");
  expect(breakfast).not.toBe("");
  expect(lunch).not.toBe("");
  expect(dinner).not.toBe("");
  const activityIds = program.allowedOptionIds.slice(0, 2);
  await resume(tripId, sessionId, program.id, {
    action: "submit_program",
    mealOfferIds: { breakfast, lunch, dinner },
    selfArrangedMeals: [],
    preferredActivityIds: activityIds,
    activitiesSelfArranged: false,
  });
  return { breakfast, lunch, dinner, activityIds };
}

beforeAll(async () => {
  harness = await startCoordinatorHarness();
}, 180_000);

afterAll(async () => {
  await stopCoordinatorHarness(harness);
});

describe("coordinator itinerary flow", () => {
  it("delegates the proposal, validates it locally, reviews it and approves the draft", async () => {
    const { tripId, sessionId } = await createCoordinatorTrip(harness.pool);
    const { program } = await driveToProgramChoices(tripId, sessionId);
    await submitProgram(tripId, sessionId, program);

    const approvalPark = await driveUntilParked(harness.pools, tripId, 12);
    expect(approvalPark?.step).toBe("awaiting_user");
    expect(approvalPark?.waitReason).toBe("itinerary_approval");
    expect(approvalPark?.runData.planningAttempt).toBeGreaterThanOrEqual(1);
    expect(approvalPark?.runData.planningAttempt).toBeLessThanOrEqual(3);

    const approval = await pendingDecision(tripId);
    expect(approval.kind).toBe("itinerary_approval");
    const itineraryId = (approval.optionPayload as { itineraryId?: string } | null)?.itineraryId;
    expect(itineraryId).toBeTruthy();

    const itinerary = await harness.pool.query<{
      status: string;
      validation: { status: string };
      events: unknown[];
      review: { verdict: string } | null;
      simulated_failure: boolean;
    }>(
      `SELECT status, validation, events, review, simulated_failure
         FROM odft_app.itineraries WHERE id = $1`,
      [itineraryId],
    );
    expect(itinerary.rows[0]?.status).toBe("draft");
    expect(itinerary.rows[0]?.validation.status).toBe("valid");
    expect(itinerary.rows[0]?.events.length).toBeGreaterThan(0);
    expect(itinerary.rows[0]?.review?.verdict).toBe("acceptable");

    const delegation = await harness.pool.query<{ status: string; task_id: string | null }>(
      `SELECT status, task_id FROM odft_app.agent_delegations
        WHERE trip_id = $1 AND skill_id = 'itinerary.propose.v1'
        ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    );
    expect(delegation.rows[0]?.status).toBe("completed");
    expect(delegation.rows[0]?.task_id).toBeTruthy();
    // A valid first attempt must not create extra delegated attempts.
    const delegationCount = await harness.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.agent_delegations
        WHERE trip_id = $1 AND skill_id = 'itinerary.propose.v1'`,
      [tripId],
    );
    expect(delegationCount.rows[0]?.count).toBe("1");

    await resume(tripId, sessionId, approval.id, {
      action: "approve_itinerary",
      itineraryId,
    });
    await driveUntilParked(harness.pools, tripId, 4);

    const approved = await harness.pool.query<{ status: string; version: number }>(
      `SELECT status, version FROM odft_app.itineraries WHERE id = $1`,
      [itineraryId],
    );
    expect(approved.rows[0]?.status).toBe("approved");
    const trip = await harness.pool.query<{ workflow_status: string }>(
      `SELECT workflow_status FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    expect(trip.rows[0]?.workflow_status).toBe("ready");
  }, 420_000);

  it("keeps the interrupted decision answerable after an unsupported chat", async () => {
    const { tripId, sessionId } = await createCoordinatorTrip(harness.pool);
    const { program } = await driveToProgramChoices(tripId, sessionId);
    await submitProgram(tripId, sessionId, program);
    const approvalPark = await driveUntilParked(harness.pools, tripId, 12);
    expect(approvalPark?.waitReason).toBe("itinerary_approval");
    const firstApproval = await pendingDecision(tripId);
    const itineraryId = (firstApproval.optionPayload as { itineraryId?: string }).itineraryId as string;

    const revision = await harness.pool.query<{ revision: number }>(
      `SELECT revision FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    const admitted = await admitOperation(harness.pool, {
      tripId,
      sessionId,
      request: {
        requestId: crypto.randomUUID(),
        expectedRevision: revision.rows[0]?.revision ?? 0,
        chat: "hello there",
      } as never,
      userMessage: "hello there",
    });
    expect("operationId" in admitted).toBe(true);

    // The interrupted approval is re-published, not silently dropped.
    const republished = await driveUntilParked(harness.pools, tripId, 4);
    expect(republished?.waitReason).toBe("itinerary_approval");
    const approval = await pendingDecision(tripId);
    expect(approval.kind).toBe("itinerary_approval");
    expect((approval.optionPayload as { itineraryId?: string }).itineraryId).toBe(itineraryId);

    const messages = await harness.pool.query<{ role: string; content: string }>(
      `SELECT role, content FROM odft_app.conversation_messages
        WHERE trip_id = $1 ORDER BY sequence`,
      [tripId],
    );
    expect(messages.rows.some((row) => row.role === "assistant")).toBe(true);

    // The re-published decision is answerable (its run is waiting, not complete).
    await resume(tripId, sessionId, approval.id, {
      action: "approve_itinerary",
      itineraryId,
    });
    const completion = await driveUntilParked(harness.pools, tripId, 4);
    expect(completion).toBeUndefined();
    const approved = await harness.pool.query<{ status: string }>(
      `SELECT status FROM odft_app.itineraries WHERE id = $1`,
      [itineraryId],
    );
    expect(approved.rows[0]?.status).toBe("approved");
  }, 420_000);

  it("stops at the three-attempt bound and opens the existing clarification", async () => {
    const { tripId, sessionId } = await createCoordinatorTrip(harness.pool);
    const { program } = await driveToProgramChoices(tripId, sessionId);
    await submitProgram(tripId, sessionId, program);
    const approvalPark = await driveUntilParked(harness.pools, tripId, 12);
    expect(approvalPark?.waitReason).toBe("itinerary_approval");
    const approval = await pendingDecision(tripId);
    const itineraryId = (approval.optionPayload as { itineraryId?: string }).itineraryId as string;
    await resume(tripId, sessionId, approval.id, {
      action: "approve_itinerary",
      itineraryId,
    });
    await driveUntilParked(harness.pools, tripId, 4);

    // The Rome inventory holds two museum-tagged activities; three are
    // impossible, so every bounded attempt is invalid and the loop must stop.
    const revision = await harness.pool.query<{ revision: number }>(
      `SELECT revision FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    const admitted = await admitOperation(harness.pool, {
      tripId,
      sessionId,
      request: {
        requestId: crypto.randomUUID(),
        expectedRevision: revision.rows[0]?.revision ?? 0,
        command: { type: "set_activity_requirement", tag: "museum", minimumCount: 3 },
      } as never,
    });
    expect("operationId" in admitted).toBe(true);

    const clarificationPark = await driveUntilParked(harness.pools, tripId, 16);
    expect(clarificationPark?.step).toBe("awaiting_user");
    expect(clarificationPark?.waitReason).toBe("clarification");
    expect(clarificationPark?.runData.planningAttempt).toBe(3);

    const drafts = await harness.pool.query<{
      version: number;
      validation: { status: string; errors: { code: string }[] };
    }>(
      `SELECT version, validation FROM odft_app.itineraries
        WHERE trip_id = $1 ORDER BY version`,
      [tripId],
    );
    const bounded = drafts.rows.slice(1);
    expect(bounded).toHaveLength(3);
    for (const draft of bounded) {
      expect(draft.validation.status).toBe("invalid");
      expect(draft.validation.errors.map((error) => error.code)).toContain(
        "unmet_minimum_activity_count",
      );
    }
    const delegationCount = await harness.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.agent_delegations
        WHERE trip_id = $1 AND skill_id = 'itinerary.propose.v1'`,
      [tripId],
    );
    // One initial approved attempt + exactly three bounded replans.
    expect(delegationCount.rows[0]?.count).toBe("4");

    const decision = await pendingDecision(tripId);
    expect(decision.kind).toBe("clarification");
    expect(String((decision.optionPayload as { question?: string } | null)?.question)).toContain(
      "at least 3",
    );
    const prefs = await harness.pool.query<{
      preferences: { minimumActivityCounts: Record<string, number> };
    }>(
      `SELECT preferences FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    // No silent reduction of the stored requirement.
    expect(prefs.rows[0]?.preferences.minimumActivityCounts.museum).toBe(3);
  }, 420_000);

  it("stages a route change impact preview before cancelling confirmed reservations", async () => {
    const { tripId, sessionId } = await createCoordinatorTrip(harness.pool);
    const { program } = await driveToProgramChoices(tripId, sessionId);
    await submitProgram(tripId, sessionId, program);
    const approvalPark = await driveUntilParked(harness.pools, tripId, 12);
    expect(approvalPark?.waitReason).toBe("itinerary_approval");
    const approval = await pendingDecision(tripId);
    const itineraryId = (approval.optionPayload as { itineraryId?: string }).itineraryId as string;
    await resume(tripId, sessionId, approval.id, {
      action: "approve_itinerary",
      itineraryId,
    });
    await driveUntilParked(harness.pools, tripId, 4);

    const reservationsBefore = await harness.pool.query<{ service_key: string }>(
      `SELECT service_key FROM odft_app.reservations
        WHERE trip_id = $1 AND status = 'confirmed' ORDER BY service_key`,
      [tripId],
    );
    expect(reservationsBefore.rows.length).toBeGreaterThanOrEqual(2);

    const revision = await harness.pool.query<{ revision: number }>(
      `SELECT revision FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    const admitted = await admitOperation(harness.pool, {
      tripId,
      sessionId,
      request: {
        requestId: crypto.randomUUID(),
        expectedRevision: revision.rows[0]?.revision ?? 0,
        command: { type: "set_route", travelVariant: "one_night" },
      } as never,
    });
    expect("operationId" in admitted).toBe(true);

    const previewPark = await driveUntilParked(harness.pools, tripId, 4);
    expect(previewPark?.waitReason).toBe("route_change_confirmation");
    const preview = await pendingDecision(tripId);
    expect(preview.kind).toBe("route_change_confirmation");
    const previewPayload = preview.optionPayload as {
      proposalId?: string;
      affectedReservations?: { id: string }[];
    } | null;
    expect(previewPayload?.proposalId).toBeTruthy();
    const affected = previewPayload?.affectedReservations ?? [];
    expect(affected.length).toBeGreaterThan(0);

    // Nothing is cancelled before the confirmation is accepted.
    const unchanged = await harness.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.reservations
        WHERE trip_id = $1 AND status = 'confirmed'`,
      [tripId],
    );
    expect(Number(unchanged.rows[0]?.count ?? "0")).toBe(reservationsBefore.rows.length);

    await resume(tripId, sessionId, preview.id, {
      action: "confirm_route_change",
      proposalId: previewPayload?.proposalId,
      affectedReservationIds: affected.map((entry) => entry.id),
    });
    const flightPark = await driveUntilParked(harness.pools, tripId, 8);
    expect(flightPark?.waitReason).toBe("flight_choice");

    const variant = await harness.pool.query<{ travel_variant: string }>(
      `SELECT travel_variant FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    expect(variant.rows[0]?.travel_variant).toBe("one_night");
  }, 420_000);

  it("applies a natural-language pace request and persists the assistant wording", async () => {
    const { tripId, sessionId } = await createCoordinatorTrip(harness.pool);
    const { program } = await driveToProgramChoices(tripId, sessionId);
    const chosen = await submitProgram(tripId, sessionId, program);
    const approvalPark = await driveUntilParked(harness.pools, tripId, 12);
    expect(approvalPark?.waitReason).toBe("itinerary_approval");
    const approval = await pendingDecision(tripId);
    const itineraryId = (approval.optionPayload as { itineraryId?: string }).itineraryId as string;
    await resume(tripId, sessionId, approval.id, {
      action: "approve_itinerary",
      itineraryId,
    });
    await driveUntilParked(harness.pools, tripId, 4);

    const revision = await harness.pool.query<{ revision: number }>(
      `SELECT revision FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    const admitted = await admitOperation(harness.pool, {
      tripId,
      sessionId,
      request: {
        requestId: crypto.randomUUID(),
        expectedRevision: revision.rows[0]?.revision ?? 0,
        chat: "make the day less exhausting",
      } as never,
      userMessage: "make the day less exhausting",
    });
    expect("operationId" in admitted).toBe(true);

    const replanPark = await driveUntilParked(harness.pools, tripId, 12);
    expect(replanPark?.waitReason).toBe("itinerary_approval");

    const pace = await harness.pool.query<{ preferences: { activityPace: string } }>(
      `SELECT preferences FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    expect(pace.rows[0]?.preferences.activityPace).toBe("relaxed");

    const selections = await harness.pool.query<{ service_key: string; offer_id: string }>(
      `SELECT service_key, offer_id FROM odft_app.trip_selections
        WHERE trip_id = $1 AND service_key IN ('hotel','breakfast','lunch','dinner')
        ORDER BY service_key`,
      [tripId],
    );
    const byKey = new Map(selections.rows.map((row) => [row.service_key, row.offer_id]));
    expect(byKey.get("breakfast")).toBe(chosen.breakfast);
    expect(byKey.get("lunch")).toBe(chosen.lunch);
    expect(byKey.get("dinner")).toBe(chosen.dinner);
    expect(byKey.get("hotel")).toBeTruthy();

    const messages = await harness.pool.query<{ role: string; content: string }>(
      `SELECT role, content FROM odft_app.conversation_messages
        WHERE trip_id = $1 ORDER BY sequence`,
      [tripId],
    );
    const assistant = messages.rows.filter((row) => row.role === "assistant");
    expect(assistant.length).toBeGreaterThanOrEqual(1);
    expect(assistant.at(-1)?.content).toContain("relaxed");
  }, 420_000);

  it("repairs an injected invalid first attempt within the bounded loop", async () => {
    const { tripId, sessionId } = await createCoordinatorTrip(harness.pool);
    await driveToProgramChoices(tripId, sessionId);

    const revision = await harness.pool.query<{ revision: number }>(
      `SELECT revision FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    const armed = await admitOperation(harness.pool, {
      tripId,
      sessionId,
      request: {
        requestId: crypto.randomUUID(),
        expectedRevision: revision.rows[0]?.revision ?? 0,
        command: { type: "set_simulation", mode: "invalid_itinerary" },
      } as never,
    });
    expect("operationId" in armed).toBe(true);
    const reopened = await driveUntilParked(harness.pools, tripId, 4);
    expect(reopened?.waitReason).toBe("program_choices");

    const program = await pendingDecision(tripId);
    await submitProgram(tripId, sessionId, program);
    const approvalPark = await driveUntilParked(harness.pools, tripId, 12);
    expect(approvalPark?.waitReason).toBe("itinerary_approval");
    // Attempt 1 was deliberately corrupted and repaired on attempt 2.
    expect(approvalPark?.runData.planningAttempt).toBe(2);
    const approval = await pendingDecision(tripId);
    const itineraryId = (approval.optionPayload as { itineraryId?: string }).itineraryId as string;
    const itinerary = await harness.pool.query<{
      validation: { status: string };
      simulated_failure: boolean;
      simulated_failure_note: string | null;
    }>(
      `SELECT validation, simulated_failure, simulated_failure_note
         FROM odft_app.itineraries WHERE id = $1`,
      [itineraryId],
    );
    expect(itinerary.rows[0]?.validation.status).toBe("valid");
    expect(itinerary.rows[0]?.simulated_failure).toBe(true);
    expect(itinerary.rows[0]?.simulated_failure_note).toContain("repaired");

    await resume(tripId, sessionId, approval.id, {
      action: "approve_itinerary",
      itineraryId,
    });
    await driveUntilParked(harness.pools, tripId, 4);
  }, 420_000);

  it("replans after a pace change while keeping confirmed hotel/meal selections", async () => {
    const { tripId, sessionId } = await createCoordinatorTrip(harness.pool);
    const { program } = await driveToProgramChoices(tripId, sessionId);
    const chosen = await submitProgram(tripId, sessionId, program);
    const approvalPark = await driveUntilParked(harness.pools, tripId, 12);
    expect(approvalPark?.waitReason).toBe("itinerary_approval");
    const approval = await pendingDecision(tripId);
    const itineraryId = (approval.optionPayload as { itineraryId?: string }).itineraryId as string;
    await resume(tripId, sessionId, approval.id, {
      action: "approve_itinerary",
      itineraryId,
    });
    await driveUntilParked(harness.pools, tripId, 4);

    const before = await harness.pool.query<{
      hotel_offer_id: string | null;
      breakfast: string | null;
      lunch: string | null;
      dinner: string | null;
    }>(
      `SELECT
         (SELECT offer_id FROM odft_app.trip_selections
           WHERE trip_id = $1 AND service_key = 'hotel') AS hotel_offer_id,
         (SELECT offer_id FROM odft_app.trip_selections
           WHERE trip_id = $1 AND service_key = 'breakfast') AS breakfast,
         (SELECT offer_id FROM odft_app.trip_selections
           WHERE trip_id = $1 AND service_key = 'lunch') AS lunch,
         (SELECT offer_id FROM odft_app.trip_selections
           WHERE trip_id = $1 AND service_key = 'dinner') AS dinner`,
      [tripId],
    );
    expect(before.rows[0]?.hotel_offer_id).toBeTruthy();
    expect(before.rows[0]?.breakfast).toBe(chosen.breakfast);
    expect(before.rows[0]?.lunch).toBe(chosen.lunch);
    expect(before.rows[0]?.dinner).toBe(chosen.dinner);

    // A typed preference command is a new operation; the coordinator refreshes
    // only the affected attractions, then rebuilds the itinerary.
    const revision = await harness.pool.query<{ revision: number }>(
      `SELECT revision FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    const admitted = await admitOperation(harness.pool, {
      tripId,
      sessionId,
      request: {
        requestId: crypto.randomUUID(),
        expectedRevision: revision.rows[0]?.revision ?? 0,
        command: { type: "set_activity_pace", pace: "relaxed" },
      } as never,
    });
    expect("operationId" in admitted).toBe(true);

    const replanPark = await driveUntilParked(harness.pools, tripId, 12);
    expect(replanPark?.step).toBe("awaiting_user");
    expect(replanPark?.waitReason).toBe("itinerary_approval");
    const replanDecision = await pendingDecision(tripId);
    expect(replanDecision.kind).toBe("itinerary_approval");

    const after = await harness.pool.query<{
      hotel_offer_id: string | null;
      breakfast: string | null;
      lunch: string | null;
      dinner: string | null;
    }>(
      `SELECT
         (SELECT offer_id FROM odft_app.trip_selections
           WHERE trip_id = $1 AND service_key = 'hotel') AS hotel_offer_id,
         (SELECT offer_id FROM odft_app.trip_selections
           WHERE trip_id = $1 AND service_key = 'breakfast') AS breakfast,
         (SELECT offer_id FROM odft_app.trip_selections
           WHERE trip_id = $1 AND service_key = 'lunch') AS lunch,
         (SELECT offer_id FROM odft_app.trip_selections
           WHERE trip_id = $1 AND service_key = 'dinner') AS dinner`,
      [tripId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);

    const pace = await harness.pool.query<{ preferences: { activityPace: string } }>(
      `SELECT preferences FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    expect(pace.rows[0]?.preferences.activityPace).toBe("relaxed");
  }, 420_000);
});
