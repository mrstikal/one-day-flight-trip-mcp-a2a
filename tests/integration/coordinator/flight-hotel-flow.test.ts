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
 * Phase 07 flight -> hotel flow: choose a flight, confirm the booking (the
 * reservation is created by the SAME BookingService as the graph path), then
 * the coordinator delegates hotel + City Guide research CONCURRENTLY and parks
 * the hotel choice with the accommodation artifact's ranked ids.
 */

let harness: CoordinatorHarness;

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

beforeAll(async () => {
  harness = await startCoordinatorHarness();
}, 180_000);

afterAll(async () => {
  await stopCoordinatorHarness(harness);
});

describe("coordinator flight-hotel flow", () => {
  it("books the chosen flight through BookingService and parks the hotel choice from the specialist", async () => {
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
    expect(booking.proposalId).not.toBeNull();

    await resume(tripId, sessionId, booking.id, {
      action: "confirm_booking",
      proposalId: booking.proposalId,
      acceptedDemoDisclaimer: true,
    });
    const hotelPark = await driveUntilParked(harness.pools, tripId, 8);
    expect(hotelPark?.step).toBe("awaiting_user");
    expect(hotelPark?.waitReason).toBe("hotel_choice");

    // The same BookingService created the demo reservation.
    const reservation = await harness.pool.query<{ service_key: string; demo_reference: string; status: string }>(
      `SELECT service_key, demo_reference, status FROM odft_app.reservations
        WHERE trip_id = $1`,
      [tripId],
    );
    expect(reservation.rows[0]?.service_key).toBe("flights");
    expect(reservation.rows[0]?.demo_reference).toMatch(/^DEMO-/);
    expect(reservation.rows[0]?.status).toBe("confirmed");

    // The hotel choice offers ranked hotel ids of the extended snapshot.
    const hotelChoice = await pendingDecision(tripId);
    expect(hotelChoice.kind).toBe("hotel_choice");
    expect(hotelChoice.allowedOfferIds.length).toBeGreaterThan(0);
    const snapshotId = await harness.pool.query<{ active_scenario_snapshot_id: string }>(
      `SELECT active_scenario_snapshot_id FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    const hotels = await harness.pool.query<{ ids: string[] }>(
      `SELECT jsonb_agg(h->>'id') AS ids FROM odft_app.scenario_snapshots s,
              lateral jsonb_array_elements(s.inventory->'hotels') h
        WHERE s.id = $1`,
      [snapshotId.rows[0]?.active_scenario_snapshot_id],
    );
    const hotelIds = new Set(hotels.rows[0]?.ids ?? []);
    expect(hotelIds.size).toBeGreaterThan(0);
    for (const id of hotelChoice.allowedOfferIds) {
      expect(hotelIds.has(id)).toBe(true);
    }

    // Hotel + City Guide delegations were dispatched concurrently and both
    // settled through the real specialists.
    const delegations = await harness.pool.query<{ skill_id: string; status: string }>(
      `SELECT skill_id, status FROM odft_app.agent_delegations WHERE trip_id = $1`,
      [tripId],
    );
    const bySkill = new Map(delegations.rows.map((row) => [row.skill_id, row.status]));
    expect(bySkill.get("flight.recommend.v1")).toBe("completed");
    expect(bySkill.get("accommodation.recommend.v1")).toBe("completed");
    expect(bySkill.get("city-guide.research.v1")).toBe("completed");

    // Choose the hotel, confirm its booking, and the coordinator opens the
    // program choices from the City Guide artifact's ranked domains.
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
    expect(programPark?.step).toBe("awaiting_user");
    expect(programPark?.waitReason).toBe("program_choices");

    const program = await pendingDecision(tripId);
    expect(program.kind).toBe("program_choices");
    expect(program.allowedOfferIds.length).toBeGreaterThan(0);
    // The offered meals are real ranked restaurant ids of the extended snapshot.
    const restaurants = await harness.pool.query<{ ids: string[] }>(
      `SELECT jsonb_agg(r->>'id') AS ids FROM odft_app.scenario_snapshots s,
              lateral jsonb_array_elements(s.inventory->'restaurants') r
        WHERE s.id = $1 AND r->>'meal' IN ('breakfast','lunch','dinner')`,
      [snapshotId.rows[0]?.active_scenario_snapshot_id],
    );
    const restaurantIds = new Set(restaurants.rows[0]?.ids ?? []);
    expect(restaurantIds.size).toBeGreaterThan(0);
    for (const id of program.allowedOfferIds) {
      expect(restaurantIds.has(id)).toBe(true);
    }

    // Two reservations now exist: the flight and the hotel (same BookingService).
    const reservations = await harness.pool.query<{ service_key: string }>(
      `SELECT service_key FROM odft_app.reservations WHERE trip_id = $1 ORDER BY service_key`,
      [tripId],
    );
    expect(reservations.rows.map((row) => row.service_key)).toEqual(["flights", "hotel"]);
  }, 300_000);

  it("finalizes an infeasible route as a blocked outcome with no unanswerable decision", async () => {
    const { tripId } = await createCoordinatorTrip(harness.pool, {
      destinationCityId: "geonames:3077916", // Ceske Budejovice (ground travel preferred)
      destinationCountryKey: "CZ",
      travelVariant: "one_night",
    });
    const run = await driveUntilParked(harness.pools, tripId, 4);
    expect(run).toBeUndefined(); // a completed run is no longer "active"
    const finishedRun = await harness.pool.query<{
      status: string;
      wait_reason: string | null;
    }>(
      `SELECT status, wait_reason FROM odft_app.coordinator_runs
        WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    );
    expect(finishedRun.rows[0]?.status).toBe("completed");
    expect(finishedRun.rows[0]?.wait_reason).toBeNull();

    const trip = await harness.pool.query<{
      workflow_status: string;
      current_route_validation_id: string | null;
    }>(
      `SELECT workflow_status, current_route_validation_id FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    expect(trip.rows[0]?.workflow_status).toBe("blocked");
    const route = await harness.pool.query<{ status: string }>(
      `SELECT status FROM odft_app.route_validations WHERE id = $1`,
      [trip.rows[0]?.current_route_validation_id],
    );
    expect(route.rows[0]?.status).toBe("INFEASIBLE");
    // No pending choice can be offered for a route that cannot be flown.
    const pending = await harness.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.pending_decisions
        WHERE trip_id = $1 AND status = 'pending'`,
      [tripId],
    );
    expect(pending.rows[0]?.count).toBe("0");
  }, 120_000);
});
