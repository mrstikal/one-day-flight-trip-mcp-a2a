import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  approvePendingItinerary,
  chooseOption,
  createGraphTestPool,
  createHarnessTrip,
  createWorkerPools,
  driveTripToReady,
  endWorkerPools,
  itineraryRows,
  optionPayload,
  pendingDecision,
  readTravelState,
  resetGraphDatabase,
  runCommand,
  submitProgram,
  type Harness,
  type WorkerPools,
} from "./_setup.js";

/**
 * Phase 10 bounded loop (T-IT-LIM-01, AC-10-3/AC-10-4): three total planning
 * attempts per user operation, no silent requirement reduction, and budget
 * conflicts that stop the loop immediately with a raise-budget clarification.
 */

describe("itinerary bounded loop (real PostgreSQL)", () => {
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

  it("stops at three attempts and clarifies without reducing the requirement", async () => {
    const harness: Harness = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, harness.tripId, harness.sessionId);
    const before = (await itineraryRows(pool, harness.tripId)).length;

    // The Rome inventory holds two museum-tagged activities; three are impossible.
    await runCommand(pool, pools, harness, {
      type: "set_activity_requirement",
      tag: "museum",
      minimumCount: 3,
    });
    // The requirement change refreshes the attractions and replans directly (the
    // applied program stays authoritative); the loop exhausts into the
    // clarification in this same run (2026-10-14).

    const rows = await itineraryRows(pool, harness.tripId);
    const drafts = rows.slice(before);
    expect(drafts).toHaveLength(3);
    for (const draft of drafts) {
      expect(draft.status).toBe("draft");
      expect(draft.validation.status).toBe("invalid");
      expect(draft.validation.errors.map((error) => error.code)).toContain(
        "unmet_minimum_activity_count",
      );
    }

    const state = await readTravelState(pools, harness.tripId);
    expect(state.values.planningAttempt).toBe(3);
    expect(state.values.itineraryValidationStatus).toBe("invalid");
    expect(state.values.itineraryBudgetConflict).toBe(false);

    const decision = await pendingDecision(pools, harness.tripId);
    expect(decision?.kind).toBe("clarification");
    const payload = await optionPayload(pool, decision?.id ?? "");
    expect(payload?.requestedCommands).toEqual([
      { type: "set_activity_requirement", tag: "museum", minimumCount: 3 },
    ]);
    expect(payload?.question).toContain("at least 3 were requested");
    expect(payload?.options?.map((option) => option.id)).toEqual(
      expect.arrayContaining(["reduce_museum", "denser_pace_intensive", "review_program"]),
    );
    // No silent reduction: the stored preference is still three museums.
    const prefs = await pool.query<{ preferences: { minimumActivityCounts: Record<string, number> } }>(
      `SELECT preferences FROM odft_app.trips WHERE id = $1`,
      [harness.tripId],
    );
    expect(prefs.rows[0]?.preferences.minimumActivityCounts.museum).toBe(3);

    // The user explicitly accepts the feasible reduction; a new operation gets a
    // fresh three-attempt budget and approves the repaired plan.
    expect(await chooseOption(pool, pools, harness, "reduce_museum")).toBe("itinerary_approval");
    await approvePendingItinerary(pool, pools, harness.tripId, harness.sessionId);
    const approvedRows = await itineraryRows(pool, harness.tripId);
    expect(approvedRows.at(-1)?.status).toBe("approved");
    expect(approvedRows.at(-1)?.validation.status).toBe("valid");
    const reduced = await pool.query<{ preferences: { minimumActivityCounts: Record<string, number> } }>(
      `SELECT preferences FROM odft_app.trips WHERE id = $1`,
      [harness.tripId],
    );
    expect(reduced.rows[0]?.preferences.minimumActivityCounts.museum).toBe(2);
  }, 180_000);

  it("stops the loop on the first budget conflict and never falsifies prices", async () => {
    const harness: Harness = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, harness.tripId, harness.sessionId);
    const approvedVersion = (await itineraryRows(pool, harness.tripId)).at(-1);
    expect(approvedVersion?.status).toBe("approved");
    const before = (await itineraryRows(pool, harness.tripId)).length;

    await runCommand(pool, pools, harness, { type: "set_budget", maxBudgetMinor: 100 });
    const kind = await submitProgram(pool, pools, harness);
    expect(kind).toBe("clarification");

    const drafts = (await itineraryRows(pool, harness.tripId)).slice(before);
    // The budget conflict stops the loop on the first attempt.
    expect(drafts).toHaveLength(1);
    const draft = drafts[0];
    expect(draft?.validation.status).toBe("invalid");
    expect(draft?.validation.errors.map((error) => error.code)).toEqual(["budget_exceeded"]);
    expect(draft?.costs.totalMinor).toBeGreaterThan(100);
    const state = await readTravelState(pools, harness.tripId);
    expect(state.values.planningAttempt).toBe(1);
    expect(state.values.itineraryBudgetConflict).toBe(true);

    const decision = await pendingDecision(pools, harness.tripId);
    expect(decision?.kind).toBe("clarification");
    const payload = await optionPayload(pool, decision?.id ?? "");
    expect(payload?.options?.map((option) => option.id)).toEqual(["raise_budget", "keep_budget"]);
    expect(payload?.question).toContain("No price was changed");

    // Raising the budget replans with the *same* deterministic prices.
    expect(await chooseOption(pool, pools, harness, "raise_budget")).toBe("itinerary_approval");
    await approvePendingItinerary(pool, pools, harness.tripId, harness.sessionId);
    const rebuilt = (await itineraryRows(pool, harness.tripId)).at(-1);
    expect(rebuilt?.status).toBe("approved");
    expect(rebuilt?.costs.items).toEqual(draft?.costs.items);
    const budget = await pool.query<{ preferences: { maxBudgetMinor: number } }>(
      `SELECT preferences FROM odft_app.trips WHERE id = $1`,
      [harness.tripId],
    );
    expect(budget.rows[0]?.preferences.maxBudgetMinor).toBe(draft?.costs.totalMinor);
  }, 180_000);
});