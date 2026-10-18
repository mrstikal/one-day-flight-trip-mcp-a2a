import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  admitOperation,
  admitResume,
  cancelOperation,
  getTrip,
} from "@odft/persistence";
import {
  createGraphTestPool,
  createHarnessTrip,
  createWorkerPools,
  endWorkerPools,
  resetGraphDatabase,
  type WorkerPools,
} from "../graph/_setup.js";

/**
 * Phase 09 plan-named history authorization (ODTF_PLAN.md Phase 09 tests):
 * every write path denies archived trips with TRIP_ARCHIVED — commands,
 * resumes (including the dedupe replay path), retries, and cancellation —
 * while reads keep working and the archived trip still projects.
 */

describe("phase 09 history authorization", () => {
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

  async function archivedTrip(): Promise<{ tripId: string; sessionId: string }> {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await pool.query(
      `UPDATE odft_app.trips SET archived_at = now(), archive_reason = 'history test' WHERE id = $1`,
      [tripId],
    );
    return { tripId, sessionId };
  }

  it("denies commands on archived trips, including the dedupe replay", async () => {
    const { tripId, sessionId } = await archivedTrip();
    const requestId = randomUUID();
    const command = {
      tripId,
      sessionId,
      request: {
        requestId,
        expectedRevision: 1,
        command: { type: "find_alternatives", target: "hotel", objective: "match_preferences" },
      },
    } as never;
    const first = await admitOperation(pool, command);
    expect("code" in first ? first.code : "accepted").toBe("TRIP_ARCHIVED");
    // The dedupe replay path denies too (never `accepted` for history).
    const replay = await admitOperation(pool, command);
    expect("code" in replay ? replay.code : "accepted").toBe("TRIP_ARCHIVED");
  });

  it("denies resumes and retries on archived trips", async () => {
    const { tripId, sessionId } = await archivedTrip();
    const resume = await admitResume(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        decisionId: randomUUID(),
        expectedRevision: 1,
        response: { action: "choose_option", optionId: "change_hotel" },
      },
    });
    expect("code" in resume ? resume.code : "accepted").toBe("TRIP_ARCHIVED");

    const created = await pool.query<{ id: string }>(
      `SELECT id FROM odft_app.workflow_operations WHERE trip_id = $1`,
      [tripId],
    );
    const { retryOperation } = await import("@odft/persistence");
    const retry = await retryOperation(pools.operations, {
      tripId,
      sessionId,
      operationId: (created.rows[0] as { id: string }).id,
      controlRequestId: randomUUID(),
      expectedRevision: 1,
    });
    expect("code" in retry ? retry.code : "accepted").toBe("TRIP_ARCHIVED");
  });

  it("denies cancellation on archived trips without leaking the operation", async () => {
    const { tripId, sessionId } = await archivedTrip();
    const created = await pool.query<{ id: string }>(
      `SELECT id FROM odft_app.workflow_operations WHERE trip_id = $1`,
      [tripId],
    );
    const controlRequestId = randomUUID();
    const cancel = await cancelOperation(pools.operations, {
      tripId,
      sessionId,
      operationId: (created.rows[0] as { id: string }).id,
      controlRequestId,
      expectedRevision: 1,
    });
    expect("code" in cancel ? cancel.code : "cancelled").toBe("TRIP_ARCHIVED");
    // The dedupe replay on an archived trip denies too (never a stored result).
    const replay = await cancelOperation(pools.operations, {
      tripId,
      sessionId,
      operationId: (created.rows[0] as { id: string }).id,
      controlRequestId,
      expectedRevision: 1,
    });
    expect("code" in replay ? replay.code : "cancelled").toBe("TRIP_ARCHIVED");
    // A foreign session still sees NOT_FOUND, never the archived flag.
    const foreign = await cancelOperation(pools.operations, {
      tripId,
      sessionId: randomUUID(),
      operationId: (created.rows[0] as { id: string }).id,
      controlRequestId: randomUUID(),
      expectedRevision: 1,
    });
    expect("code" in foreign ? foreign.code : "cancelled").toBe("NOT_FOUND");
  });

  it("keeps archived trips readable with their archive markers", async () => {
    const { tripId } = await archivedTrip();
    const trip = await getTrip(pool, tripId);
    expect(trip?.archivedAt).toBeTruthy();
    expect(trip?.archiveReason).toBe("history test");
  });
});
