import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { snapshotContentSchema } from "@odft/contracts";
import { admitOperation, admitResume, getPendingDecisionForTrip } from "@odft/persistence";
import type { AiService } from "../../../apps/worker/src/ai/service.js";
import {
  claimNextOrFail,
  createFixtureTrip,
  createTestAiService,
  createTestPool,
  createWorkerPools,
  endWorkerPools,
  resetDatabase,
  type WorkerPools,
} from "../_setup.js";
import { coordinatorDriver, driveUntilParked } from "../coordinator/_setup.js";

/**
 * AI integration helpers on the coordinator runtime (Phase 11). The legacy
 * graph helpers were replaced one-for-one so the AI behavior tests keep
 * exercising the real admission/decision/ports path.
 */

export {
  claimNextOrFail,
  createFixtureTrip,
  createTestAiService,
  createTestPool,
  createWorkerPools,
  endWorkerPools,
  resetDatabase,
  type WorkerPools,
};

export function createTravelDriver(
  pools: WorkerPools,
  ai?: AiService,
): ReturnType<typeof coordinatorDriver> {
  return coordinatorDriver(pools, ai ? { ai } : {});
}

export async function tripRevision(pool: Pool, tripId: string): Promise<number> {
  const result = await pool.query<{ revision: number }>(
    `SELECT revision FROM odft_app.trips WHERE id = $1`,
    [tripId],
  );
  return result.rows[0]?.revision ?? 0;
}

export async function resolveDecision(
  pool: Pool,
  pools: WorkerPools,
  tripId: string,
  sessionId: string,
  response: unknown,
): Promise<void> {
  const decision = await getPendingDecisionForTrip(pools.operations, tripId);
  if (!decision) {
    throw new Error("expected a pending decision");
  }
  const admitted = await admitResume(pool, {
    tripId,
    sessionId,
    request: {
      requestId: randomUUID(),
      expectedRevision: await tripRevision(pool, tripId),
      decisionId: decision.id,
      response: response as never,
    },
  });
  if (!("operationId" in admitted)) {
    throw new Error(`resume was refused: ${JSON.stringify(admitted)}`);
  }
}

async function driveToProgramChoices(
  pool: Pool,
  pools: WorkerPools,
  tripId: string,
  sessionId: string,
): Promise<void> {
  const flightPark = await driveUntilParked(pools, tripId);
  if (flightPark?.waitReason !== "flight_choice") {
    throw new Error(`expected flight_choice, got ${String(flightPark?.waitReason)}`);
  }
  const flight = await getPendingDecisionForTrip(pools.operations, tripId);
  await resolveDecision(pool, pools, tripId, sessionId, {
    action: "choose_offer",
    offerId: flight?.allowedOfferIds[0] as string,
  });

  const bookingPark = await driveUntilParked(pools, tripId);
  if (bookingPark?.waitReason !== "booking_confirmation") {
    throw new Error(`expected booking_confirmation, got ${String(bookingPark?.waitReason)}`);
  }
  const flightConfirmation = await getPendingDecisionForTrip(pools.operations, tripId);
  await resolveDecision(pool, pools, tripId, sessionId, {
    action: "confirm_booking",
    proposalId: flightConfirmation?.proposalId as string,
    acceptedDemoDisclaimer: true,
  });

  const hotelPark = await driveUntilParked(pools, tripId, 8);
  if (hotelPark?.waitReason !== "hotel_choice") {
    throw new Error(`expected hotel_choice, got ${String(hotelPark?.waitReason)}`);
  }
  const hotel = await getPendingDecisionForTrip(pools.operations, tripId);
  await resolveDecision(pool, pools, tripId, sessionId, {
    action: "choose_offer",
    offerId: hotel?.allowedOfferIds[0] as string,
  });

  const hotelBookingPark = await driveUntilParked(pools, tripId);
  if (hotelBookingPark?.waitReason !== "booking_confirmation") {
    throw new Error(
      `expected hotel booking_confirmation, got ${String(hotelBookingPark?.waitReason)}`,
    );
  }
  const hotelConfirmation = await getPendingDecisionForTrip(pools.operations, tripId);
  await resolveDecision(pool, pools, tripId, sessionId, {
    action: "confirm_booking",
    proposalId: hotelConfirmation?.proposalId as string,
    acceptedDemoDisclaimer: true,
  });

  const programPark = await driveUntilParked(pools, tripId);
  if (programPark?.waitReason !== "program_choices") {
    throw new Error(`expected program_choices, got ${String(programPark?.waitReason)}`);
  }
}

/** Drive PRG -> Rome to a confirmed flight + hotel and an approved itinerary. */
export async function driveTripToReady(
  pool: Pool,
  pools: WorkerPools,
  tripId: string,
  sessionId: string,
): Promise<void> {
  await driveToProgramChoices(pool, pools, tripId, sessionId);
  await submitProgram(pool, pools, tripId, sessionId);
  const approvalPark = await driveUntilParked(pools, tripId, 12);
  if (approvalPark?.waitReason !== "itinerary_approval") {
    throw new Error(`expected itinerary_approval, got ${String(approvalPark?.waitReason)}`);
  }
  await approvePendingItinerary(pool, pools, tripId, sessionId);
  const trip = await pool.query<{ workflow_status: string }>(
    `SELECT workflow_status FROM odft_app.trips WHERE id = $1`,
    [tripId],
  );
  if (trip.rows[0]?.workflow_status !== "ready") {
    throw new Error(`expected ready, got ${String(trip.rows[0]?.workflow_status)}`);
  }
}

async function submitProgram(
  pool: Pool,
  pools: WorkerPools,
  tripId: string,
  sessionId: string,
): Promise<void> {
  const program = await getPendingDecisionForTrip(pools.operations, tripId);
  if (program?.kind !== "program_choices") {
    throw new Error(`expected program_choices, got ${String(program?.kind)}`);
  }
  const snapshot = await pool.query<{ inventory: unknown }>(
    `SELECT s.inventory FROM odft_app.scenario_snapshots s
       JOIN odft_app.trips t ON t.active_scenario_snapshot_id = s.id
      WHERE t.id = $1`,
    [tripId],
  );
  const content = snapshotContentSchema.parse(snapshot.rows[0]?.inventory);
  const offered = new Set(program.allowedOfferIds);
  const offeredByMeal = (meal: string): string =>
    content.restaurants.find((offer) => offer.meal === meal && offered.has(offer.id))?.id ?? "";
  await resolveDecision(pool, pools, tripId, sessionId, {
    action: "submit_program",
    mealOfferIds: {
      breakfast: offeredByMeal("breakfast"),
      lunch: offeredByMeal("lunch"),
      dinner: offeredByMeal("dinner"),
    },
    preferredActivityIds: (program.allowedOptionIds ?? []).slice(0, 2),
  });
}

/** Approve the pending `itinerary_approval` decision and drive to `ready`. */
export async function approvePendingItinerary(
  pool: Pool,
  pools: WorkerPools,
  tripId: string,
  sessionId: string,
): Promise<void> {
  const decision = await getPendingDecisionForTrip(pools.operations, tripId);
  if (decision?.kind !== "itinerary_approval") {
    throw new Error(`expected itinerary_approval, got ${String(decision?.kind)}`);
  }
  const itineraryId =
    (decision.optionPayload as { itineraryId?: string } | null)?.itineraryId ??
    (
      await pool.query<{ id: string }>(
        `SELECT id FROM odft_app.itineraries
          WHERE trip_id = $1 AND status = 'draft'
          ORDER BY created_at DESC LIMIT 1`,
        [tripId],
      )
    ).rows[0]?.id;
  if (!itineraryId) {
    throw new Error("no itinerary draft is active for approval");
  }
  await resolveDecision(pool, pools, tripId, sessionId, {
    action: "approve_itinerary",
    itineraryId,
  });
  await driveUntilParked(pools, tripId, 4);
}

/** Admit one chat message at the trip's current revision and run it. */
export async function sendChat(
  pool: Pool,
  pools: WorkerPools,
  tripId: string,
  sessionId: string,
  message: string,
): Promise<{ readonly operationId: string }> {
  const requestId = randomUUID();
  const admitted = await admitOperation(pool, {
    tripId,
    sessionId,
    request: {
      requestId,
      expectedRevision: await tripRevision(pool, tripId),
      chat: message,
    },
    userMessage: message,
  });
  if (!("status" in admitted) || admitted.status !== "accepted") {
    throw new Error(`chat admission refused: ${JSON.stringify(admitted)}`);
  }
  const driver = createTravelDriver(pools);
  await driver.runOperation(await claimNextOrFail(pools));
  return { operationId: admitted.operationId };
}

/**
 * Re-submit the current program-choices decision so the trip returns to a
 * decision-free `ready` state. Returns the pending decision kind after the run.
 */
export async function resolveProgramChoices(
  pool: Pool,
  pools: WorkerPools,
  tripId: string,
  sessionId: string,
): Promise<string | null> {
  const decision = await getPendingDecisionForTrip(pools.operations, tripId);
  if (decision?.kind !== "program_choices") {
    return decision?.kind ?? null;
  }
  await submitProgram(pool, pools, tripId, sessionId);
  await driveUntilParked(pools, tripId, 12);
  const next = await getPendingDecisionForTrip(pools.operations, tripId);
  if (next?.kind === "itinerary_approval") {
    await approvePendingItinerary(pool, pools, tripId, sessionId);
    return null;
  }
  return next?.kind ?? null;
}
