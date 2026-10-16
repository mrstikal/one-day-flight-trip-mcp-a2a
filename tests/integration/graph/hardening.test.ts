import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  admitResume,
  contentHash,
  finalizeWaiting,
  getPendingDecisionForTrip,
} from "@odft/persistence";
import {
  claimNextOrFail,
  createGraphTestPool,
  createHarnessDriver,
  createHarnessTrip,
  createWorkerPools,
  endWorkerPools,
  resetGraphDatabase,
  type WorkerPools,
} from "./_setup.js";

/**
 * Phase 05 hardening: option membership, atomic fenced finalization, and node
 * progress events.
 */

describe("durable graph hardening", () => {
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

  async function expireLease(operationId: string): Promise<void> {
    await pools.operations.query(
      `UPDATE odft_app.workflow_operations SET lease_expires_at = now() - interval '5 seconds' WHERE id = $1`,
      [operationId],
    );
  }

  it("rejects a choose_option that the pending decision did not offer", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    const driver = createHarnessDriver(pools);
    await driver.runOperation(await claimNextOrFail(pools));

    const decision = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(decision?.allowedOptionIds).toEqual(["continue"]);

    const rejected = await admitResume(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: 1,
        decisionId: decision?.id ?? "",
        response: { action: "choose_option", optionId: "not-offered" },
      },
    });
    expect("code" in rejected && rejected.code).toBe("STALE_DECISION");
  });

  it("a stale-token finalization writes nothing", async () => {
    const { tripId } = await createHarnessTrip(pool);
    const claimA = await claimNextOrFail(pools);
    await expireLease(claimA.operationId);
    const claimB = await claimNextOrFail(pools);
    expect(claimB.fencingToken).not.toBe(claimA.fencingToken);

    const fingerprint = contentHash({ kind: "clarification" });
    const committed = await finalizeWaiting(
      pools.operations,
      { operationId: claimA.operationId, tripId, fencingToken: claimA.fencingToken },
      {
        kind: "clarification",
        fingerprint,
        allowedOptionIds: ["continue"],
        graphVersion: "harness-graph-v0",
        createdRevision: claimA.acceptedRevision,
      },
    );
    expect(committed).toBe(false);

    const decisions = await pools.operations.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.pending_decisions WHERE trip_id = $1`,
      [tripId],
    );
    expect(decisions.rows[0]?.count).toBe("0");
    const status = await pools.operations.query<{ status: string }>(
      `SELECT status FROM odft_app.workflow_operations WHERE id = $1`,
      [claimA.operationId],
    );
    expect(status.rows[0]?.status).toBe("running");
  });

  it("records node progress events while streaming", async () => {
    const { tripId } = await createHarnessTrip(pool);
    const driver = createHarnessDriver(pools);
    await driver.runOperation(await claimNextOrFail(pools));

    const events = await pools.operations.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.execution_events
        WHERE trip_id = $1 AND type = 'node.updated'`,
      [tripId],
    );
    expect(Number(events.rows[0]?.count)).toBeGreaterThan(0);
  });
});
