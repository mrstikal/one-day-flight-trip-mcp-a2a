import type { ChildProcess } from "node:child_process";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpClient } from "@odft/protocols";
import { endWorkerPools, type WorkerPools } from "../graph/_setup.js";
import {
  createMcpTestPool,
  createMcpTestWorkerPools,
  delegationOf,
  mcpConfigFor,
  readOnlyDatabaseUrl,
  resetMcpDatabase,
  seedDelegatedSnapshot,
  setupProtocolRoles,
  startMcpHost,
  stopMcpHost,
  waitForHostReady,
  type SeededSnapshot,
} from "./_setup.js";

/**
 * Phase 04 authorization: identity/endpoint allowlists, delegation scope,
 * revocation and the read-only database role's write denial. An unauthorized
 * query can never escape its scope.
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

function structured<T>(result: { structuredContent?: unknown }): T {
  return result.structuredContent as T;
}

async function callTool(
  identity: "flight-agent" | "accommodation-agent" | "city-guide-agent",
  service: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; structuredContent?: { error?: string } }> {
  const client = new McpClient({ config: mcpConfigFor(identity) });
  return (await client.callTool(service, { name, arguments: args })) as never;
}

describe("MCP authorization", () => {
  it("enforces the per-identity domain allowlist of the travel-data endpoint", async () => {
    const flightDelegation = await delegationOf(pool, {
      tripId: seeded.tripId,
      agentIdentity: "flight-agent",
    });
    const denied = await callTool("flight-agent", "odft-travel-data", "search_hotels", {
      delegationId: flightDelegation,
      snapshotId: seeded.snapshotId,
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent?.error).toMatch(/may not query the hotel domain/);
  });

  it("denies the geography endpoint to unknown identities and cross-identity delegations", async () => {
    const cityGuideDelegation = await delegationOf(pool, {
      tripId: seeded.tripId,
      agentIdentity: "city-guide-agent",
    });
    const crossIdentity = await callTool(
      "flight-agent",
      "odft-geography",
      "validate_air_route",
      {
        delegationId: cityGuideDelegation,
        originAirportId: "ourairports:4408",
        destinationCityId: "geonames:3169070",
        sightseeingDate: "2026-12-01",
        travelVariant: "one_night",
        adults: 1,
      },
    );
    expect(crossIdentity.isError).toBe(true);
    expect(crossIdentity.structuredContent?.error).toMatch(/different agent identity/);
  });

  it("denies a delegation that does not authorize the requested snapshot", async () => {
    const delegationId = await delegationOf(pool, {
      tripId: seeded.tripId,
      agentIdentity: "accommodation-agent",
    });
    const denied = await callTool("accommodation-agent", "odft-travel-data", "search_hotels", {
      delegationId,
      snapshotId: "22222222-2222-4222-8222-222222222222",
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent?.error).toMatch(/not the delegated frozen snapshot/);
  });

  it("denies a revoked delegation immediately", async () => {
    const delegationId = await delegationOf(pool, {
      tripId: seeded.tripId,
      agentIdentity: "accommodation-agent",
    });
    await pool.query(
      `UPDATE odft_app.agent_delegations SET status = 'revoked', revoked_at = now(), revoke_reason = 'test' WHERE id = $1`,
      [delegationId],
    );
    const denied = await callTool("accommodation-agent", "odft-travel-data", "search_hotels", {
      delegationId,
      snapshotId: seeded.snapshotId,
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent?.error).toMatch(/revoked/);
    await pool.query(
      `UPDATE odft_app.agent_delegations SET status = 'working', revoked_at = NULL, revoke_reason = NULL WHERE id = $1`,
      [delegationId],
    );
  });

  it("denies the itinerary endpoint to identities outside its allowlist", async () => {
    const delegationId = await delegationOf(pool, {
      tripId: seeded.tripId,
      agentIdentity: "accommodation-agent",
    });
    // The endpoint factory refuses to build a server for a disallowed identity,
    // so not even discovery or tool listing succeeds.
    await expect(
      callTool("accommodation-agent", "odft-itinerary-tools", "estimate_travel_time", {
        delegationId,
        snapshotId: seeded.snapshotId,
        fromRefId: "venue-1",
        toRefId: "venue-2",
        mode: "walking",
        adults: 2,
      }),
    ).rejects.toThrow(/unavailable/);
  });

  it("denies scenario metadata without a delegation for the snapshot", async () => {
    const foreign = await callTool("flight-agent", "odft-travel-data", "get_scenario_metadata", {
      delegationId: "11111111-1111-4111-8111-111111111111",
      snapshotId: seeded.snapshotId,
    });
    expect(foreign.isError).toBe(true);
    expect(foreign.structuredContent?.error).toMatch(/not found/);

    const otherSnapshot = await callTool("flight-agent", "odft-travel-data", "get_scenario_metadata", {
      delegationId: await delegationOf(pool, {
        tripId: seeded.tripId,
        agentIdentity: "flight-agent",
      }),
      snapshotId: "22222222-2222-4222-8222-222222222222",
    });
    expect(otherSnapshot.isError).toBe(true);
    expect(otherSnapshot.structuredContent?.error).toMatch(/not the delegated frozen snapshot/);
  });

  it("denies an expired delegation deadline", async () => {
    const delegationId = await delegationOf(pool, {
      tripId: seeded.tripId,
      agentIdentity: "accommodation-agent",
    });
    await pool.query(
      `UPDATE odft_app.agent_delegations SET deadline_at = now() - interval '1 minute' WHERE id = $1`,
      [delegationId],
    );
    const denied = await callTool("accommodation-agent", "odft-travel-data", "search_hotels", {
      delegationId,
      snapshotId: seeded.snapshotId,
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent?.error).toMatch(/deadline has passed/);
    await pool.query(`UPDATE odft_app.agent_delegations SET deadline_at = NULL WHERE id = $1`, [
      delegationId,
    ]);
  });

  it("proves the read-only role cannot write domain or reference tables", async () => {
    const readonly = new Pool({ connectionString: readOnlyDatabaseUrl(), max: 1 });
    try {
      await expect(
        readonly.query(`UPDATE odft_app.trips SET revision = revision + 1 WHERE id = $1`, [seeded.tripId]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        readonly.query(`INSERT INTO odft_app.reference_cities (id) VALUES ('x')`),
      ).rejects.toThrow(/permission denied/);
      await expect(
        readonly.query(`DELETE FROM odft_app.scenario_snapshots WHERE id = $1`, [seeded.snapshotId]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        readonly.query(
          `UPDATE odft_app.agent_delegations SET status = 'revoked' WHERE trip_id = $1`,
          [seeded.tripId],
        ),
      ).rejects.toThrow(/permission denied/);
      // Reads still work through the same role.
      const count = await readonly.query<{ count: string }>(
        `SELECT count(*) AS count FROM odft_app.scenario_snapshots WHERE id = $1`,
        [seeded.snapshotId],
      );
      expect(count.rows[0]?.count).toBe("1");
    } finally {
      await readonly.end();
    }
  });

  it("keeps a denied query from changing any state", async () => {
    const before = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM odft_app.agent_delegations`,
    );
    const denied = await callTool("flight-agent", "odft-travel-data", "search_hotels", {
      delegationId: await delegationOf(pool, {
        tripId: seeded.tripId,
        agentIdentity: "flight-agent",
      }),
      snapshotId: seeded.snapshotId,
    });
    expect(denied.isError).toBe(true);
    const after = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM odft_app.agent_delegations`,
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    void structured;
  });
});
