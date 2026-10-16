import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RESEARCH_DOMAINS } from "@odft/contracts";
import { getPendingDecisionForTrip } from "@odft/persistence";
import {
  armFault,
  createGraphTestPool,
  createHarnessTrip,
  createWorkerPools,
  driveToFlightConfirmed,
  endWorkerPools,
  readTravelState,
  researchEvents,
  resetGraphDatabase,
  type WorkerPools,
} from "./_setup.js";

/**
 * T-IT-FAULT-01 (Phase 09, scenario C): a deterministic empty compatible hotel
 * set is a tagged `unavailable` result, never a retry, and the necessary-domain
 * gate opens an explicit recovery decision. The confirmed flight stays; no
 * itinerary or downstream confirmation starts.
 */

describe("deterministic empty domain (real PostgreSQL)", () => {
  let pool: Pool;
  let pools: WorkerPools;

  beforeAll(async () => {
    pool = createGraphTestPool();
    pools = createWorkerPools(8);
  });

  beforeEach(async () => {
    await resetGraphDatabase(pool);
  });

  afterAll(async () => {
    await endWorkerPools(pools);
    await pool.end();
  });

  it("explains the hotel gap, keeps the flight, and starts no itinerary", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await armFault(pool, tripId, "hotels", "hotels_unavailable");

    await driveToFlightConfirmed(pool, pools, tripId, sessionId);

    const events = await researchEvents(pool, tripId);
    const finished = events.filter((event) => event.phase === "finished");
    const hotelFinished = finished.filter((event) => event.domain === "hotel");
    expect(hotelFinished).toHaveLength(1);
    expect(hotelFinished[0]?.status).toBe("unavailable");
    expect(hotelFinished[0]?.simulatedFailure).toBe(true);
    expect(hotelFinished[0]?.reason).toContain("Simulated failure");
    // The deterministic empty result is not retried.
    expect(finished.filter((event) => event.domain === "hotel")).toHaveLength(1);
    for (const domain of RESEARCH_DOMAINS.filter((entry) => entry !== "hotel")) {
      const sibling = finished.filter((event) => event.domain === domain);
      expect(sibling).toHaveLength(1);
      expect(sibling[0]?.status).toBe("ok");
    }

    const state = await readTravelState(pools, tripId);
    expect(state.values.researchStatus).toBe("failed");
    expect(state.values.researchFailedDomains).toEqual(["hotel"]);
    expect(state.values.gate).toBe("research_failed");
    expect(state.values.nextDecisionKind).toBe("recovery");
    expect(String(state.values.researchReason)).toContain("hotel");
    const results = state.values.researchResults as Record<
      string,
      { domain: string; status: string; reason: string | null; simulatedFailure: boolean }
    >;
    const hotel = Object.values(results).find((result) => result.domain === "hotel");
    expect(hotel?.status).toBe("unavailable");
    expect(hotel?.simulatedFailure).toBe(true);
    expect(hotel?.reason).toContain("Simulated failure");

    // The recovery decision offers only the adjustment that can help.
    const decision = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(decision?.kind).toBe("recovery");
    expect(decision?.allowedOptionIds).toEqual(["change_hotel"]);

    // The confirmed flight remains; nothing else was reserved or planned.
    const reservations = await pool.query<{ service_key: string }>(
      `SELECT service_key FROM odft_app.reservations WHERE trip_id = $1 AND status = 'confirmed'`,
      [tripId],
    );
    expect(reservations.rows.map((row) => row.service_key)).toEqual(["flights"]);
    const itineraries = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.itineraries WHERE trip_id = $1`,
      [tripId],
    );
    expect(itineraries.rows[0]?.count).toBe("0");
    const proposals = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.selection_proposals
        WHERE trip_id = $1 AND status = 'proposed'`,
      [tripId],
    );
    expect(proposals.rows[0]?.count).toBe("0");
  }, 120_000);

  it("records the fault in overlay counters without touching the inventory", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await armFault(pool, tripId, "hotels", "hotels_unavailable");
    await driveToFlightConfirmed(pool, pools, tripId, sessionId);

    const counters = await pool.query<{ counters: Record<string, number>; state: unknown }>(
      `SELECT counters, state FROM odft_app.simulation_faults
        WHERE trip_id = $1 AND domain = 'hotels' AND fault = 'hotels_unavailable'
        ORDER BY updated_at DESC LIMIT 1`,
      [tripId],
    );
    expect(counters.rows[0]?.counters["attempts"]).toBe(1);
    expect(counters.rows[0]?.counters["injected"]).toBe(1);

    const snapshots = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.scenario_snapshots WHERE trip_id = $1`,
      [tripId],
    );
    // The flight snapshot plus the one-time domain extension: research itself
    // never regenerates or re-extends the inventory.
    expect(snapshots.rows[0]?.count).toBe("2");
  }, 120_000);
});