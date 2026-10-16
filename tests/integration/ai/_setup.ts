import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { snapshotContentSchema } from "@odft/contracts";
import { admitOperation, admitResume, getPendingDecisionForTrip } from "@odft/persistence";
import {
  approvePendingItinerary,
  claimNextOrFail,
  createGraphTestPool,
  createHarnessTrip,
  createTestAiService,
  createTravelDriver,
  createWorkerPools,
  endWorkerPools,
  readTravelState,
  resetGraphDatabase,
  type WorkerPools,
} from "../graph/_setup.js";

/**
 * Shared Phase 08 integration fixture: drive a harness trip through the Phase 06/07
 * flow to a `ready` state with no pending decision, where chat commands are
 * admitted (a chat while a non-clarification decision is pending is a conflict).
 */

export {
  approvePendingItinerary,
  claimNextOrFail,
  createGraphTestPool,
  createHarnessTrip,
  createTestAiService,
  createTravelDriver,
  createWorkerPools,
  endWorkerPools,
  readTravelState,
  resetGraphDatabase,
  type WorkerPools,
};

async function resolveDecision(
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

export async function tripRevision(pool: Pool, tripId: string): Promise<number> {
  const result = await pool.query<{ revision: number }>(
    `SELECT revision FROM odft_app.trips WHERE id = $1`,
    [tripId],
  );
  return result.rows[0]?.revision ?? 0;
}

/** Drive PRG -> Rome to a confirmed flight + hotel and a submitted program. */
export async function driveTripToReady(
  pool: Pool,
  pools: WorkerPools,
  tripId: string,
  sessionId: string,
): Promise<void> {
  const driver = createTravelDriver(pools);

  await driver.runOperation(await claimNextOrFail(pools));
  const flightDecision = await getPendingDecisionForTrip(pools.operations, tripId);
  await resolveDecision(pool, pools, tripId, sessionId, {
    action: "choose_offer",
    offerId: flightDecision?.allowedOfferIds[0] as string,
  });
  await driver.runOperation(await claimNextOrFail(pools));
  const flightConfirmation = await getPendingDecisionForTrip(pools.operations, tripId);
  await resolveDecision(pool, pools, tripId, sessionId, {
    action: "confirm_booking",
    proposalId: flightConfirmation?.proposalId as string,
    acceptedDemoDisclaimer: true,
  });
  await driver.runOperation(await claimNextOrFail(pools));

  const hotelDecision = await getPendingDecisionForTrip(pools.operations, tripId);
  await resolveDecision(pool, pools, tripId, sessionId, {
    action: "choose_offer",
    offerId: hotelDecision?.allowedOfferIds[0] as string,
  });
  await driver.runOperation(await claimNextOrFail(pools));
  const hotelConfirmation = await getPendingDecisionForTrip(pools.operations, tripId);
  await resolveDecision(pool, pools, tripId, sessionId, {
    action: "confirm_booking",
    proposalId: hotelConfirmation?.proposalId as string,
    acceptedDemoDisclaimer: true,
  });
  await driver.runOperation(await claimNextOrFail(pools));

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
  await driver.runOperation(await claimNextOrFail(pools));

  // Phase 10: a valid program continues into itinerary planning; approve the
  // resulting draft so the trip reaches a decision-free `ready` state.
  await approvePendingItinerary(pool, pools, tripId, sessionId);

  const state = await readTravelState(pools, tripId);
  if (state.values.gate !== "approved") {
    throw new Error(`expected approved, got ${String(state.values.gate)}`);
  }
}

/** Admit one chat message at the trip's current revision and run it. Mirrors the
 * BFF: the user message is stored on admission, linked to the operation. */
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
    // Mirrors the BFF: the message is stored inside the admission transaction.
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
 * decision-free `ready` state (a chat while a non-clarification decision is
 * pending is a deliberate conflict). Returns the pending decision kind after
 * the run: `null` when the trip is decision-free (approval handled), otherwise
 * the clarification/recovery the caller must resolve.
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
  const snapshot = await pool.query<{ inventory: unknown }>(
    `SELECT s.inventory FROM odft_app.scenario_snapshots s
       JOIN odft_app.trips t ON t.active_scenario_snapshot_id = s.id
      WHERE t.id = $1`,
    [tripId],
  );
  const content = snapshotContentSchema.parse(snapshot.rows[0]?.inventory);
  const offered = new Set(decision.allowedOfferIds);
  const offeredByMeal = (meal: string): string =>
    content.restaurants.find((offer) => offer.meal === meal && offered.has(offer.id))?.id ?? "";
  await resolveDecision(pool, pools, tripId, sessionId, {
    action: "submit_program",
    mealOfferIds: {
      breakfast: offeredByMeal("breakfast"),
      lunch: offeredByMeal("lunch"),
      dinner: offeredByMeal("dinner"),
    },
    preferredActivityIds: (decision.allowedOptionIds ?? []).slice(0, 2),
  });
  await createTravelDriver(pools).runOperation(await claimNextOrFail(pools));
  // Phase 10: re-submitting the program rebuilds the itinerary draft; approve it
  // so the caller returns to a decision-free ready state.
  const next = await getPendingDecisionForTrip(pools.operations, tripId);
  if (next?.kind === "itinerary_approval") {
    await approvePendingItinerary(pool, pools, tripId, sessionId);
    return null;
  }
  return next?.kind ?? null;
}
