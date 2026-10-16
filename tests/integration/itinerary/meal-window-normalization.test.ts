import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { itineraryEventSchema } from "@odft/contracts";
import type { PlannerOutput } from "@odft/ai";
import { admitOperation, admitResume } from "@odft/persistence";
import {
  claimNextOrFail,
  createGraphTestPool,
  createHarnessTrip,
  createTestAiService,
  createTravelDriver,
  createWorkerPools,
  driveTripToReady,
  endWorkerPools,
  itineraryRows,
  pendingDecision,
  readTravelState,
  resetGraphDatabase,
  runCommand,
  tripRevision,
  type Harness,
  type WorkerPools,
} from "./_setup.js";

/**
 * The transfer-allowance normalization must use the SAME resolved geometry the
 * assembly places (a confirmed meal is locked to its offer's window start and
 * fixed duration). Before the fix the normalization used the planner's own
 * duration, so a plan whose confirmed breakfast runs longer than proposed kept a
 * too-tight pair after assembly and failed as `transfer_gap` on every attempt.
 */

describe("confirmed-meal window normalization (real PostgreSQL)", () => {
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

  it("widens a pair that is only tight once the confirmed meal duration applies", async () => {
    const harness: Harness = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, harness.tripId, harness.sessionId);

    // Confirm the breakfast the saved program already selected: the trail now
    // re-plans (fixture planner) into a fresh itinerary approval.
    const breakfast = await pool.query<{ offer_id: string }>(
      `SELECT offer_id FROM odft_app.trip_selections
        WHERE trip_id = $1 AND service_key = 'breakfast'`,
      [harness.tripId],
    );
    await runCommand(pool, pools, harness, {
      type: "propose_selection",
      service: "breakfast",
      offerId: breakfast.rows[0]?.offer_id ?? "",
    });
    const confirmation = await pendingDecision(pools, harness.tripId);
    expect(confirmation?.kind).toBe("booking_confirmation");
    const confirmed = await admitResume(pool, {
      tripId: harness.tripId,
      sessionId: harness.sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: await tripRevision(pool, harness.tripId),
        decisionId: confirmation?.id ?? "",
        response: {
          action: "confirm_booking",
          proposalId: confirmation?.proposalId,
          acceptedDemoDisclaimer: true,
        } as never,
      },
    });
    expect("operationId" in confirmed).toBe(true);
    await createTravelDriver(pools).runOperation(await claimNextOrFail(pools));
    expect((await pendingDecision(pools, harness.tripId))?.kind).toBe("itinerary_approval");

    // A pace change with an applied program replans directly. The crafted planner
    // proposes a short breakfast slot and the next activity one minute after it;
    // the confirmed reservation actually runs longer, so the first pair is only
    // tight once the locked geometry applies.
    const base = createTestAiService(pools);
    const crafted = {
      interpret: (input: Parameters<typeof base.interpret>[0]) => base.interpret(input),
      review: (input: Parameters<typeof base.review>[0]) => base.review(input),
      plan: async (input: Parameters<typeof base.plan>[0]) => {
        const result = await base.plan(input);
        if (result.kind !== "planned") {
          return result;
        }
        const stops = result.output.stops.map((stop) => ({ ...stop }));
        const first = stops.find((stop) => stop.kind === "meal");
        const activity = stops.find((stop) => stop.kind === "activity");
        if (first && activity) {
          first.durationMinutes = 30;
          activity.startMinute = first.startMinute + 31;
        }
        return { ...result, output: { ...result.output, stops } };
      },
    };
    const admitted = await admitOperation(pool, {
      tripId: harness.tripId,
      sessionId: harness.sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: await tripRevision(pool, harness.tripId),
        command: { type: "set_activity_pace", pace: "moderate" },
      },
    });
    expect("operationId" in admitted).toBe(true);
    await createTravelDriver(pools, crafted as never).runOperation(await claimNextOrFail(pools));

    const draft = (await itineraryRows(pool, harness.tripId)).at(-1);
    expect(draft?.validation.errors).toEqual([]);
    expect(draft?.validation.status).toBe("valid");
    const events = draft?.events as { kind: string; startLocal: string; endLocal: string }[];
    const mealEnd = events.find((event) => event.kind === "meal")?.endLocal;
    expect(mealEnd).toBeDefined();
    expect((await pendingDecision(pools, harness.tripId))?.kind).toBe("itinerary_approval");
    // The mutated pair no longer sits one minute apart: the normalization widened
    // it against the locked meal window before assembly.
    const activity = events.find((event) => event.kind === "activity");
    expect(activity?.startLocal).not.toBe(
      events.find((event) => event.kind === "meal")?.startLocal,
    );
    expect((await readTravelState(pools, harness.tripId)).values.planningAttempt).toBe(1);
  }, 240_000);

  it("uses optional free time for transfers and finishes replanning in one attempt", async () => {
    const harness = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, harness.tripId, harness.sessionId);
    const before = (await itineraryRows(pool, harness.tripId)).length;
    const base = createTestAiService(pools);
    let plannerCalls = 0;
    const crafted = {
      ...base,
      plan: async (input: Parameters<typeof base.plan>[0]) => {
        plannerCalls += 1;
        const result = await base.plan(input);
        if (result.kind !== "planned") {
          return result;
        }
        const stops: PlannerOutput["stops"] = [];
        let previousEnd: number | null = null;
        for (const stop of result.output.stops
          .filter((candidate) => candidate.kind !== "free_time")
          .sort((left, right) => left.startMinute - right.startMinute)) {
          if (
            previousEnd !== null &&
            (stop.kind === "meal" || stop.kind === "activity") &&
            stop.startMinute - previousEnd >= 5
          ) {
            const durationMinutes = Math.min(180, stop.startMinute - previousEnd);
            stops.push({
              kind: "free_time",
              startMinute: stop.startMinute - durationMinutes,
              durationMinutes,
            });
          }
          stops.push(stop);
          previousEnd = Math.max(previousEnd ?? 0, stop.startMinute + stop.durationMinutes);
        }
        return { ...result, output: { ...result.output, stops } };
      },
    };
    const admitted = await admitOperation(pool, {
      tripId: harness.tripId,
      sessionId: harness.sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: await tripRevision(pool, harness.tripId),
        command: { type: "set_activity_pace", pace: "intensive" },
      },
    });
    expect("operationId" in admitted).toBe(true);
    await createTravelDriver(pools, crafted).runOperation(await claimNextOrFail(pools));
    const drafts = (await itineraryRows(pool, harness.tripId)).slice(before);
    expect(plannerCalls).toBe(1);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.validation).toMatchObject({ status: "valid", errors: [] });
    const events = itineraryEventSchema.array().parse(drafts[0]?.events);
    expect(events.some((event) => event.kind === "transfer")).toBe(true);
    expect(events.some((event) => event.kind === "activity")).toBe(true);
    expect((await pendingDecision(pools, harness.tripId))?.kind).toBe("itinerary_approval");
    expect((await readTravelState(pools, harness.tripId)).values.planningAttempt).toBe(1);
  }, 180_000);
});
