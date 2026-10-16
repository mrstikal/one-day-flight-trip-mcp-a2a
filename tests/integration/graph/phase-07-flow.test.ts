import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { snapshotContentSchema } from "@odft/contracts";
import {
  admitOperation,
  admitResume,
  dinnerSlotAvailable,
  getPendingDecisionForTrip,
  planProgramSelections,
  ServiceSelectionError,
} from "@odft/persistence";
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
 * Phase 07: the production travel graph continues from a confirmed flight into
 * hotel research, a hotel reservation, and the program-choices decision, then
 * applies meal selections without booking them.
 */

describe("travel graph phase 07 (real PostgreSQL)", () => {
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

  async function chooseDecision(
    tripId: string,
    sessionId: string,
    expected: { kind: string },
    response: unknown,
  ): Promise<string> {
    const decision = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(decision?.kind).toBe(expected.kind);
    const admitted = await admitResume(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: 1,
        decisionId: decision?.id ?? "",
        response: response as never,
      },
    });
    expect("operationId" in admitted).toBe(true);
    return decision?.id ?? "";
  }

  it("books a hotel then applies the program choices without booking meals", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    const driver = createTravelDriver(pools);

    // Flights: creation -> flight choice -> confirm -> hotel choice.
    await driver.runOperation(await claimNextOrFail(pools));
    const flightDecision = await getPendingDecisionForTrip(pools.operations, tripId);
    const flightOffer = flightDecision?.allowedOfferIds[0] as string;
    await chooseDecision(
      tripId,
      sessionId,
      { kind: "flight_choice" },
      { action: "choose_offer", offerId: flightOffer },
    );
    await driver.runOperation(await claimNextOrFail(pools));
    const flightConfirmation = await getPendingDecisionForTrip(pools.operations, tripId);
    await admitResume(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: 1,
        decisionId: flightConfirmation?.id ?? "",
        response: {
          action: "confirm_booking",
          proposalId: flightConfirmation?.proposalId as string,
          acceptedDemoDisclaimer: true,
        },
      },
    });
    await driver.runOperation(await claimNextOrFail(pools));

    let state = await readTravelState(pools, tripId);
    expect(state.values.gate).toBe("hotels_ready");
    expect((state.values.hotelOfferIds as string[]).length).toBeGreaterThanOrEqual(1);

    // Hotel: choose -> confirm. Confirmation continues into program choices.
    const hotelDecision = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(hotelDecision?.kind).toBe("hotel_choice");
    const hotelOffer = hotelDecision?.allowedOfferIds[0] as string;
    await chooseDecision(
      tripId,
      sessionId,
      { kind: "hotel_choice" },
      { action: "choose_offer", offerId: hotelOffer },
    );
    await driver.runOperation(await claimNextOrFail(pools));
    const hotelConfirmation = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(hotelConfirmation?.kind).toBe("booking_confirmation");
    expect(hotelConfirmation?.allowedOfferIds).toEqual([hotelOffer]);

    const hotelConfirmed = await admitResume(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: 1,
        decisionId: hotelConfirmation?.id ?? "",
        response: {
          action: "confirm_booking",
          proposalId: hotelConfirmation?.proposalId as string,
          acceptedDemoDisclaimer: true,
        },
      },
    });
    expect("operationId" in hotelConfirmed).toBe(true);
    await driver.runOperation(await claimNextOrFail(pools));

    const program = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(program?.kind).toBe("program_choices");
    expect((program?.allowedOptionIds ?? []).length).toBeGreaterThanOrEqual(1);

    const snapshot = await pool.query<{ inventory: unknown }>(
      `SELECT s.inventory FROM odft_app.scenario_snapshots s
         JOIN odft_app.trips t ON t.active_scenario_snapshot_id = s.id
        WHERE t.id = $1`,
      [tripId],
    );
    const content = snapshotContentSchema.parse(snapshot.rows[0]?.inventory);
    const offered = new Set(program?.allowedOfferIds ?? []);
    const offeredByMeal = (meal: string): string =>
      content.restaurants.find((offer) => offer.meal === meal && offered.has(offer.id))?.id ??
      ("" as string);
    const breakfast = offeredByMeal("breakfast");
    const lunch = offeredByMeal("lunch");
    const dinner = offeredByMeal("dinner");
    expect(breakfast).not.toBe("");
    expect(lunch).not.toBe("");
    expect(dinner).not.toBe("");
    const activityIds = (program?.allowedOptionIds ?? []).slice(0, 2);

    // The null-dinner rule is deterministic: it is refused only when a feasible
    // dinner slot exists (return late enough for the window + buffer).
    const slot = await dinnerSlotAvailable(pool, tripId, content);
    if (slot.available) {
      await expect(
        planProgramSelections(pool, {
          tripId,
          mealSelections: { breakfast, lunch, dinner: null },
          selfArrangedMeals: [],
        }),
      ).rejects.toBeInstanceOf(ServiceSelectionError);
    } else {
      await expect(
        planProgramSelections(pool, {
          tripId,
          mealSelections: { breakfast, lunch, dinner: null },
          selfArrangedMeals: [],
        }),
      ).resolves.toBeDefined();
    }

    await chooseDecision(
      tripId,
      sessionId,
      { kind: "program_choices" },
      {
        action: "submit_program",
        mealOfferIds: { breakfast, lunch, dinner },
        preferredActivityIds: activityIds,
      },
    );
    await driver.runOperation(await claimNextOrFail(pools));

    state = await readTravelState(pools, tripId);
    expect(state.values.programApplied).toBe(true);

    const reservations = await pool.query<{ service_key: string; demo_reference: string }>(
      `SELECT service_key, demo_reference FROM odft_app.reservations
        WHERE trip_id = $1 AND status = 'confirmed' ORDER BY service_key`,
      [tripId],
    );
    expect(reservations.rows.map((row) => row.service_key)).toEqual(["flights", "hotel"]);
    for (const row of reservations.rows) {
      const prefix = row.service_key === "flights" ? "DEMO-FLT-" : "DEMO-HTL-";
      expect(row.demo_reference.startsWith(prefix)).toBe(true);
    }

    const selections = await pool.query<{ service_key: string }>(
      `SELECT service_key FROM odft_app.trip_selections
        WHERE trip_id = $1 AND service_key IN ('breakfast','lunch','dinner')
        ORDER BY service_key`,
      [tripId],
    );
    expect(selections.rows.map((row) => row.service_key)).toEqual(["breakfast", "dinner", "lunch"]);

    // Phase 10: a valid program continues into itinerary planning and waits at
    // the `itinerary_approval` decision instead of ending the run directly.
    const itineraryDecision = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(itineraryDecision?.kind).toBe("itinerary_approval");
    const itineraryState = await readTravelState(pools, tripId);
    expect(itineraryState.values.itineraryStatus).toBe("draft");
    expect(itineraryState.values.itineraryValidationStatus).toBe("valid");
    expect(itineraryState.values.planningAttempt).toBeGreaterThanOrEqual(1);
    expect(itineraryState.values.planningAttempt).toBeLessThanOrEqual(3);
    const itineraryId = itineraryState.values.itineraryId as string;
    await chooseDecision(
      tripId,
      sessionId,
      { kind: "itinerary_approval" },
      { action: "approve_itinerary", itineraryId },
    );
    await driver.runOperation(await claimNextOrFail(pools));

    const itineraryRow = await pool.query<{ status: string; version: number }>(
      `SELECT status, version FROM odft_app.itineraries WHERE id = $1`,
      [itineraryId],
    );
    expect(itineraryRow.rows[0]?.status).toBe("approved");

    const trip = await pool.query<{ workflow_status: string }>(
      `SELECT workflow_status FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    expect(trip.rows[0]?.workflow_status).toBe("ready");

    // A preference change after booking must resume at the relevant step, not
    // restart the flight flow: with an applied program a pace change replans
    // directly into a fresh itinerary approval (2026-10-13 product decision).
    const revisionRow = await pool.query<{ revision: number }>(
      `SELECT revision FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    const paced = await admitOperation(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: revisionRow.rows[0]?.revision ?? 0,
        command: { type: "set_activity_pace", pace: "relaxed" },
      },
    });
    expect("operationId" in paced).toBe(true);
    await driver.runOperation(await claimNextOrFail(pools));
    const reDerived = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(reDerived?.kind).toBe("itinerary_approval");
  }, 90_000);
});
