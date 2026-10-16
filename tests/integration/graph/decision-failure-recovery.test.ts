import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AdapterError } from "@odft/ai";
import { snapshotContentSchema } from "@odft/contracts";
import { admitOperation, admitResume, getPendingDecisionForTrip } from "@odft/persistence";
import type { AiService } from "../../../apps/worker/src/ai/service.js";
import { tripRevision } from "../ai/_setup.js";
import {
  claimNextOrFail,
  createGraphTestPool,
  createHarnessTrip,
  createTestAiService,
  createTravelDriver,
  createWorkerPools,
  endWorkerPools,
  readTravelState,
  resetGraphDatabase,
  retryFailedOperation,
  type WorkerPools,
} from "./_setup.js";

/**
 * A terminal planner failure during a decision resume must not strand the trip:
 * the resume consumed its interrupt, so the pending decision can never be
 * answered again. The trip exposes owner recovery for the operation that owns
 * the unfinished checkpoint instead, and retrying that operation re-runs only
 * the unfinished work (03-langgraph-design.md section 8).
 */

describe("decision resume failure recovery (real PostgreSQL)", () => {
  let pool: Pool;
  let pools: WorkerPools;
  let planCalls = 0;

  beforeAll(async () => {
    pool = createGraphTestPool();
    pools = createWorkerPools();
  });

  beforeEach(async () => {
    await resetGraphDatabase(pool);
    planCalls = 0;
  });

  afterAll(async () => {
    await endWorkerPools(pools);
    await pool.end();
  });

  /** Failure-injecting planner: the first plan call fails terminally, and every
   * later call is counted, so the tests can prove the recovery re-plans exactly
   * once (new billable call) instead of replaying anything silently. */
  function failingPlannerOnce(): AiService {
    const base = createTestAiService(pools);
    const failing = {
      interpret: (input: Parameters<AiService["interpret"]>[0]) => base.interpret(input),
      plan: (input: Parameters<AiService["plan"]>[0]) => {
        planCalls += 1;
        if (planCalls === 1) {
          return Promise.reject(
            new AdapterError("AI_SCHEMA_INVALID", "model output failed validation", false),
          );
        }
        return base.plan(input);
      },
      review: (input: Parameters<AiService["review"]>[0]) => base.review(input),
    };
    return failing as AiService;
  }

  /** Drive the trip to the `program_choices` decision (flight + hotel booked). */
  async function driveToProgramChoices(tripId: string, sessionId: string): Promise<string> {
    const driver = createTravelDriver(pools);
    await driver.runOperation(await claimNextOrFail(pools));
    const flightDecision = await getPendingDecisionForTrip(pools.operations, tripId);
    await resume(sessionId, tripId, flightDecision?.id ?? "", {
      action: "choose_offer",
      offerId: flightDecision?.allowedOfferIds[0] as string,
    });
    await driver.runOperation(await claimNextOrFail(pools));
    const flightConfirmation = await getPendingDecisionForTrip(pools.operations, tripId);
    await resume(sessionId, tripId, flightConfirmation?.id ?? "", {
      action: "confirm_booking",
      proposalId: flightConfirmation?.proposalId as string,
      acceptedDemoDisclaimer: true,
    });
    await driver.runOperation(await claimNextOrFail(pools));
    const hotelDecision = await getPendingDecisionForTrip(pools.operations, tripId);
    await resume(sessionId, tripId, hotelDecision?.id ?? "", {
      action: "choose_offer",
      offerId: hotelDecision?.allowedOfferIds[0] as string,
    });
    await driver.runOperation(await claimNextOrFail(pools));
    const hotelConfirmation = await getPendingDecisionForTrip(pools.operations, tripId);
    await resume(sessionId, tripId, hotelConfirmation?.id ?? "", {
      action: "confirm_booking",
      proposalId: hotelConfirmation?.proposalId as string,
      acceptedDemoDisclaimer: true,
    });
    await driver.runOperation(await claimNextOrFail(pools));
    const program = await getPendingDecisionForTrip(pools.operations, tripId);
    if (program?.kind !== "program_choices") {
      throw new Error(`expected program_choices, got ${String(program?.kind)}`);
    }
    return program.id;
  }

  /** Admit a resume and return its operation id (asserting it was accepted). */
  async function resume(
    sessionId: string,
    tripId: string,
    decisionId: string,
    response: unknown,
  ): Promise<string> {
    const admitted = await admitResume(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: await tripRevision(pool, tripId),
        decisionId,
        response: response as never,
      },
    });
    if (!("operationId" in admitted) || !admitted.operationId) {
      throw new Error(`resume was refused: ${JSON.stringify(admitted)}`);
    }
    return admitted.operationId;
  }

  /** A complete submit_program response for the pending decision. */
  async function programResponse(tripId: string): Promise<Record<string, unknown>> {
    const snapshot = await pool.query<{ inventory: unknown }>(
      `SELECT s.inventory FROM odft_app.scenario_snapshots s
         JOIN odft_app.trips t ON t.active_scenario_snapshot_id = s.id
        WHERE t.id = $1`,
      [tripId],
    );
    const content = snapshotContentSchema.parse(snapshot.rows[0]?.inventory);
    const decision = await getPendingDecisionForTrip(pools.operations, tripId);
    const offered = new Set(decision?.allowedOfferIds ?? []);
    const offeredByMeal = (meal: string): string =>
      content.restaurants.find((offer) => offer.meal === meal && offered.has(offer.id))?.id ?? "";
    return {
      action: "submit_program",
      mealOfferIds: {
        breakfast: offeredByMeal("breakfast"),
        lunch: offeredByMeal("lunch"),
        dinner: offeredByMeal("dinner"),
      },
      preferredActivityIds: (decision?.allowedOptionIds ?? []).slice(0, 2),
    };
  }

  /** Admit the pending program submission and run it with the flaky planner. */
  async function submitProgramWithFlakyPlanner(
    sessionId: string,
    tripId: string,
    decisionId: string,
    ai: AiService,
  ): Promise<string> {
    const operationId = await resume(sessionId, tripId, decisionId, await programResponse(tripId));
    await createTravelDriver(pools, ai).runOperation(await claimNextOrFail(pools));
    return operationId;
  }

  async function tripState(tripId: string): Promise<{
    workflow_status: string;
    recovery_required: boolean;
    last_unfinished_operation_id: string | null;
  }> {
    const result = await pool.query(
      `SELECT workflow_status, recovery_required, last_unfinished_operation_id
         FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    return result.rows[0] as never;
  }

  async function operationRow(operationId: string): Promise<{ status: string; result: unknown }> {
    const result = await pool.query<{ status: string; result: unknown }>(
      `SELECT status, result FROM odft_app.workflow_operations WHERE id = $1`,
      [operationId],
    );
    return result.rows[0] as never;
  }

  it("a terminal planner failure exposes owner recovery instead of a dead decision", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    const program = await driveToProgramChoices(tripId, sessionId);
    const ai = failingPlannerOnce();
    const operationId = await submitProgramWithFlakyPlanner(sessionId, tripId, program, ai);

    // The failed planning attempt is terminal and visible on the trip.
    const failed = await operationRow(operationId);
    expect(failed.status).toBe("failed");
    expect((failed.result as { code: string }).code).toBe("AI_SCHEMA_INVALID");
    expect(planCalls).toBe(1);
    const afterFailure = await tripState(tripId);
    expect(afterFailure.workflow_status).toBe("failed");
    expect(afterFailure.recovery_required).toBe(true);
    expect(afterFailure.last_unfinished_operation_id).toBe(operationId);

    // Ordinary work is refused until the owner recovers: both a new resume of
    // the dead decision and a new chat command.
    const refusedResume = await admitResume(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: await tripRevision(pool, tripId),
        decisionId: program,
        response: (await programResponse(tripId)) as never,
      },
    });
    expect("code" in refusedResume && refusedResume.code).toBe("RECOVERY_REQUIRED");
    const refusedChat = await admitOperation(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: await tripRevision(pool, tripId),
        chat: "continue",
      },
      userMessage: "continue",
    });
    expect("code" in refusedChat && refusedChat.code).toBe("RECOVERY_REQUIRED");

    // The owner retries the exact failed operation; only the unfinished work reruns.
    const retry = await retryFailedOperation(pool, {
      tripId,
      sessionId,
      operationId,
      expectedRevision: await tripRevision(pool, tripId),
    });
    expect("status" in retry && retry.status).toBe("accepted");
    await createTravelDriver(pools, ai).runOperation(await claimNextOrFail(pools));

    const state = await readTravelState(pools, tripId);
    expect(state.values.planningAttempt).toBe(1);
    const next = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(next?.kind).toBe("itinerary_approval");
    const afterRecovery = await tripState(tripId);
    expect(afterRecovery.recovery_required).toBe(false);
    expect(afterRecovery.workflow_status).toBe("waiting_user");
    // The superseded decision is retired (the new wait replaces it), never left
    // pending as a dead decision the UI would keep presenting.
    const retired = await pool.query<{ status: string }>(
      `SELECT status FROM odft_app.pending_decisions WHERE id = $1`,
      [program],
    );
    expect(retired.rows[0]?.status).toBe("cancelled");
    // Exactly one explicit recovery call on top of the failed attempt.
    expect(planCalls).toBe(2);
  }, 240_000);

  it("a wedged unfinished checkpoint from before the fix self-heals into owner recovery", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    const program = await driveToProgramChoices(tripId, sessionId);
    const ai = failingPlannerOnce();
    const operationId = await submitProgramWithFlakyPlanner(sessionId, tripId, program, ai);

    // Reproduce the pre-fix projection: the flag was never set, so the UI kept
    // showing the dead decision and every new attempt silently conflicted.
    await pool.query(
      `UPDATE odft_app.trips
          SET recovery_required = false, workflow_status = 'waiting_user',
              last_unfinished_operation_id = NULL
        WHERE id = $1`,
      [tripId],
    );

    const conflicting = await resume(sessionId, tripId, program, await programResponse(tripId));
    await createTravelDriver(pools, ai).runOperation(await claimNextOrFail(pools));

    // The rejected resume did not touch the graph; it recorded owner recovery for
    // the checkpoint owner and never became the recovery target itself.
    const conflictRow = await operationRow(conflicting);
    expect(conflictRow.status).toBe("failed");
    expect((conflictRow.result as { code: string }).code).toBe("STALE_DECISION");
    const wedged = await tripState(tripId);
    expect(wedged.recovery_required).toBe(true);
    expect(wedged.workflow_status).toBe("failed");
    expect(wedged.last_unfinished_operation_id).toBe(operationId);

    // The recorded unfinished operation is retryable even though the newer
    // rejected conflict row exists.
    const retry = await retryFailedOperation(pool, {
      tripId,
      sessionId,
      operationId,
      expectedRevision: await tripRevision(pool, tripId),
    });
    expect("status" in retry && retry.status).toBe("accepted");
    await createTravelDriver(pools, ai).runOperation(await claimNextOrFail(pools));

    const next = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(next?.kind).toBe("itinerary_approval");
    const healed = await tripState(tripId);
    expect(healed.recovery_required).toBe(false);
    expect(healed.last_unfinished_operation_id).toBeNull();
    expect(planCalls).toBe(2);
  }, 240_000);
});
