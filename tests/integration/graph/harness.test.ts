import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { admitResume, admitOperation, getPendingDecisionForTrip } from "@odft/persistence";
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
 * Phase 05 durable harness validation: Send fan-out, single interrupt, resume,
 * reducer pruned scope, and zero-domain serial routing. All against a real
 * official `PostgresSaver` and the fenced saver.
 */

describe("durable harness graph", () => {
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

  it("runs creation, fans out over domains, and stops at the interrupt", async () => {
    const { tripId } = await createHarnessTrip(pool);
    const driver = createHarnessDriver(pools);
    const claim = await claimNextOrFail(pools);
    await driver.runOperation(claim);

    const operation = await pools.operations.query<{ status: string }>(
      `SELECT status FROM odft_app.workflow_operations WHERE id = $1`,
      [claim.operationId],
    );
    expect(operation.rows[0]?.status).toBe("waiting");

    const snapshot = await readHarnessState(pools, tripId);
    const research = (snapshot.values as Record<string, unknown>).researchResults as Record<
      string,
      unknown
    >;
    expect(Object.keys(research)).toHaveLength(3);

    const decision = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(decision).toBeDefined();
    expect(decision?.status).toBe("pending");

    const trip = await pools.operations.query<{ workflow_status: string }>(
      `SELECT workflow_status FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    expect(trip.rows[0]?.workflow_status).toBe("waiting_user");
  });

  it("resumes the interrupt with a trusted envelope and completes", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    const driver = createHarnessDriver(pools);
    await driver.runOperation(await claimNextOrFail(pools));

    const decision = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(decision).toBeDefined();

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
    expect("operationId" in admitted).toBe(true);

    await driver.runOperation(await claimNextOrFail(pools));

    const snapshot = await readHarnessState(pools, tripId);
    expect((snapshot.values as Record<string, unknown>).lastOutcome).toBe("success");
    const trip = await pools.operations.query<{ workflow_status: string }>(
      `SELECT workflow_status FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    expect(trip.rows[0]?.workflow_status).toBe("ready");
    const decisionAfter = await pools.operations.query<{ status: string }>(
      `SELECT status FROM odft_app.pending_decisions WHERE id = $1`,
      [decision?.id ?? ""],
    );
    expect(decisionAfter.rows[0]?.status).toBe("resolved");
  });

  it("routes zero domains directly to the interrupt without a dangling join", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    // A command with no required domains; the trip is created, then admitted.
    const driver = createHarnessDriver(pools);
    await driver.runOperation(await claimNextOrFail(pools));
    const decision = await getPendingDecisionForTrip(pools.operations, tripId);
    await admitResume(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: 1,
        decisionId: decision?.id ?? "",
        response: { action: "choose_option", optionId: "continue" },
      },
    });
    await driver.runOperation(await claimNextOrFail(pools));

    const admitted = await admitOperation(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: 1,
        command: { type: "retry_failed_domains" },
      },
    });
    if (!("operationId" in admitted)) {
      throw new Error(`admitOperation failed: ${admitted.code}`);
    }
    // Override the admitted operation payload to request zero domains.
    await pools.operations.query(
      `UPDATE odft_app.workflow_operations SET payload = $2::jsonb WHERE id = $1`,
      [admitted.operationId, JSON.stringify({ requiredDomains: [] })],
    );
    await driver.runOperation(await claimNextOrFail(pools));

    const snapshot = await readHarnessState(pools, tripId);
    const research = (snapshot.values as Record<string, unknown>).researchResults as Record<
      string,
      unknown
    >;
    // Overwrite reset cleared the previous run's results; zero domains ran the
    // serial path straight to the interrupt.
    expect(Object.keys(research)).toHaveLength(0);
    const status = await pools.operations.query<{ status: string }>(
      `SELECT status FROM odft_app.workflow_operations WHERE id = $1`,
      [admitted.operationId],
    );
    expect(status.rows[0]?.status).toBe("waiting");
  });
});
