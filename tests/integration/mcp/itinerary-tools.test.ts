import type { ChildProcess } from "node:child_process";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpClient } from "@odft/protocols";
import { tripPreferencesSchema } from "@odft/contracts";
import { endWorkerPools, type WorkerPools } from "../graph/_setup.js";
import {
  createMcpTestPool,
  createMcpTestWorkerPools,
  delegationOf,
  mcpConfigFor,
  resetMcpDatabase,
  seedDelegatedSnapshot,
  setupReadOnlyRole,
  startMcpHost,
  stopMcpHost,
  waitForHostReady,
  type SeededSnapshot,
} from "./_setup.js";

/**
 * Phase 04 itinerary tools: deterministic routing, assembly/validation and cost
 * over the frozen snapshot, with candidate-membership enforcement and no writes.
 */

let pool: Pool;
let pools: WorkerPools;
let host: ChildProcess;
let seeded: SeededSnapshot;
let delegationId: string;
interface MealSelections {
  readonly breakfast: string | null;
  readonly lunch: string | null;
  readonly dinner: string | null;
}
let context: Record<string, unknown> & { mealSelections: MealSelections };
let dinnerId: string;

beforeAll(async () => {
  pool = createMcpTestPool();
  pools = createMcpTestWorkerPools();
  await resetMcpDatabase(pool);
  setupReadOnlyRole();
  seeded = await seedDelegatedSnapshot(pool, pools);
  host = startMcpHost();
  await waitForHostReady(host);

  delegationId = await delegationOf(pool, {
    tripId: seeded.tripId,
    agentIdentity: "city-guide-agent",
  });

  const trip = await pool.query<{ preferences: unknown; adults: number; sightseeing_date: string; travel_variant: string }>(
    `SELECT preferences, adults, sightseeing_date::text AS sightseeing_date, travel_variant
       FROM odft_app.trips WHERE id = $1`,
    [seeded.tripId],
  );
  const row = trip.rows[0];
  if (!row) {
    throw new Error("seeded trip missing");
  }
  const snapshot = await pool.query<{ inventory: { hotels: { id: string }[]; flights: { id: string }[]; restaurants: { id: string; meal: string }[] } }>(
    `SELECT inventory FROM odft_app.scenario_snapshots WHERE id = $1`,
    [seeded.snapshotId],
  );
  const inventory = snapshot.rows[0]?.inventory;
  if (!inventory) {
    throw new Error("seeded snapshot missing");
  }
  const breakfast = inventory.restaurants.find((offer) => offer.meal === "breakfast")?.id ?? null;
  const lunch = inventory.restaurants.find((offer) => offer.meal === "lunch")?.id ?? null;
  dinnerId = inventory.restaurants.find((offer) => offer.meal === "dinner")?.id ?? "";
  context = {
    adults: row.adults,
    sightseeingDate: row.sightseeing_date,
    travelVariant: row.travel_variant,
    preferences: tripPreferencesSchema.parse(row.preferences),
    flightOfferId: inventory.flights[0]?.id,
    hotelOfferId: inventory.hotels[0]?.id ?? null,
    destinationAirportId: null,
    mealSelections: { breakfast, lunch, dinner: dinnerId || null },
    confirmedMealIds: [],
    selfArrangedMeals: [],
    selfArrangedActivities: false,
    preferredActivityIds: [],
    dinnerExcludedReason: null,
  };
}, 120_000);

afterAll(async () => {
  await stopMcpHost(host);
  await endWorkerPools(pools);
  await pool.end();
});

function structured<T>(result: { structuredContent?: unknown }): T {
  return result.structuredContent as T;
}

describe("itinerary-tools MCP tools", () => {
  it("estimates a deterministic routed travel time", async () => {
    const client = new McpClient({ config: mcpConfigFor("city-guide-agent") });
    const hotel = (context.hotelOfferId as string) ?? "";
    const first = structured<{ estimatedMinutes: number; distanceKm: number; ruleVersion: string }>(
      await client.callTool("odft-itinerary-tools", {
        name: "estimate_travel_time",
        arguments: {
          delegationId,
          snapshotId: seeded.snapshotId,
          fromRefId: hotel,
          toRefId: dinnerId,
          mode: "walking",
          adults: 2,
        },
      }),
    );
    expect(first.estimatedMinutes).toBeGreaterThan(0);
    expect(first.ruleVersion).toBe("phase10");
    const second = structured<typeof first>(
      await client.callTool("odft-itinerary-tools", {
        name: "estimate_travel_time",
        arguments: {
          delegationId,
          snapshotId: seeded.snapshotId,
          fromRefId: hotel,
          toRefId: dinnerId,
          mode: "walking",
          adults: 2,
        },
      }),
    );
    expect(second).toEqual(first);
  });

  it("rejects unknown snapshot candidates (no invented ids)", async () => {
    const client = new McpClient({ config: mcpConfigFor("city-guide-agent") });
    const result = (await client.callTool("odft-itinerary-tools", {
      name: "estimate_travel_time",
      arguments: {
        delegationId,
        snapshotId: seeded.snapshotId,
        fromRefId: "invented-venue-1",
        toRefId: dinnerId,
        mode: "walking",
        adults: 2,
      },
    })) as { isError?: boolean; structuredContent?: { error?: string } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatch(/unknown snapshot candidate/);
  });

  it("validates a proposed day deterministically and reports findings", async () => {
    const client = new McpClient({ config: mcpConfigFor("city-guide-agent") });
    const stops = [
      { kind: "meal", refId: context.mealSelections.breakfast, startMinute: 8 * 60, durationMinutes: 45 },
      { kind: "meal", refId: context.mealSelections.lunch, startMinute: 13 * 60, durationMinutes: 60 },
      { kind: "meal", refId: dinnerId, startMinute: 19 * 60, durationMinutes: 90 },
    ];
    const first = structured<{ status: string; errors: unknown[]; metrics: unknown; costs: { totalMinor: number } }>(
      await client.callTool("odft-itinerary-tools", {
        name: "validate_itinerary",
        arguments: { delegationId, snapshotId: seeded.snapshotId, context, stops },
      }),
    );
    const second = structured<typeof first>(
      await client.callTool("odft-itinerary-tools", {
        name: "validate_itinerary",
        arguments: { delegationId, snapshotId: seeded.snapshotId, context, stops },
      }),
    );
    expect(second).toEqual(first);
    expect(["valid", "invalid"]).toContain(first.status);
    expect(first.costs.totalMinor).toBeGreaterThan(0);
  });

  it("reports a deterministic budget conflict as invalid findings, not a crash", async () => {
    const client = new McpClient({ config: mcpConfigFor("city-guide-agent") });
    const tightBudgetContext = {
      ...context,
      preferences: { ...(context.preferences as Record<string, unknown>), maxBudgetMinor: 1 },
    };
    const result = structured<{ status: string; errors: { code: string }[] }>(
      await client.callTool("odft-itinerary-tools", {
        name: "validate_itinerary",
        arguments: {
          delegationId,
          snapshotId: seeded.snapshotId,
          context: tightBudgetContext,
          stops: [
            { kind: "meal", refId: context.mealSelections.breakfast, startMinute: 8 * 60, durationMinutes: 45 },
            { kind: "meal", refId: context.mealSelections.lunch, startMinute: 13 * 60, durationMinutes: 60 },
            { kind: "meal", refId: dinnerId, startMinute: 19 * 60, durationMinutes: 90 },
          ],
        },
      }),
    );
    expect(result.status).toBe("invalid");
    expect(result.errors.map((error) => error.code)).toContain("budget_exceeded");
  });

  it("calculates the trip cost from snapshot prices", async () => {
    const client = new McpClient({ config: mcpConfigFor("city-guide-agent") });
    const cost = structured<{ partyTotalMinor: number; currency: string; breakdown: { totalMinor: number } }>(
      await client.callTool("odft-itinerary-tools", {
        name: "calculate_trip_cost",
        arguments: { delegationId, snapshotId: seeded.snapshotId, context },
      }),
    );
    expect(cost.currency).toBe("EUR");
    expect(cost.partyTotalMinor).toBe(cost.breakdown.totalMinor);
    expect(cost.partyTotalMinor).toBeGreaterThan(0);
  });

  it("denies the itinerary endpoint to non-city-guide identities", async () => {
    const client = new McpClient({ config: mcpConfigFor("flight-agent") });
    await expect(
      client.callTool("odft-itinerary-tools", {
        name: "calculate_trip_cost",
        arguments: { delegationId, snapshotId: seeded.snapshotId, context },
      }),
    ).rejects.toThrow(/unavailable/);
  });
});
