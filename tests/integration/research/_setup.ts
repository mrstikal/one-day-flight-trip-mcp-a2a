import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { admitResume, getPendingDecisionForTrip, upsertFault } from "@odft/persistence";
import {
  claimNextOrFail,
  createGraphTestPool,
  createHarnessTrip,
  createTravelDriver,
  createWorkerPools,
  endWorkerPools,
  readTravelState,
  resetGraphDatabase,
  testServerConfig,
  type WorkerPools,
} from "../graph/_setup.js";

/** Shared Phase 09 research fixture: drive a trip to the post-flight research run. */

export {
  claimNextOrFail,
  createGraphTestPool,
  createHarnessTrip,
  createTravelDriver,
  createWorkerPools,
  endWorkerPools,
  readTravelState,
  resetGraphDatabase,
  testServerConfig,
  type WorkerPools,
};

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

/**
 * Open `count` real connections and release them back to the pool, so the six
 * parallel research tasks acquire idle connections immediately and their
 * execution windows genuinely overlap (no per-task TCP setup latency).
 */
export async function prewarmPool(pool: Pool, count: number): Promise<void> {
  const clients = await Promise.all(Array.from({ length: count }, () => pool.connect()));
  for (const client of clients) {
    client.release();
  }
}

/**
 * Create a trip and confirm a flight: the confirmation operation runs
 * `ensure_domains` -> `validate_schedules` -> `dispatch_research` and returns
 * with the next decision pending (`hotel_choice`, a research-failure recovery,
 * or nothing when the run ended).
 */
export async function driveToFlightConfirmed(
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
  await prewarmPool(pools.operations, 6);
  await driver.runOperation(await claimNextOrFail(pools));
}

export async function armFault(
  pool: Pool,
  tripId: string,
  domain: "hotels" | "breakfast" | "lunch" | "dinner" | "activities" | "events",
  fault: "provider_failure" | "hotels_unavailable" | "no_flights",
): Promise<void> {
  await upsertFault(pool, { tripId, domain, fault });
}

export interface DomainEvent {
  readonly domain: string;
  readonly phase: "started" | "finished";
  readonly attempt: number;
  readonly status: string | null;
  readonly simulatedFailure: boolean;
  readonly reason: string | null;
  readonly fingerprint: string | null;
  readonly operationId: string;
  readonly createdAt: Date;
}

export async function researchEvents(pool: Pool, tripId: string): Promise<DomainEvent[]> {
  const result = await pool.query<{
    operation_id: string;
    type: string;
    payload: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT operation_id, type, payload, created_at FROM odft_app.execution_events
      WHERE trip_id = $1 AND type IN ('research.domain_started','research.domain_finished')
      ORDER BY id ASC`,
    [tripId],
  );
  return result.rows.map((row) => ({
    domain: String(row.payload["domain"]),
    phase: row.type === "research.domain_started" ? "started" : "finished",
    attempt: typeof row.payload["attempt"] === "number" ? row.payload["attempt"] : 0,
    status: typeof row.payload["status"] === "string" ? row.payload["status"] : null,
    simulatedFailure: row.payload["simulatedFailure"] === true,
    reason: typeof row.payload["reason"] === "string" ? row.payload["reason"] : null,
    fingerprint: typeof row.payload["fingerprint"] === "string" ? row.payload["fingerprint"] : null,
    operationId: row.operation_id,
    createdAt: row.created_at,
  }));
}

export async function snapshotManifest(
  pool: Pool,
  tripId: string,
): Promise<{
  snapshotId: string;
  domainHashes: Record<string, string>;
  domainVersions: Record<string, number>;
  snapshotCount: number;
}> {
  const result = await pool.query<{ id: string; manifest: Record<string, unknown> }>(
    `SELECT s.id, s.manifest FROM odft_app.scenario_snapshots s
       JOIN odft_app.trips t ON t.active_scenario_snapshot_id = s.id
      WHERE t.id = $1`,
    [tripId],
  );
  const countResult = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM odft_app.scenario_snapshots WHERE trip_id = $1`,
    [tripId],
  );
  const row = result.rows[0];
  return {
    snapshotId: row?.id ?? "",
    domainHashes: (row?.manifest["domainContentHashes"] ?? {}) as Record<string, string>,
    domainVersions: (row?.manifest["domainVersions"] ?? {}) as Record<string, number>,
    snapshotCount: Number.parseInt(countResult.rows[0]?.count ?? "0", 10),
  };
}

/** Count node updates for one graph node (one per superstep it ran in). */
export async function nodeRunCount(pool: Pool, tripId: string, node: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM odft_app.execution_events
      WHERE trip_id = $1 AND type = 'node.updated' AND payload->>'node' = $2`,
    [tripId, node],
  );
  return Number.parseInt(result.rows[0]?.count ?? "0", 10);
}