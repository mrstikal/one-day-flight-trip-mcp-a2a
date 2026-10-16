import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  snapshotContentSchema,
  type DecisionBindingRecord,
  type DomainCommand,
} from "@odft/contracts";
import { admitOperation, admitResume, getPendingDecisionForTrip } from "@odft/persistence";
import {
  approvePendingItinerary,
  claimNextOrFail,
  createGraphTestPool,
  createHarnessTrip,
  createTestAiService,
  createTravelDriver,
  createWorkerPools,
  driveTripToReady,
  endWorkerPools,
  readTravelState,
  resetGraphDatabase,
  sendChat,
  tripRevision,
  type WorkerPools,
} from "../ai/_setup.js";

/** Shared Phase 10 itinerary fixtures (real PostgreSQL). */

export {
  approvePendingItinerary,
  claimNextOrFail,
  createGraphTestPool,
  createHarnessTrip,
  createTestAiService,
  createTravelDriver,
  createWorkerPools,
  driveTripToReady,
  endWorkerPools,
  readTravelState,
  resetGraphDatabase,
  sendChat,
  tripRevision,
  type WorkerPools,
};

export type Harness = { readonly tripId: string; readonly sessionId: string };

/** Admit one typed command and run it to completion. */
export async function runCommand(
  pool: Pool,
  pools: WorkerPools,
  { tripId, sessionId }: Harness,
  command: DomainCommand,
): Promise<void> {
  const admitted = await admitOperation(pool, {
    tripId,
    sessionId,
    request: {
      requestId: randomUUID(),
      expectedRevision: await tripRevision(pool, tripId),
      command,
    },
  });
  if (!("operationId" in admitted) && !("status" in admitted)) {
    throw new Error(`command admission refused: ${JSON.stringify(admitted)}`);
  }
  await createTravelDriver(pools).runOperation(await claimNextOrFail(pools));
}

/**
 * Submit the pending program decision and run the resulting planning operation.
 * Returns the pending decision kind afterwards (`null` when the trip is
 * decision-free).
 */
export async function submitProgram(
  pool: Pool,
  pools: WorkerPools,
  { tripId, sessionId }: Harness,
): Promise<string | null> {
  const decision = await getPendingDecisionForTrip(pools.operations, tripId);
  if (decision?.kind !== "program_choices") {
    throw new Error(`expected program_choices, got ${String(decision?.kind)}`);
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
  const admitted = await admitResume(pool, {
    tripId,
    sessionId,
    request: {
      requestId: randomUUID(),
      expectedRevision: await tripRevision(pool, tripId),
      decisionId: decision.id,
      response: {
        action: "submit_program",
        mealOfferIds: {
          breakfast: offeredByMeal("breakfast"),
          lunch: offeredByMeal("lunch"),
          dinner: offeredByMeal("dinner"),
        },
        preferredActivityIds: (decision.allowedOptionIds ?? []).slice(0, 2),
      } as never,
    },
  });
  if (!("operationId" in admitted)) {
    throw new Error(`program submission refused: ${JSON.stringify(admitted)}`);
  }
  await createTravelDriver(pools).runOperation(await claimNextOrFail(pools));
  const next = await getPendingDecisionForTrip(pools.operations, tripId);
  return next?.kind ?? null;
}

/** Choose one offered clarification/recovery option and run the resume. */
export async function chooseOption(
  pool: Pool,
  pools: WorkerPools,
  { tripId, sessionId }: Harness,
  optionId: string,
): Promise<string | null> {
  const decision = await getPendingDecisionForTrip(pools.operations, tripId);
  if (!decision) {
    throw new Error("no pending decision to answer");
  }
  const admitted = await admitResume(pool, {
    tripId,
    sessionId,
    request: {
      requestId: randomUUID(),
      expectedRevision: await tripRevision(pool, tripId),
      decisionId: decision.id,
      response: { action: "choose_option", optionId } as never,
    },
  });
  if (!("operationId" in admitted)) {
    throw new Error(`option choice refused: ${JSON.stringify(admitted)}`);
  }
  await createTravelDriver(pools).runOperation(await claimNextOrFail(pools));
  const next = await getPendingDecisionForTrip(pools.operations, tripId);
  return next?.kind ?? null;
}

export interface ItineraryRow {
  version: number;
  status: string;
  events: unknown;
  validation: {
    status: string;
    errors: { code: string; message: string }[];
    warnings: { code: string }[];
    metrics: { totalCostMinor: number; activityCount: number; visitMinutes: number };
    sourceFingerprint: string;
  };
  costs: { totalMinor: number; items: { key: string; amountMinor: number }[] };
  review: unknown;
  simulated_failure: boolean;
  simulated_failure_note: string | null;
}

export async function itineraryRows(pool: Pool, tripId: string): Promise<ItineraryRow[]> {
  const result = await pool.query<ItineraryRow>(
    `SELECT version, status, events, validation, costs, review,
            simulated_failure, simulated_failure_note
       FROM odft_app.itineraries WHERE trip_id = $1 ORDER BY version`,
    [tripId],
  );
  return result.rows;
}

export async function pendingDecision(
  pools: WorkerPools,
  tripId: string,
): Promise<DecisionBindingRecord | undefined> {
  return getPendingDecisionForTrip(pools.operations, tripId);
}

export async function optionPayload(
  pool: Pool,
  decisionId: string,
): Promise<{
  question?: string;
  options?: { id: string; label: string }[];
  requestedCommands?: { type: string; tag?: string; minimumCount?: number | null }[];
} | null> {
  const result = await pool.query<{ option_payload: unknown }>(
    `SELECT option_payload FROM odft_app.pending_decisions WHERE id = $1`,
    [decisionId],
  );
  return (result.rows[0]?.option_payload as never) ?? null;
}