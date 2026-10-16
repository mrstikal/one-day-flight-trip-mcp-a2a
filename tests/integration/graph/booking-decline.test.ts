import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  admitResume,
  createTrip,
  dinnerSlotAvailable,
  getPendingDecisionForTrip,
  loadSnapshotContent,
} from "@odft/persistence";
import { createFixtureSession } from "../../fixtures/session.js";
import { fixtureCreationInput } from "../../fixtures/trip.js";
import {
  approvePendingItinerary,
  claimNextOrFail,
  createGraphTestPool,
  createTravelDriver,
  createWorkerPools,
  endWorkerPools,
  itineraryRows,
  resetGraphDatabase,
  runCommand,
  tripRevision,
  type WorkerPools,
} from "../itinerary/_setup.js";

/**
 * Phase 12 "I don't want to book": declining the staged flight/hotel booking
 * keeps the offer as the trip's selection. No reservation is created, but the
 * plan is built exactly as if the service existed (airport buffer, costs), the
 * overviews mark it "Not booked", and it can still be booked later.
 */

interface DraftCostItem {
  readonly key: string;
  readonly category: string;
}

interface DraftEvent {
  readonly kind: string;
}

/** The fixture default is two-nights; a one-night trip returns the same day. */
async function createOneNightTrip(pool: Pool): Promise<{ tripId: string; sessionId: string }> {
  const sessionClient = await pool.connect();
  let sessionId: string;
  try {
    sessionId = await createFixtureSession(sessionClient);
  } finally {
    sessionClient.release();
  }
  const created = await createTrip(pool, {
    sessionId,
    input: fixtureCreationInput({ travelVariant: "one_night" }),
  });
  if (!("tripId" in created)) {
    throw new Error(`fixture createTrip failed: ${created.code}`);
  }
  return { sessionId, tripId: created.tripId };
}

async function pendingKind(pools: WorkerPools, tripId: string): Promise<string | null> {
  return (await getPendingDecisionForTrip(pools.operations, tripId))?.kind ?? null;
}

/**
 * Submit the program honoring the deterministic dinner slot: a same-day return
 * (one-night trip) leaves no feasible dinner window, and submitting one anyway
 * is refused by the logistics check (exactly the "early return" acceptance).
 */
async function submitProgramHonoringDinner(
  pool: Pool,
  pools: WorkerPools,
  driver: ReturnType<typeof createTravelDriver>,
  tripId: string,
  sessionId: string,
): Promise<string | null> {
  const decision = await getPendingDecisionForTrip(pools.operations, tripId);
  expect(decision?.kind).toBe("program_choices");
  const client = await pool.connect();
  let mealIds: { breakfast: string; lunch: string; dinner: string | null };
  try {
    const tripRow = await client.query<{ snapshot_id: string }>(
      `SELECT active_scenario_snapshot_id AS snapshot_id FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    const content = await loadSnapshotContent(client, tripRow.rows[0]?.snapshot_id as string);
    if (!content) {
      throw new Error("the fixture snapshot is not materialized");
    }
    const slot = await dinnerSlotAvailable(client, tripId, content);
    const offered = new Set(decision?.allowedOfferIds ?? []);
    const offeredByMeal = (meal: string): string =>
      content.restaurants.find((offer) => offer.meal === meal && offered.has(offer.id))?.id ?? "";
    mealIds = {
      breakfast: offeredByMeal("breakfast"),
      lunch: offeredByMeal("lunch"),
      dinner: slot.available ? offeredByMeal("dinner") : null,
    };
  } finally {
    client.release();
  }
  const admitted = await admitResume(pool, {
    tripId,
    sessionId,
    request: {
      requestId: randomUUID(),
      expectedRevision: await tripRevision(pool, tripId),
      decisionId: decision?.id ?? "",
      response: {
        action: "submit_program",
        mealOfferIds: mealIds,
        preferredActivityIds: (decision?.allowedOptionIds ?? []).slice(0, 2),
      } as never,
    },
  });
  expect("operationId" in admitted).toBe(true);
  await driver.runOperation(await claimNextOrFail(pools));
  return pendingKind(pools, tripId);
}

async function declineStagedBooking(
  pool: Pool,
  pools: WorkerPools,
  driver: ReturnType<typeof createTravelDriver>,
  tripId: string,
  sessionId: string,
): Promise<void> {
  const confirmation = await getPendingDecisionForTrip(pools.operations, tripId);
  expect(confirmation?.kind).toBe("booking_confirmation");
  const admitted = await admitResume(pool, {
    tripId,
    sessionId,
    request: {
      requestId: randomUUID(),
      expectedRevision: await tripRevision(pool, tripId),
      decisionId: confirmation?.id ?? "",
      response: {
        action: "decline_booking",
        proposalId: confirmation?.proposalId as string,
      } as never,
    },
  });
  expect("operationId" in admitted).toBe(true);
  await driver.runOperation(await claimNextOrFail(pools));
}

async function chooseOffer(
  pool: Pool,
  pools: WorkerPools,
  driver: ReturnType<typeof createTravelDriver>,
  tripId: string,
  sessionId: string,
): Promise<void> {
  const decision = await getPendingDecisionForTrip(pools.operations, tripId);
  const admitted = await admitResume(pool, {
    tripId,
    sessionId,
    request: {
      requestId: randomUUID(),
      expectedRevision: await tripRevision(pool, tripId),
      decisionId: decision?.id ?? "",
      response: {
        action: "choose_offer",
        offerId: decision?.allowedOfferIds[0] as string,
      } as never,
    },
  });
  expect("operationId" in admitted).toBe(true);
  await driver.runOperation(await claimNextOrFail(pools));
}

describe("declined flight/hotel bookings (real PostgreSQL)", () => {
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

  it("keeps the selection, plans around it, and allows a later booking", async () => {
    const { tripId, sessionId } = await createOneNightTrip(pool);
    const driver = createTravelDriver(pools);
    await driver.runOperation(await claimNextOrFail(pools));
    expect(await pendingKind(pools, tripId)).toBe("flight_choice");

    // Choose a flight, then decline the simulated booking: the offer is kept as
    // the trip's selection and the run continues into hotel research.
    await chooseOffer(pool, pools, driver, tripId, sessionId);
    expect(await pendingKind(pools, tripId)).toBe("booking_confirmation");
    await declineStagedBooking(pool, pools, driver, tripId, sessionId);

    const flightSelection = await pool.query<{ offer_id: string }>(
      `SELECT offer_id FROM odft_app.trip_selections
        WHERE trip_id = $1 AND service_key = 'flights'`,
      [tripId],
    );
    expect(flightSelection.rows).toHaveLength(1);
    expect(await pendingKind(pools, tripId)).toBe("hotel_choice");

    // Decline the hotel booking too, then submit the program.
    await chooseOffer(pool, pools, driver, tripId, sessionId);
    expect(await pendingKind(pools, tripId)).toBe("booking_confirmation");
    await declineStagedBooking(pool, pools, driver, tripId, sessionId);
    const kept = await pool.query<{ service_key: string }>(
      `SELECT service_key FROM odft_app.trip_selections
        WHERE trip_id = $1 AND service_key IN ('flights','hotel') ORDER BY service_key`,
      [tripId],
    );
    expect(kept.rows.map((row) => row.service_key)).toEqual(["flights", "hotel"]);
    const reservations = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.reservations WHERE trip_id = $1`,
      [tripId],
    );
    expect(Number(reservations.rows[0]?.count ?? "0")).toBe(0);
    expect(await pendingKind(pools, tripId)).toBe("program_choices");

    // The plan is built exactly as if the flight and hotel existed: the same-day
    // return produces the airport buffer and both services are costed.
    expect(await submitProgramHonoringDinner(pool, pools, driver, tripId, sessionId)).toBe(
      "itinerary_approval",
    );
    const drafts = await itineraryRows(pool, tripId);
    const draft = drafts[drafts.length - 1];
    expect(draft?.validation.status).toBe("valid");
    const events = (draft?.events ?? []) as DraftEvent[];
    expect(events.some((event) => event.kind === "airport_buffer")).toBe(true);
    const items = (draft?.costs as unknown as { items: DraftCostItem[] }).items;
    expect(items.some((item) => item.category === "flights")).toBe(true);
    expect(items.some((item) => item.category === "hotel")).toBe(true);

    await approvePendingItinerary(pool, pools, tripId, sessionId);

    // Late booking from the "Not booked" review: staging the kept offer opens
    // the ordinary confirmation, and confirming creates the reservation and
    // replans the itinerary (like a late meal reservation).
    const keptFlightId = flightSelection.rows[0]?.offer_id as string;
    await runCommand(
      pool,
      pools,
      { tripId, sessionId },
      { type: "propose_selection", service: "flights", offerId: keptFlightId },
    );
    expect(await pendingKind(pools, tripId)).toBe("booking_confirmation");
    const confirmation = await getPendingDecisionForTrip(pools.operations, tripId);
    const admitted = await admitResume(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: await tripRevision(pool, tripId),
        decisionId: confirmation?.id ?? "",
        response: {
          action: "confirm_booking",
          proposalId: confirmation?.proposalId as string,
          acceptedDemoDisclaimer: true,
        } as never,
      },
    });
    expect("operationId" in admitted).toBe(true);
    await driver.runOperation(await claimNextOrFail(pools));

    const booked = await pool.query<{ service_key: string }>(
      `SELECT service_key FROM odft_app.reservations
        WHERE trip_id = $1 AND status = 'confirmed'`,
      [tripId],
    );
    expect(booked.rows.map((row) => row.service_key)).toEqual(["flights"]);
    const afterBooking = await itineraryRows(pool, tripId);
    expect(afterBooking.length).toBeGreaterThan(drafts.length);
  }, 240_000);
});
