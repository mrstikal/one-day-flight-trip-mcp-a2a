import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { snapshotContentSchema } from "@odft/contracts";
import { admitOperation, admitResume, getPendingDecisionForTrip } from "@odft/persistence";
import {
  approvePendingItinerary,
  approvePendingItineraryIfAny,
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
 * Phase 07 replacement flow (AC-07-2, P1 finding): a confirmed meal can be
 * replaced only through an explicit `replacement_confirmation` decision; the
 * other services and reservation rows stay untouched.
 */

describe("travel graph phase 07 replacement (real PostgreSQL)", () => {
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

  async function revision(tripId: string): Promise<number> {
    const result = await pool.query<{ revision: number }>(
      `SELECT revision FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    return result.rows[0]?.revision ?? 0;
  }

  async function answer(tripId: string, sessionId: string, response: unknown): Promise<void> {
    const decision = await getPendingDecisionForTrip(pools.operations, tripId);
    await admitResume(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: await revision(tripId),
        decisionId: decision?.id ?? "",
        response: response as never,
      },
    });
  }

  it("stages and confirms a dinner replacement without touching other services", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    const driver = createTravelDriver(pools);

    // Flights.
    await driver.runOperation(await claimNextOrFail(pools));
    const flightDecision = await getPendingDecisionForTrip(pools.operations, tripId);
    await answer(tripId, sessionId, {
      action: "choose_offer",
      offerId: flightDecision?.allowedOfferIds[0] as string,
    });
    await driver.runOperation(await claimNextOrFail(pools));
    const flightConfirmation = await getPendingDecisionForTrip(pools.operations, tripId);
    await answer(tripId, sessionId, {
      action: "confirm_booking",
      proposalId: flightConfirmation?.proposalId as string,
      acceptedDemoDisclaimer: true,
    });
    await driver.runOperation(await claimNextOrFail(pools));

    // Hotel.
    const hotelDecision = await getPendingDecisionForTrip(pools.operations, tripId);
    await answer(tripId, sessionId, {
      action: "choose_offer",
      offerId: hotelDecision?.allowedOfferIds[0] as string,
    });
    await driver.runOperation(await claimNextOrFail(pools));
    const hotelConfirmation = await getPendingDecisionForTrip(pools.operations, tripId);
    await answer(tripId, sessionId, {
      action: "confirm_booking",
      proposalId: hotelConfirmation?.proposalId as string,
      acceptedDemoDisclaimer: true,
    });
    await driver.runOperation(await claimNextOrFail(pools));

    const snapshot = await pool.query<{ inventory: unknown }>(
      `SELECT s.inventory FROM odft_app.scenario_snapshots s
         JOIN odft_app.trips t ON t.active_scenario_snapshot_id = s.id
        WHERE t.id = $1`,
      [tripId],
    );
    const content = snapshotContentSchema.parse(snapshot.rows[0]?.inventory);
    const program = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(program?.kind).toBe("program_choices");
    const offered = new Set(program?.allowedOfferIds ?? []);
    const dinners = content.restaurants
      .filter((offer) => offer.meal === "dinner" && offered.has(offer.id))
      .map((offer) => offer.id);
    const breakfast = content.restaurants.find(
      (offer) => offer.meal === "breakfast" && offered.has(offer.id),
    )?.id as string;
    const lunch = content.restaurants.find(
      (offer) => offer.meal === "lunch" && offered.has(offer.id),
    )?.id as string;
    expect(dinners.length).toBeGreaterThanOrEqual(2);

    // Program choices (no reservations yet).
    await answer(tripId, sessionId, {
      action: "submit_program",
      mealOfferIds: { breakfast, lunch, dinner: dinners[0] },
      preferredActivityIds: [],
    });
    await driver.runOperation(await claimNextOrFail(pools));
    expect((await readTravelState(pools, tripId)).values.programApplied).toBe(true);

    // Phase 10: the valid program opens the itinerary approval; resolve it so a
    // later command is not a pending-decision conflict.
    await approvePendingItinerary(pool, pools, tripId, sessionId);

    // Optional dinner reservation through propose_selection + confirmation.
    const proposed = await admitOperation(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: await revision(tripId),
        command: { type: "propose_selection", service: "dinner", offerId: dinners[0] as string },
      },
    });
    expect("operationId" in proposed).toBe(true);
    await driver.runOperation(await claimNextOrFail(pools));
    const dinnerConfirmation = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(dinnerConfirmation?.kind).toBe("booking_confirmation");
    await answer(tripId, sessionId, {
      action: "confirm_booking",
      proposalId: dinnerConfirmation?.proposalId as string,
      acceptedDemoDisclaimer: true,
    });
    await driver.runOperation(await claimNextOrFail(pools));
    // Phase 10: confirming a meal booking rebuilds the itinerary draft; approve
    // it so the following command is not a pending-decision conflict.
    await approvePendingItineraryIfAny(pool, pools, tripId, sessionId);

    // AC-10-6: the confirmed dinner is locked to its persisted window and keeps
    // the offer's fixed duration in the rebuilt itinerary.
    const confirmedDinner = content.restaurants.find((offer) => offer.id === dinners[0]);
    const dinnerWindowStart = /^(\d{2}):(\d{2})/.exec(confirmedDinner?.windowStart ?? "");
    const expectedStartMinute =
      Number(dinnerWindowStart?.[1] ?? "0") * 60 + Number(dinnerWindowStart?.[2] ?? "0");
    const latestItinerary = await pool.query<{
      events: { kind: string; refId: string | null; locked: boolean; startMinute: number; durationMinutes: number }[];
    }>(
      `SELECT events FROM odft_app.itineraries WHERE trip_id = $1 ORDER BY version DESC LIMIT 1`,
      [tripId],
    );
    const lockedDinner = latestItinerary.rows[0]?.events.find(
      (event) => event.kind === "meal" && event.refId === dinners[0],
    );
    expect(lockedDinner?.locked).toBe(true);
    expect(lockedDinner?.startMinute).toBe(expectedStartMinute);
    expect(lockedDinner?.durationMinutes).toBe(confirmedDinner?.durationMinutes);

    // Submit a different dinner via set_program: it must stage a replacement.
    const setProgram = await admitOperation(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: await revision(tripId),
        command: {
          type: "set_program",
          mealOfferIds: { breakfast, lunch, dinner: dinners[1] as string },
          selfArrangedMeals: [],
          preferredActivityIds: [],
          activitiesSelfArranged: false,
        },
      },
    });
    expect("operationId" in setProgram).toBe(true);
    await driver.runOperation(await claimNextOrFail(pools));

    const replacement = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(replacement?.kind).toBe("replacement_confirmation");
    expect(replacement?.proposalId).toBeTruthy();

    await answer(tripId, sessionId, {
      action: "confirm_booking",
      proposalId: replacement?.proposalId as string,
      acceptedDemoDisclaimer: true,
    });
    await driver.runOperation(await claimNextOrFail(pools));

    // Phase 10: the replacement commit rebuilds the itinerary; approve the new
    // draft so the trip returns to a decision-free ready state.
    await approvePendingItineraryIfAny(pool, pools, tripId, sessionId);

    const state = await readTravelState(pools, tripId);
    expect(state.values.gate).toBe("approved");

    const dinnerRows = await pool.query<{ status: string; offer_id: string }>(
      `SELECT status, offer_id FROM odft_app.reservations
        WHERE trip_id = $1 AND service_key = 'dinner' ORDER BY created_at`,
      [tripId],
    );
    expect(dinnerRows.rows.map((row) => row.status)).toEqual(["superseded", "confirmed"]);
    expect(dinnerRows.rows[1]?.offer_id).toBe(dinners[1]);

    // Other services: exactly one confirmed reservation each, unchanged.
    const others = await pool.query<{ service_key: string; count: string }>(
      `SELECT service_key, count(*)::text AS count FROM odft_app.reservations
        WHERE trip_id = $1 AND status = 'confirmed' AND service_key <> 'dinner'
        GROUP BY service_key ORDER BY service_key`,
      [tripId],
    );
    expect(others.rows).toEqual([
      { service_key: "flights", count: "1" },
      { service_key: "hotel", count: "1" },
    ]);
  }, 120_000);
});
