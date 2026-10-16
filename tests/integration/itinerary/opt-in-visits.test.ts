import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { itineraryReviewSchema, snapshotContentSchema } from "@odft/contracts";
import { admitResume, getPendingDecisionForTrip } from "@odft/persistence";
import { buildTripProjection } from "../../../apps/web/src/lib/projection.js";
import { tripRevision } from "../ai/_setup.js";
import {
  claimNextOrFail,
  createGraphTestPool,
  createHarnessTrip,
  createTestAiService,
  createTravelDriver,
  createWorkerPools,
  endWorkerPools,
  itineraryRows,
  resetGraphDatabase,
  type WorkerPools,
} from "./_setup.js";

/**
 * Visits are OPT-IN (2026-10-14): a live planner that adds unrequested activity
 * stops (observed with planner-v2 on a trip with no pins and no requirements)
 * must not leak them into the persisted plan — the worker strips them
 * deterministically before normalization and assembly.
 */

describe("opt-in visits enforcement (real PostgreSQL)", () => {
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

  it("plans opt-in visits once, preserves advisory review findings, and exposes durable progress", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    const driver = createTravelDriver(pools);
    await driver.runOperation(await claimNextOrFail(pools));
    const flight = await getPendingDecisionForTrip(pools.operations, tripId);
    await resume(sessionId, tripId, flight?.id ?? "", {
      action: "choose_offer",
      offerId: flight?.allowedOfferIds[0],
    });
    await driver.runOperation(await claimNextOrFail(pools));
    const flightConfirmation = await getPendingDecisionForTrip(pools.operations, tripId);
    await resume(sessionId, tripId, flightConfirmation?.id ?? "", {
      action: "confirm_booking",
      proposalId: flightConfirmation?.proposalId,
      acceptedDemoDisclaimer: true,
    });
    await driver.runOperation(await claimNextOrFail(pools));
    const hotel = await getPendingDecisionForTrip(pools.operations, tripId);
    await resume(sessionId, tripId, hotel?.id ?? "", {
      action: "choose_offer",
      offerId: hotel?.allowedOfferIds[0],
    });
    await driver.runOperation(await claimNextOrFail(pools));
    const hotelConfirmation = await getPendingDecisionForTrip(pools.operations, tripId);
    await resume(sessionId, tripId, hotelConfirmation?.id ?? "", {
      action: "confirm_booking",
      proposalId: hotelConfirmation?.proposalId,
      acceptedDemoDisclaimer: true,
    });
    await driver.runOperation(await claimNextOrFail(pools));
    const program = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(program?.kind).toBe("program_choices");

    // A planner that behaves like the live model: the fixture day plus two
    // candidate visits nobody asked for.
    const base = createTestAiService(pools);
    const crafted = {
      interpret: (input: Parameters<typeof base.interpret>[0]) => base.interpret(input),
      review: async (input: Parameters<typeof base.review>[0]) => {
        expect(input.context.preferredActivityIds).toEqual([]);
        expect(input.context.requirements).toEqual([]);
        expect(input.context.activitiesSelfArranged).toBe(false);
        expect(input.context.events.every((event) => typeof event.locked === "boolean")).toBe(true);
        const projection = await buildTripProjection(pool, tripId, {
          aiMode: "fixture",
          demoControlsEnabled: false,
          mapTileUrl: null,
        });
        expect(
          projection?.operations.find((operation) => operation.operationId === input.operationId)
            ?.progress,
        ).toEqual({ stage: "reviewing_itinerary", programSaved: true });
        const reviewed = await base.review(input);
        return {
          ...reviewed,
          output: {
            verdict: "revise" as const,
            issues: [
              {
                code: "interest_mismatch" as const,
                eventIds: [],
                explanation: "Add culture despite no requested visits.",
              },
              {
                code: "insufficient_variety" as const,
                eventIds: [],
                explanation: "Fill the intentional free time.",
              },
            ],
            suggestedOrder: [],
            explanation: "Nonblocking stylistic advice, not a requirement conflict.",
          },
        };
      },
      plan: async (input: Parameters<typeof base.plan>[0]) => {
        const projection = await buildTripProjection(pool, tripId, {
          aiMode: "fixture",
          demoControlsEnabled: false,
          mapTileUrl: null,
        });
        expect(
          projection?.operations.find((operation) => operation.operationId === input.operationId)
            ?.progress,
        ).toEqual({ stage: "planning_itinerary", programSaved: true });
        const result = await base.plan(input);
        if (result.kind !== "planned") {
          return result;
        }
        const extras = input.context.candidates
          .filter((candidate) => candidate.kind === "activity")
          .slice(0, 2)
          .map((candidate, index) => ({
            kind: "activity" as const,
            refId: candidate.id,
            startMinute: 9 * 60 + index * 120,
            durationMinutes: Math.min(180, Math.max(5, candidate.durationMinutes)),
          }));
        return {
          ...result,
          output: { ...result.output, stops: [...result.output.stops, ...extras] },
        };
      },
    };
    const snapshot = await pool.query<{ inventory: unknown }>(
      `SELECT s.inventory FROM odft_app.scenario_snapshots s
         JOIN odft_app.trips t ON t.active_scenario_snapshot_id = s.id
        WHERE t.id = $1`,
      [tripId],
    );
    const content = snapshotContentSchema.parse(snapshot.rows[0]?.inventory);
    const offered = new Set(program?.allowedOfferIds ?? []);
    const offeredByMeal = (meal: string): string =>
      content.restaurants.find((offer) => offer.meal === meal && offered.has(offer.id))?.id ?? "";
    const operationId = await resume(sessionId, tripId, program?.id ?? "", {
      action: "submit_program",
      mealOfferIds: {
        breakfast: offeredByMeal("breakfast"),
        lunch: offeredByMeal("lunch"),
        dinner: offeredByMeal("dinner"),
      },
      preferredActivityIds: [],
    });
    expect(operationId).toBeTruthy();
    await createTravelDriver(pools, crafted).runOperation(await claimNextOrFail(pools));

    const next = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(next?.kind).toBe("itinerary_approval");
    const drafts = await itineraryRows(pool, tripId);
    expect(drafts).toHaveLength(1);
    const draft = drafts.at(-1);
    expect(draft?.validation.status).toBe("valid");
    expect(
      draft?.validation.warnings.filter((warning) => warning.code === "review_suggestion"),
    ).toHaveLength(2);
    expect(itineraryReviewSchema.parse(draft?.review)).toMatchObject({
      verdict: "revise",
      suggestionsAsWarnings: true,
    });
    const activityEvents = (draft?.events as { kind: string }[]).filter(
      (event) => event.kind === "activity",
    );
    expect(activityEvents).toEqual([]);
    const finalProjection = await buildTripProjection(pool, tripId, {
      aiMode: "fixture",
      demoControlsEnabled: false,
      mapTileUrl: null,
    });
    expect(
      finalProjection?.operations.find((operation) => operation.operationId === operationId)
        ?.progress,
    ).toBeUndefined();
  }, 240_000);
});