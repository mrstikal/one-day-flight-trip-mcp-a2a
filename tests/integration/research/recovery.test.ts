import type { Pool } from "pg";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RESEARCH_DOMAINS } from "@odft/contracts";
import { CHECKPOINT_SCHEMA, getPendingDecisionForTrip } from "@odft/persistence";
import {
  buildTravelGraph,
  buildTravelStartInput,
  chooseInvocation,
  TRAVEL_GRAPH_VERSION,
} from "@odft/workflow";
import { createOperationDriver } from "../../../apps/worker/src/driver.js";
import { createAiService } from "../../../apps/worker/src/ai/service.js";
import { createTravelPortsFactory } from "../../../apps/worker/src/travel/ports.js";
import {
  claimNextOrFail,
  createGraphTestPool,
  createHarnessTrip,
  createWorkerPools,
  endWorkerPools,
  readTravelState,
  researchEvents,
  resetGraphDatabase,
  resolveDecision,
  testServerConfig,
  type WorkerPools,
} from "./_setup.js";

/**
 * T-IT-RET-02 (Phase 09): an unexpected exception in one parallel research
 * branch aborts the superstep; completed siblings keep their pending writes and
 * artifacts, and a `null` recovery (invoke(null)) reruns only the unfinished
 * tasks — the finished sibling tasks are not re-executed.
 */

describe("aborted superstep recovery (real PostgreSQL)", () => {
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

  it("reruns only unfinished tasks and keeps completed sibling writes", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    const ai = createAiService({ pool: pools.operations, config: testServerConfig() });
    const baseFactory = createTravelPortsFactory(pools.operations, ai);
    let aborted = false;
    const driver = createOperationDriver({
      operationsPool: pools.operations,
      guardPool: pools.guard,
      saverPool: pools.saver,
      lockPool: pools.lock,
      workerId: "test-worker",
      leaseMs: 30_000,
      graphVersion: TRAVEL_GRAPH_VERSION,
      buildGraph: (checkpointer) => buildTravelGraph({ checkpointer }) as never,
      portsFactory: (ctx) => {
        const ports = baseFactory(ctx);
        return {
          ...ports,
          async researchDomain(input: Parameters<typeof ports.researchDomain>[0]) {
            if (!aborted && input.domain === "dinner") {
              // Deterministic abort point: wait until an earlier-started sibling
              // domain has finished AND LangGraph had time to record its pending
              // write, then fail this branch unexpectedly.
              const deadline = Date.now() + 15_000;
              while (Date.now() < deadline) {
                const done = await pools.operations.query(
                  `SELECT 1 FROM odft_app.execution_events
                    WHERE trip_id = $1 AND type = 'research.domain_finished'
                      AND payload->>'domain' <> 'dinner' LIMIT 1`,
                  [tripId],
                );
                if ((done.rowCount ?? 0) > 0) {
                  break;
                }
                await new Promise((resolve) => setTimeout(resolve, 25));
              }
              await new Promise((resolve) => setTimeout(resolve, 200));
              aborted = true;
              throw new Error("simulated unexpected research branch failure");
            }
            return ports.researchDomain(input);
          },
        };
      },
      chooseInvocation: (state, operation, options) =>
        chooseInvocation(state, operation, { ...options, buildStartInput: buildTravelStartInput }),
      buildSaver: () => new PostgresSaver(pools.saver, undefined, { schema: CHECKPOINT_SCHEMA }),
      logger: () => {},
    });

    // Flights: creation -> flight choice -> confirm -> the research operation
    // aborts on the first attempt.
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

    // The aborted run left the operation queued and at least one sibling
    // artifact behind (its write happened before the abort).
    const abortedEvents = await researchEvents(pool, tripId);
    const finishedBeforeAbort = abortedEvents.filter((event) => event.phase === "finished");
    expect(finishedBeforeAbort.length).toBeGreaterThanOrEqual(1);
    expect(finishedBeforeAbort.some((event) => event.domain === "breakfast")).toBe(true);
    const artifactsAfterAbort = await pool.query<{ service_key: string }>(
      `SELECT service_key FROM odft_app.recommendation_artifacts WHERE trip_id = $1`,
      [tripId],
    );
    expect(artifactsAfterAbort.rows.map((row) => row.service_key)).toContain("breakfast");
    const queued = await pools.operations.query<{ status: string }>(
      `SELECT status FROM odft_app.workflow_operations WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    );
    expect(queued.rows[0]?.status).toBe("queued");

    // Recovery: the same operation is claimed again and recovered via invoke(null).
    await driver.runOperation(await claimNextOrFail(pools));

    const events = await researchEvents(pool, tripId);
    // Breakfast finished before the abort and its pending write was retained:
    // the recovery must NOT re-execute it.
    const breakfastEvents = events.filter((event) => event.domain === "breakfast");
    expect(breakfastEvents.filter((event) => event.phase === "started")).toHaveLength(1);
    expect(breakfastEvents.filter((event) => event.phase === "finished")).toHaveLength(1);
    // The aborted branch (dinner) reran exactly once.
    const dinnerEvents = events.filter((event) => event.domain === "dinner");
    expect(dinnerEvents.filter((event) => event.phase === "started")).toHaveLength(2);
    expect(dinnerEvents.filter((event) => event.phase === "finished")).toHaveLength(1);
    // Every domain finishes exactly once overall; a branch that was still
    // running at the abort reruns at most once (started <= 2), while completed
    // tasks (breakfast) are not re-executed at all.
    for (const domain of RESEARCH_DOMAINS) {
      const started = events.filter(
        (event) => event.domain === domain && event.phase === "started",
      );
      const finished = events.filter(
        (event) => event.domain === domain && event.phase === "finished",
      );
      expect(finished.length).toBeGreaterThanOrEqual(1);
      expect(started.length).toBeLessThanOrEqual(2);
    }

    const state = await readTravelState(pools, tripId);
    expect(state.values.researchStatus).toBe("ok");
    const results = state.values.researchResults as Record<string, { status: string }>;
    expect(Object.keys(results)).toHaveLength(6);
    expect(Object.values(results).every((result) => result.status === "ok")).toBe(true);
    const artifacts = await pool.query<{ service_key: string; count: string }>(
      `SELECT service_key, count(*)::text AS count FROM odft_app.recommendation_artifacts
        WHERE trip_id = $1 GROUP BY service_key ORDER BY service_key`,
      [tripId],
    );
    expect(artifacts.rows.every((row) => row.count === "1")).toBe(true);
    expect(artifacts.rows.map((row) => row.service_key)).toEqual([
      "activities",
      "breakfast",
      "dinner",
      "events",
      "hotel",
      "lunch",
    ]);

    const decision = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(decision?.kind).toBe("hotel_choice");
    expect((decision?.allowedOfferIds ?? []).length).toBeGreaterThanOrEqual(1);
    const operation = await pools.operations.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM odft_app.workflow_operations WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    );
    expect(operation.rows[0]?.status).toBe("waiting");
    expect(operation.rows[0]?.attempts).toBe(2);
  }, 180_000);
});