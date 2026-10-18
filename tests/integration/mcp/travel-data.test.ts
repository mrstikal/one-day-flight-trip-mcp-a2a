import type { ChildProcess } from "node:child_process";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpClient } from "@odft/protocols";
import { upsertFault } from "@odft/persistence";
import { endWorkerPools, type WorkerPools } from "../_setup.js";
import {
  createMcpTestPool,
  createMcpTestWorkerPools,
  delegationOf,
  mcpConfigFor,
  resetMcpDatabase,
  seedDelegatedSnapshot,
  setupProtocolRoles,
  startMcpHost,
  stopMcpHost,
  waitForHostReady,
  type SeededSnapshot,
} from "./_setup.js";

/**
 * Phase 04 travel-data tools: explicit frozen-snapshot queries with stable
 * hashes, bounded pages and domain scoping — and the guarantee that an MCP read
 * writes nothing (no artifacts, no fault counters, no snapshot changes), even
 * when a simulated provider fault is honored.
 */

let pool: Pool;
let pools: WorkerPools;
let host: ChildProcess;
let seeded: SeededSnapshot;

beforeAll(async () => {
  pool = createMcpTestPool();
  pools = createMcpTestWorkerPools();
  await resetMcpDatabase(pool);
  setupProtocolRoles();
  seeded = await seedDelegatedSnapshot(pool, pools);
  host = startMcpHost();
  await waitForHostReady(host);
}, 120_000);

afterAll(async () => {
  await stopMcpHost(host);
  await endWorkerPools(pools);
  await pool.end();
});

interface CandidatePage<T> {
  readonly domain: string;
  readonly snapshotId: string;
  readonly domainHash: string;
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly hasMore: boolean;
  readonly items: T[];
  readonly providerStatus: string;
  readonly reason: string | null;
}

function structured<T>(result: { structuredContent?: unknown }): T {
  return result.structuredContent as T;
}

async function writeCounts(): Promise<{
  snapshots: number;
  artifacts: number;
  reservations: number;
  faults: number;
}> {
  const row = await pool.query<{
    snapshots: string;
    artifacts: string;
    reservations: string;
    faults: string;
  }>(
    `SELECT (SELECT count(*) FROM odft_app.scenario_snapshots) AS snapshots,
            (SELECT count(*) FROM odft_app.recommendation_artifacts) AS artifacts,
            (SELECT count(*) FROM odft_app.reservations) AS reservations,
            (SELECT count(*) FROM odft_app.simulation_faults) AS faults`,
  );
  const first = row.rows[0];
  return {
    snapshots: Number(first?.snapshots ?? 0),
    artifacts: Number(first?.artifacts ?? 0),
    reservations: Number(first?.reservations ?? 0),
    faults: Number(first?.faults ?? 0),
  };
}

describe("travel-data MCP tools", () => {
  it("returns stable delegation-scoped scenario metadata and hashes", async () => {
    const client = new McpClient({ config: mcpConfigFor("flight-agent") });
    const delegationId = await delegationOf(pool, {
      tripId: seeded.tripId,
      agentIdentity: "flight-agent",
    });
    const first = structured<{
      snapshotId: string;
      counts: { hotels: number };
      domainContentHashes: Record<string, string>;
    }>(
      await client.callTool("odft-travel-data", {
        name: "get_scenario_metadata",
        arguments: { delegationId, snapshotId: seeded.snapshotId },
      }),
    );
    const second = structured<typeof first>(
      await client.callTool("odft-travel-data", {
        name: "get_scenario_metadata",
        arguments: { delegationId, snapshotId: seeded.snapshotId },
      }),
    );
    expect(first.snapshotId).toBe(seeded.snapshotId);
    expect(first.counts.hotels).toBeGreaterThan(0);
    expect(second.domainContentHashes).toEqual(first.domainContentHashes);
    const observations = await pool.query<{
      trip_id: string | null;
      delegation_id: string | null;
    }>(
      `SELECT trip_id, delegation_id FROM odft_app.protocol_observations
        WHERE source = 'mcp-travel-data' AND delegation_id = $1
        ORDER BY id DESC LIMIT 2`,
      [delegationId],
    );
    expect(observations.rows).toHaveLength(2);
    expect(observations.rows.every((row) => row.trip_id === seeded.tripId)).toBe(true);
  });

  it("returns only schedule-valid flight combinations of the delegated approval", async () => {
    const client = new McpClient({ config: mcpConfigFor("flight-agent") });
    const delegationId = await delegationOf(pool, {
      tripId: seeded.tripId,
      agentIdentity: "flight-agent",
    });
    const page = structured<CandidatePage<{ id: string }>>(
      await client.callTool("odft-travel-data", {
        name: "search_flights",
        arguments: { delegationId, snapshotId: seeded.snapshotId, pageSize: 5 },
      }),
    );
    if (page.providerStatus !== "ok") {
      throw new Error(`flight search failed: ${JSON.stringify(page)}`);
    }
    expect(page.domain).toBe("flights");
    expect(page.domainHash).toMatch(/^[a-f0-9]{64}$/);
    expect(page.providerStatus).toBe("ok");
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.length).toBeLessThanOrEqual(5);

    const valid = await pool.query<{ result: { validCombinationIds: string[] } }>(
      `SELECT sv.result FROM odft_app.schedule_validations sv
         JOIN odft_app.trips t ON t.current_schedule_validation_id = sv.id
        WHERE t.id = $1`,
      [seeded.tripId],
    );
    const validIds = new Set(valid.rows[0]?.result.validCombinationIds ?? []);
    expect(validIds.size).toBeGreaterThan(0);
    // Every page, not just the first: the tool may only return Stage-B-valid ids.
    let cursorPage = 1;
    let seen = 0;
    for (;;) {
      const current = structured<CandidatePage<{ id: string }>>(
        await client.callTool("odft-travel-data", {
          name: "search_flights",
          arguments: {
            delegationId,
            snapshotId: seeded.snapshotId,
            page: cursorPage,
            pageSize: 50,
          },
        }),
      );
      for (const item of current.items) {
        expect(validIds.has(item.id)).toBe(true);
      }
      seen += current.items.length;
      if (!current.hasMore) {
        break;
      }
      cursorPage += 1;
    }
    expect(seen).toBe(validIds.size);
  });

  it("honors a simulated flight-provider fault without writes", async () => {
    await upsertFault(pool, { tripId: seeded.tripId, domain: "flights", fault: "no_flights" });
    const before = await writeCounts();
    const client = new McpClient({ config: mcpConfigFor("flight-agent") });
    const delegationId = await delegationOf(pool, {
      tripId: seeded.tripId,
      agentIdentity: "flight-agent",
    });
    const page = structured<CandidatePage<unknown>>(
      await client.callTool("odft-travel-data", {
        name: "search_flights",
        arguments: { delegationId, snapshotId: seeded.snapshotId },
      }),
    );
    expect(page.providerStatus).toBe("unavailable");
    expect(page.items).toEqual([]);
    const after = await writeCounts();
    expect(after).toEqual(before);
    await pool.query(`DELETE FROM odft_app.simulation_faults WHERE trip_id = $1`, [seeded.tripId]);
  });

  it("returns hotel/restaurant/attraction/event candidates with facts and stable ordering", async () => {
    const client = new McpClient({ config: mcpConfigFor("city-guide-agent") });
    const delegationId = await delegationOf(pool, {
      tripId: seeded.tripId,
      agentIdentity: "city-guide-agent",
    });

    const hotelsDelegation = await delegationOf(pool, {
      tripId: seeded.tripId,
      agentIdentity: "accommodation-agent",
    });
    const accommodationClient = new McpClient({ config: mcpConfigFor("accommodation-agent") });
    const hotels = structured<
      CandidatePage<{ id: string; partyTotalMinor: number; level: string }>
    >(
      await accommodationClient.callTool("odft-travel-data", {
        name: "search_hotels",
        arguments: { delegationId: hotelsDelegation, snapshotId: seeded.snapshotId },
      }),
    );
    expect(hotels.items.length).toBeGreaterThan(0);
    const totals = hotels.items.map((hotel) => hotel.partyTotalMinor);
    expect([...totals].sort((a, b) => a - b)).toEqual(totals);

    const meals = structured<CandidatePage<{ id: string; meal: string }>>(
      await client.callTool("odft-travel-data", {
        name: "search_restaurants",
        arguments: { delegationId, snapshotId: seeded.snapshotId, meal: "dinner" },
      }),
    );
    expect(meals.items.every((item) => item.meal === "dinner")).toBe(true);

    const attractions = structured<CandidatePage<{ id: string; reference: boolean }>>(
      await client.callTool("odft-travel-data", {
        name: "search_attractions",
        arguments: { delegationId, snapshotId: seeded.snapshotId, pageSize: 50 },
      }),
    );
    expect(attractions.items.length).toBeGreaterThan(0);

    const events = structured<CandidatePage<{ id: string; date: string }>>(
      await client.callTool("odft-travel-data", {
        name: "search_events",
        arguments: { delegationId, snapshotId: seeded.snapshotId },
      }),
    );
    expect(events.providerStatus).toBe("ok");
  });

  it("honors a simulated provider fault without writing a fault counter or artifact", async () => {
    await upsertFault(pool, {
      tripId: seeded.tripId,
      domain: "hotels",
      fault: "hotels_unavailable",
    });
    const before = await writeCounts();

    const client = new McpClient({ config: mcpConfigFor("accommodation-agent") });
    const delegationId = await delegationOf(pool, {
      tripId: seeded.tripId,
      agentIdentity: "accommodation-agent",
    });
    const page = structured<CandidatePage<unknown>>(
      await client.callTool("odft-travel-data", {
        name: "search_hotels",
        arguments: { delegationId, snapshotId: seeded.snapshotId },
      }),
    );
    expect(page.providerStatus).toBe("unavailable");
    expect(page.items).toEqual([]);
    expect(page.reason).toMatch(/scenario control/);

    const after = await writeCounts();
    expect(after).toEqual(before);
    await pool.query(`DELETE FROM odft_app.simulation_faults WHERE trip_id = $1`, [seeded.tripId]);
  });

  it("never writes on repeated reads and keeps the frozen snapshot unchanged", async () => {
    const before = await writeCounts();
    const client = new McpClient({ config: mcpConfigFor("flight-agent") });
    const delegationId = await delegationOf(pool, {
      tripId: seeded.tripId,
      agentIdentity: "flight-agent",
    });
    const first = structured<CandidatePage<{ id: string }>>(
      await client.callTool("odft-travel-data", {
        name: "search_flights",
        arguments: { delegationId, snapshotId: seeded.snapshotId },
      }),
    );
    const second = structured<CandidatePage<{ id: string }>>(
      await client.callTool("odft-travel-data", {
        name: "search_flights",
        arguments: { delegationId, snapshotId: seeded.snapshotId },
      }),
    );
    expect(second.items).toEqual(first.items);
    const after = await writeCounts();
    expect(after).toEqual(before);
  });
});
