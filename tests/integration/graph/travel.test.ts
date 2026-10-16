import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  admitResume,
  applyTripCommand,
  createTrip,
  getPendingDecisionForTrip,
  TripCommandError,
} from "@odft/persistence";
import { createFixtureSession } from "../../fixtures/session.js";
import { fixtureCreationInput } from "../../fixtures/trip.js";
import {
  claimNextOrFail,
  createGraphTestPool,
  createHarnessTrip,
  createTravelDriver,
  createWorkerPools,
  endWorkerPools,
  readTravelState,
  resetGraphDatabase,
  type WorkerPools,
} from "./_setup.js";

/**
 * T-IT-FLT-01/02: the production travel graph over real PostgreSQL. Route
 * feasibility, flight generation, independent schedule validation, the
 * flight-choice and booking decisions, and the single demo reservation.
 */

describe("travel graph (real PostgreSQL)", () => {
  let pool: Pool;
  let pools: WorkerPools;

  beforeAll(async () => {
    pool = createGraphTestPool();
    pools = createWorkerPools();
  });

  beforeEach(async () => {
    await resetGraphDatabase(pool);
  });

  afterAll(async () => {
    await endWorkerPools(pools);
    await pool.end();
  });

  it("drives PRG -> Rome to a flight choice, stages a proposal, and books exactly once", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    const driver = createTravelDriver(pools);

    // Creation run stops at the flight_choice interrupt.
    await driver.runOperation(await claimNextOrFail(pools));
    let state = await readTravelState(pools, tripId);
    expect(state.values.routeStatus).toBe("FEASIBLE");
    expect(state.values.scheduleStatus).toBe("VALID");
    expect((state.values.validCombinationIds as string[]).length).toBeGreaterThanOrEqual(3);

    const created = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(created?.kind).toBe("flight_choice");
    const offerIds = created?.allowedOfferIds ?? [];
    expect(offerIds.length).toBeGreaterThanOrEqual(3);

    // Resume with the first offered combination.
    const chosen = await admitResume(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: 1,
        decisionId: created?.id ?? "",
        response: { action: "choose_offer", offerId: offerIds[0] as string },
      },
    });
    expect("operationId" in chosen).toBe(true);

    await driver.runOperation(await claimNextOrFail(pools));
    state = await readTravelState(pools, tripId);
    expect(state.values.gate).toBe("awaiting_booking");

    const confirmation = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(confirmation?.kind).toBe("booking_confirmation");
    expect(confirmation?.proposalId).toBeTruthy();
    expect(confirmation?.allowedOfferIds).toEqual([offerIds[0]]);

    // Confirm the booking.
    const confirmed = await admitResume(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: 1,
        decisionId: confirmation?.id ?? "",
        response: {
          action: "confirm_booking",
          proposalId: confirmation?.proposalId as string,
          acceptedDemoDisclaimer: true,
        },
      },
    });
    expect("operationId" in confirmed).toBe(true);

    await driver.runOperation(await claimNextOrFail(pools));
    const trip = await pool.query<{ workflow_status: string }>(
      `SELECT workflow_status FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    // Phase 07: a confirmed flight no longer ends the run; it continues into
    // hotel research and the hotel-choice decision.
    expect(trip.rows[0]?.workflow_status).toBe("waiting_user");
    state = await readTravelState(pools, tripId);
    expect(state.values.gate).toBe("hotels_ready");
    expect(String(state.values.demoReference)).toMatch(/^DEMO-FLT-[0-9A-F]{20}$/);

    const reservations = await pool.query<{ count: string; demo_reference: string }>(
      `SELECT count(*)::text AS count, min(demo_reference) AS demo_reference
         FROM odft_app.reservations WHERE trip_id = $1 AND status = 'confirmed'`,
      [tripId],
    );
    expect(reservations.rows[0]?.count).toBe("1");
    expect(reservations.rows[0]?.demo_reference).toBe(state.values.demoReference);

    const hotelChoice = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(hotelChoice?.kind).toBe("hotel_choice");
    expect((hotelChoice?.allowedOfferIds ?? []).length).toBeGreaterThanOrEqual(1);

    // P1-2: changing the route after a confirmed reservation is refused, not
    // silently applied (which would desync the summary from the booking).
    await expect(
      applyTripCommand(pool, {
        tripId,
        command: { type: "set_route", travelVariant: "one_night" },
      }),
    ).rejects.toBeInstanceOf(TripCommandError);
  }, 60_000);

  it("routes PRG -> Ceske Budejovice to the gating summary and creates no offers", async () => {
    const sessionClient = await pool.connect();
    let sessionId: string;
    try {
      sessionId = await createFixtureSession(sessionClient);
    } finally {
      sessionClient.release();
    }
    const created = await createTrip(pool, {
      sessionId,
      input: fixtureCreationInput({
        destinationCityId: "geonames:3077916",
        destinationCountryKey: "CZ",
      }),
    });
    if (!("tripId" in created)) {
      throw new Error("fixture createTrip failed");
    }

    const driver = createTravelDriver(pools);
    await driver.runOperation(await claimNextOrFail(pools));

    const state = await readTravelState(pools, created.tripId);
    expect(state.values.routeStatus).toBe("INFEASIBLE");
    expect(state.values.gate).toBe("route_rejected");
    expect((state.values.validCombinationIds as string[]).length).toBe(0);
    expect(state.values.snapshotId).toBeNull();

    const snapshots = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.scenario_snapshots WHERE trip_id = $1`,
      [created.tripId],
    );
    expect(snapshots.rows[0]?.count).toBe("0");
    const decisions = await getPendingDecisionForTrip(pools.operations, created.tripId);
    expect(decisions).toBeUndefined();
  }, 60_000);

  it("allows rejecting the staged proposal and re-selecting a flight (P2-6)", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    const driver = createTravelDriver(pools);
    await driver.runOperation(await claimNextOrFail(pools));

    const flightChoice = await getPendingDecisionForTrip(pools.operations, tripId);
    const offerId = flightChoice?.allowedOfferIds[0] as string;
    const chosen = await admitResume(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: 1,
        decisionId: flightChoice?.id ?? "",
        response: { action: "choose_offer", offerId },
      },
    });
    expect("operationId" in chosen).toBe(true);
    await driver.runOperation(await claimNextOrFail(pools));

    const confirmation = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(confirmation?.kind).toBe("booking_confirmation");

    const rejected = await admitResume(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: 1,
        decisionId: confirmation?.id ?? "",
        response: { action: "reject_proposal", proposalId: confirmation?.proposalId as string },
      },
    });
    expect("operationId" in rejected).toBe(true);

    await driver.runOperation(await claimNextOrFail(pools));
    const again = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(again?.kind).toBe("flight_choice");
    expect((again?.allowedOfferIds ?? []).length).toBeGreaterThanOrEqual(3);
    const state = await readTravelState(pools, tripId);
    expect(state.values.gate).toBe("flights_ready");
  }, 60_000);
});
