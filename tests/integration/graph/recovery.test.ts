import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  admitResume,
  CHECKPOINT_SCHEMA,
  claimNextOperation,
  getPendingDecisionForTrip,
} from "@odft/persistence";
import { buildHarnessGraph, type HarnessDomainResult } from "@odft/workflow";
import { createOperationDriver } from "../../../apps/worker/src/driver.js";
import { FailOnceSaver } from "./_faults.js";
import {
  claimNextOrFail,
  createGraphTestPool,
  createHarnessDriver,
  createHarnessTrip,
  createWorkerPools,
  endWorkerPools,
  readHarnessState,
  resetGraphDatabase,
  type WorkerPools,
} from "./_setup.js";

/**
 * T-IT-FLT-01/02/04 and T-IT-INV-08: commit-before-checkpoint, completion-event
 * repair, unanswered-interrupt recovery, and accepted-resume replay.
 */

describe("graph recovery", () => {
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

  function driverThatFailsFirstCheckpoint(skip = 0) {
    return createOperationDriver({
      operationsPool: pools.operations,
      guardPool: pools.guard,
      saverPool: pools.saver,
      lockPool: pools.lock,
      workerId: "test-worker",
      leaseMs: 30_000,
      graphVersion: "harness-graph-v0",
      buildGraph: (checkpointer) =>
        buildHarnessGraph({ checkpointer: new FailOnceSaver(checkpointer, 1, skip) }),
      buildSaver: () => new PostgresSaver(pools.saver, undefined, { schema: CHECKPOINT_SCHEMA }),
    });
  }

  async function countEffects(operationId: string): Promise<number> {
    const result = await pools.operations.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.workflow_effects WHERE operation_id = $1`,
      [operationId],
    );
    return Number(result.rows[0]?.count ?? "0");
  }

  it("FLT-01: commit-before-checkpoint replays effects from the ledger, not as fabricated success", async () => {
    const { tripId } = await createHarnessTrip(pool);
    const claim = await claimNextOrFail(pools);

    // The prior crashed attempt already committed three domain effects; the
    // checkpoint recording them is missing.
    for (const domain of ["hotel", "dinner", "attractions"]) {
      const key = `${claim.operationId}:${domain}`;
      const value: HarnessDomainResult = {
        domain: domain as HarnessDomainResult["domain"],
        status: "ok",
        fingerprint: `${claim.operationId}:${key}`,
        attempts: 1,
      };
      await pools.operations.query(
        `INSERT INTO odft_app.workflow_effects (operation_id, node_name, effect_scope, result)
         VALUES ($1, 'research_domain', $2, $3::jsonb)`,
        [claim.operationId, key, JSON.stringify(value)],
      );
    }

    const failing = driverThatFailsFirstCheckpoint(0);
    await failing.runOperation(claim);

    // Effects survive the failed checkpoint; the operation was not succeeded.
    expect(await countEffects(claim.operationId)).toBe(3);
    const afterFail = await pools.operations.query<{ status: string }>(
      `SELECT status FROM odft_app.workflow_operations WHERE id = $1`,
      [claim.operationId],
    );
    expect(afterFail.rows[0]?.status).toBe("queued");

    // Recovery re-runs the node and reads the stored ledger result.
    const healthy = createHarnessDriver(pools);
    await healthy.runOperation(await claimNextOrFail(pools));

    expect(await countEffects(claim.operationId)).toBe(3);
    const snapshot = await readHarnessState(pools, tripId);
    const research = (snapshot.values as Record<string, unknown>).researchResults as Record<
      string,
      unknown
    >;
    expect(Object.keys(research)).toHaveLength(3);
  });

  it("FLT-02: checkpoint written but completion event missing is repaired without re-booking", async () => {
    const { tripId } = await createHarnessTrip(pool);
    const driver = createHarnessDriver(pools);
    const claim = await claimNextOrFail(pools);
    await driver.runOperation(claim);

    const effectsBefore = await countEffects(claim.operationId);

    // Simulate: completion event + decision row lost, operation row not updated.
    await pools.operations.query(`DELETE FROM odft_app.execution_events WHERE trip_id = $1`, [tripId]);
    await pools.operations.query(`DELETE FROM odft_app.pending_decisions WHERE trip_id = $1`, [tripId]);
    await pools.operations.query(
      `UPDATE odft_app.workflow_operations
          SET status = 'running', lease_expires_at = now() - interval '5 seconds'
        WHERE id = $1`,
      [claim.operationId],
    );

    await driver.runOperation(await claimNextOrFail(pools));

    const decisions = await pools.operations.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.pending_decisions WHERE trip_id = $1`,
      [tripId],
    );
    expect(decisions.rows[0]?.count).toBe("1");
    expect(await countEffects(claim.operationId)).toBe(effectsBefore);
  });

  it("FLT-04: recovery restores the waiting projection without inventing a resume answer", async () => {
    const { tripId } = await createHarnessTrip(pool);
    const driver = createHarnessDriver(pools);
    await driver.runOperation(await claimNextOrFail(pools));

    // No unfinished work is claimable; the interrupt stays pending.
    const claim = await claimNextOperation(pools.operations, { workerId: "test-worker" });
    expect(claim).toBeNull();
    const decision = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(decision?.status).toBe("pending");
  });

  it("INV-08: an accepted resume replays the stored envelope and stays idempotent", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    const healthy = createHarnessDriver(pools);
    await healthy.runOperation(await claimNextOrFail(pools));

    const decision = await getPendingDecisionForTrip(pools.operations, tripId);
    const admitted = await admitResume(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: 1,
        decisionId: decision?.id ?? "",
        response: { action: "choose_option", optionId: "continue" },
      },
    });
    if (!("operationId" in admitted)) {
      throw new Error(`admitResume failed: ${admitted.code}`);
    }

    // Crash before the answer is checkpointed.
    const failing = driverThatFailsFirstCheckpoint(0);
    await failing.runOperation(await claimNextOrFail(pools));
    const midStatus = await pools.operations.query<{ status: string }>(
      `SELECT status FROM odft_app.workflow_operations WHERE id = $1`,
      [admitted.operationId],
    );
    expect(midStatus.rows[0]?.status).toBe("queued");

    // Replay the same stored envelope to completion.
    await healthy.runOperation(await claimNextOrFail(pools));

    const snapshot = await readHarnessState(pools, tripId);
    expect((snapshot.values as Record<string, unknown>).lastOutcome).toBe("success");

    // A new request to the resolved decision is rejected, not accepted.
    const replay = await admitResume(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: 1,
        decisionId: decision?.id ?? "",
        response: { action: "choose_option", optionId: "continue" },
      },
    });
    expect("code" in replay && replay.code).toBe("STALE_DECISION");
  });
});
