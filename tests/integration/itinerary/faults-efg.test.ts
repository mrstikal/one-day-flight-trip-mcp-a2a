import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { snapshotContentSchema } from "@odft/contracts";
import {
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
 * Phase 10 scenario controls E, F, G (05 section 12): the persisted overlays are
 * armed through the protected `set_simulation` command and never fake prices.
 */

describe("itinerary scenario controls E/F/G (real PostgreSQL)", () => {
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

  it("E: the persisted first-attempt overlay injects one labeled overlap that replanning repairs", async () => {
    const harness: Harness = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, harness.tripId, harness.sessionId);
    const before = (await itineraryRows(pool, harness.tripId)).length;

    await runCommand(pool, pools, harness, { type: "set_simulation", mode: "invalid_itinerary" });
    expect(await submitProgram(pool, pools, harness)).toBe("itinerary_approval");

    const drafts = (await itineraryRows(pool, harness.tripId)).slice(before);
    expect(drafts.length).toBeGreaterThanOrEqual(2);
    const corrupted = drafts.filter((draft) =>
      draft.validation.errors.some((error) => error.code === "overlap"),
    );
    expect(corrupted).toHaveLength(1);
    expect(corrupted[0]?.version).toBe(drafts[0]?.version);
    expect(corrupted[0]?.simulated_failure).toBe(true);
    expect(corrupted[0]?.simulated_failure_note).toContain("Simulated failure");
    const repaired = drafts.at(-1);
    expect(repaired?.validation.status).toBe("valid");
    expect(repaired?.simulated_failure).toBe(true);
    expect(repaired?.simulated_failure_note).toContain("repaired within the bounded loop");
    const state = await readTravelState(pools, harness.tripId);
    // The overlap was repaired within the bounded loop (an additional revise
    // round may consume the third attempt).
    expect(state.values.planningAttempt).toBeGreaterThanOrEqual(2);
    expect(state.values.planningAttempt).toBeLessThanOrEqual(3);

    // The fault counter records exactly one injection for the operation.
    const fault = await pool.query<{ counters: { attempts?: number } }>(
      `SELECT counters FROM odft_app.simulation_faults
        WHERE trip_id = $1 AND domain = 'itinerary' AND fault = 'invalid_itinerary'`,
      [harness.tripId],
    );
    expect(fault.rows.some((row) => (row.counters.attempts ?? 0) >= 1)).toBe(true);
  }, 180_000);

  it("F: the budget overlay below the feasible cost stops the loop without falsified prices", async () => {
    const harness: Harness = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, harness.tripId, harness.sessionId);
    const before = (await itineraryRows(pool, harness.tripId)).length;

    await runCommand(pool, pools, harness, { type: "set_simulation", mode: "budget_conflict" });
    const budget = await pool.query<{ preferences: { maxBudgetMinor: number } }>(
      `SELECT preferences FROM odft_app.trips WHERE id = $1`,
      [harness.tripId],
    );
    expect(budget.rows[0]?.preferences.maxBudgetMinor).toBe(100);

    expect(await submitProgram(pool, pools, harness)).toBe("clarification");
    const drafts = (await itineraryRows(pool, harness.tripId)).slice(before);
    expect(drafts).toHaveLength(1);
    const draft = drafts[0];
    expect(draft?.validation.errors.map((error) => error.code)).toEqual(["budget_exceeded"]);
    expect(draft?.costs.totalMinor).toBeGreaterThan(100);

    // Prices come from the persisted snapshot, never from the overlay.
    const snapshot = await pool.query<{ inventory: unknown }>(
      `SELECT s.inventory FROM odft_app.scenario_snapshots s
         JOIN odft_app.trips t ON t.active_scenario_snapshot_id = s.id
        WHERE t.id = $1`,
      [harness.tripId],
    );
    const content = snapshotContentSchema.parse(snapshot.rows[0]?.inventory);
    const flightItem = draft?.costs.items.find((item) => item.key.startsWith("flight:"));
    const flightOfferId = flightItem?.key.replace("flight:", "");
    const flight = content.flights.find((offer) => offer.id === flightOfferId);
    expect(flightItem?.amountMinor).toBe(flight?.partyTotalMinor);

    const decision = await pendingDecision(pools, harness.tripId);
    const payload = await optionPayload(pool, decision?.id ?? "");
    const raise = payload?.options?.find((option) => option.id === "raise_budget");
    expect(raise?.label).toContain(((draft?.costs.totalMinor ?? 0) / 100).toFixed(2));
    expect(await chooseOption(pool, pools, harness, "keep_budget")).toBe("program_choices");
    // "Keep the budget" reopens the program instead of downgrading anything.
    const afterKeep = (await itineraryRows(pool, harness.tripId)).slice(before);
    expect(afterKeep).toHaveLength(1);
  }, 180_000);

  it("G: the relaxed six-museums request clarifies and preserves the numeric requirement", async () => {
    const harness: Harness = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, harness.tripId, harness.sessionId);
    const before = (await itineraryRows(pool, harness.tripId)).length;

    await runCommand(pool, pools, harness, { type: "set_simulation", mode: "preference_conflict" });
    const prefs = await pool.query<{ preferences: { activityPace: string; minimumActivityCounts: Record<string, number> } }>(
      `SELECT preferences FROM odft_app.trips WHERE id = $1`,
      [harness.tripId],
    );
    expect(prefs.rows[0]?.preferences.activityPace).toBe("relaxed");
    expect(prefs.rows[0]?.preferences.minimumActivityCounts.museum).toBe(6);

    expect(await submitProgram(pool, pools, harness)).toBe("clarification");
    const decision = await pendingDecision(pools, harness.tripId);
    const payload = await optionPayload(pool, decision?.id ?? "");
    expect(payload?.requestedCommands).toEqual([
      { type: "set_activity_requirement", tag: "museum", minimumCount: 6 },
    ]);
    expect(payload?.question).toContain("at least 6 were requested");
    // Six long museum visits cannot fit even the intensive cap, so only the
    // feasible reduction and the explicit "keep my request" option are offered.
    expect(payload?.options?.map((option) => option.id)).toEqual([
      "reduce_museum",
      "review_program",
    ]);

    // The requirement is never silently reduced: stored preference and every
    // draft keep the request, and the drafts carry the blocking conflict.
    const drafts = (await itineraryRows(pool, harness.tripId)).slice(before);
    expect(drafts.length).toBe(3);
    for (const draft of drafts) {
      expect(draft.validation.errors.map((error) => error.code)).toContain(
        "unmet_minimum_activity_count",
      );
      expect(draft.validation.errors.find((error) => error.code === "unmet_minimum_activity_count")?.message).toContain(
        "at least 6 were requested",
      );
    }
    const stored = await pool.query<{ preferences: { minimumActivityCounts: Record<string, number> } }>(
      `SELECT preferences FROM odft_app.trips WHERE id = $1`,
      [harness.tripId],
    );
    expect(stored.rows[0]?.preferences.minimumActivityCounts.museum).toBe(6);
  }, 180_000);
});