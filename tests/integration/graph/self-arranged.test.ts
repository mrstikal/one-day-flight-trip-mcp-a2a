import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { domainCommandSchema, publicDecisionResponseSchema } from "@odft/contracts";
import {
  admitOperation,
  admitResume,
  getPendingDecisionForTrip,
  planProgramSelections,
  ServiceSelectionError,
} from "@odft/persistence";
import { randomUUID } from "node:crypto";
import {
  approvePendingItinerary,
  claimNextOrFail,
  createGraphTestPool,
  createHarnessTrip,
  createTravelDriver,
  createWorkerPools,
  driveTripToReady,
  endWorkerPools,
  itineraryRows,
  resetGraphDatabase,
  runCommand,
  tripRevision,
  type WorkerPools,
} from "../itinerary/_setup.js";

/**
 * Explicit "I'll arrange it myself" program state: a distinct persisted state
 * (never a null selection) that hides the offers, keeps the meal/activities out
 * of the plan, and surfaces again in the itinerary costs as self-arranged.
 */

interface DraftEvent {
  readonly kind: string;
  readonly refId: string | null;
}

function eventsOf(events: unknown): DraftEvent[] {
  return events as DraftEvent[];
}

describe("self-arranged program state (real PostgreSQL)", () => {
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

  it("stores the state, excludes it from the plan, and lifts it again", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, tripId, sessionId);

    const selections = await pool.query<{ service_key: string; offer_id: string }>(
      `SELECT service_key, offer_id FROM odft_app.trip_selections
        WHERE trip_id = $1 AND service_key IN ('breakfast','lunch','dinner')`,
      [tripId],
    );
    const byMeal = new Map(selections.rows.map((row) => [row.service_key, row.offer_id]));
    const breakfast = byMeal.get("breakfast");
    const lunch = byMeal.get("lunch");
    const dinner = byMeal.get("dinner");
    expect(breakfast).toBeTruthy();
    expect(lunch).toBeTruthy();
    expect(dinner).toBeTruthy();

    // Baseline: the planned day contains a breakfast meal and sightseeing.
    const baseline = await itineraryRows(pool, tripId);
    const baselineEvents = eventsOf(baseline[baseline.length - 1]?.events);
    expect(baselineEvents.some((event) => event.kind === "activity")).toBe(true);
    expect(
      baselineEvents.some((event) => event.kind === "meal" && event.refId === breakfast),
    ).toBe(true);

    // Mark breakfast and the activities as self-arranged.
    await runCommand(pool, pools, { tripId, sessionId }, {
      type: "set_program",
      mealOfferIds: { breakfast: null, lunch: lunch as string, dinner: dinner as string },
      selfArrangedMeals: ["breakfast"],
      preferredActivityIds: [],
      activitiesSelfArranged: true,
    });

    const stateRows = await pool.query<{ service_key: string }>(
      `SELECT service_key FROM odft_app.self_arranged_services WHERE trip_id = $1 ORDER BY service_key`,
      [tripId],
    );
    expect(stateRows.rows.map((row) => row.service_key)).toEqual(["activities", "breakfast"]);

    // The breakfast selection row is gone; lunch and dinner stay selected.
    const after = await pool.query<{ service_key: string }>(
      `SELECT service_key FROM odft_app.trip_selections
        WHERE trip_id = $1 AND service_key IN ('breakfast','lunch','dinner') ORDER BY service_key`,
      [tripId],
    );
    expect(after.rows.map((row) => row.service_key)).toEqual(["dinner", "lunch"]);

    // The replanned draft keeps the day valid without the self-arranged parts.
    const drafts = await itineraryRows(pool, tripId);
    expect(drafts.length).toBeGreaterThan(baseline.length);
    const draft = drafts[drafts.length - 1];
    expect(draft?.validation.status).toBe("valid");
    const draftEvents = eventsOf(draft?.events);
    expect(draftEvents.some((event) => event.kind === "activity")).toBe(false);
    expect(draftEvents.some((event) => event.kind === "meal" && event.refId === breakfast)).toBe(
      false,
    );
    const notes = (draft?.costs as unknown as { excludedNotes: string[] }).excludedNotes;
    expect(notes).toContain("Breakfast is self-arranged and not part of the plan.");
    expect(notes).toContain("Activities are self-arranged and not part of the plan.");

    // Approve the new draft, then lift both states again.
    await approvePendingItinerary(pool, pools, tripId, sessionId);
    await runCommand(pool, pools, { tripId, sessionId }, {
      type: "set_program",
      mealOfferIds: {
        breakfast: breakfast as string,
        lunch: lunch as string,
        dinner: dinner as string,
      },
      selfArrangedMeals: [],
      preferredActivityIds: [],
      activitiesSelfArranged: false,
    });

    const liftedState = await pool.query(
      `SELECT service_key FROM odft_app.self_arranged_services WHERE trip_id = $1`,
      [tripId],
    );
    expect(liftedState.rows).toHaveLength(0);
    const restored = await itineraryRows(pool, tripId);
    const restoredDraft = restored[restored.length - 1];
    expect(restoredDraft?.validation.status).toBe("valid");
    const restoredEvents = eventsOf(restoredDraft?.events);
    expect(restoredEvents.some((event) => event.kind === "activity")).toBe(true);
    expect(
      restoredEvents.some((event) => event.kind === "meal" && event.refId === breakfast),
    ).toBe(true);
  }, 120_000);

  it("refuses inconsistent payloads and never removes a confirmed meal", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, tripId, sessionId);

    const selections = await pool.query<{ service_key: string; offer_id: string }>(
      `SELECT service_key, offer_id FROM odft_app.trip_selections
        WHERE trip_id = $1 AND service_key IN ('breakfast','lunch','dinner')`,
      [tripId],
    );
    const byMeal = new Map(selections.rows.map((row) => [row.service_key, row.offer_id]));
    const breakfast = byMeal.get("breakfast") as string;
    const lunch = byMeal.get("lunch") as string;
    const dinner = byMeal.get("dinner") as string;

    // A null breakfast without the self-arranged state is refused by the contract.
    const unmarked = domainCommandSchema.safeParse({
      type: "set_program",
      mealOfferIds: { breakfast: null, lunch, dinner },
      selfArrangedMeals: [],
      preferredActivityIds: [],
      activitiesSelfArranged: false,
    });
    expect(unmarked.success).toBe(false);
    const unmarkedDecision = publicDecisionResponseSchema.safeParse({
      action: "submit_program",
      mealOfferIds: { breakfast: null, lunch, dinner },
      preferredActivityIds: [],
    });
    expect(unmarkedDecision.success).toBe(false);
    const markedDecision = publicDecisionResponseSchema.safeParse({
      action: "submit_program",
      mealOfferIds: { breakfast: null, lunch, dinner },
      selfArrangedMeals: ["breakfast"],
      preferredActivityIds: [],
    });
    expect(markedDecision.success).toBe(true);

    // Selecting and self-arranging the same meal is contradictory.
    const contradictory = domainCommandSchema.safeParse({
      type: "set_program",
      mealOfferIds: { breakfast, lunch, dinner },
      selfArrangedMeals: ["breakfast"],
      preferredActivityIds: [],
      activitiesSelfArranged: false,
    });
    expect(contradictory.success).toBe(false);

    // Confirm a lunch reservation, then the state cannot remove it.
    const proposed = await admitOperation(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: await tripRevision(pool, tripId),
        command: { type: "propose_selection", service: "lunch", offerId: lunch },
      },
    });
    expect("operationId" in proposed).toBe(true);
    const driver = createTravelDriver(pools);
    await driver.runOperation(await claimNextOrFail(pools));
    const confirmation = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(confirmation?.kind).toBe("booking_confirmation");
    const confirmed = await admitResume(pool, {
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
    expect("operationId" in confirmed).toBe(true);
    await driver.runOperation(await claimNextOrFail(pools));

    await expect(
      planProgramSelections(pool, {
        tripId,
        mealSelections: { breakfast, lunch: null, dinner },
        selfArrangedMeals: ["lunch"],
      }),
    ).rejects.toBeInstanceOf(ServiceSelectionError);

    const reservation = await pool.query<{ status: string }>(
      `SELECT status FROM odft_app.reservations
        WHERE trip_id = $1 AND service_key = 'lunch'`,
      [tripId],
    );
    expect(reservation.rows.map((row) => row.status)).toEqual(["confirmed"]);
  }, 120_000);
});