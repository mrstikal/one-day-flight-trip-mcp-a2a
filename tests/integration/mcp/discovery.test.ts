import type { ChildProcess } from "node:child_process";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpClient } from "@odft/protocols";
import { endWorkerPools, type WorkerPools } from "../_setup.js";
import {
  MCP_TEST_PORTS,
  createMcpTestPool,
  createMcpTestWorkerPools,
  mcpConfigFor,
  resetMcpDatabase,
  seedDelegatedSnapshot,
  setupProtocolRoles,
  startMcpHost,
  stopMcpHost,
  waitForHostReady,
} from "./_setup.js";

/**
 * Phase 04 discovery: the three endpoint identities are reachable, negotiate
 * the pinned modern protocol, expose exactly the §3.4 inventory and reject
 * unauthenticated requests. The health route performs no external request.
 */

let pool: Pool;
let pools: WorkerPools;
let host: ChildProcess;

beforeAll(async () => {
  pool = createMcpTestPool();
  pools = createMcpTestWorkerPools();
  await resetMcpDatabase(pool);
  setupProtocolRoles();
  host = startMcpHost();
  await waitForHostReady(host);
}, 90_000);

afterAll(async () => {
  await stopMcpHost(host);
  await endWorkerPools(pools);
  await pool.end();
});

describe("MCP host discovery", () => {
  it("answers the lightweight health route without any external request", async () => {
    for (const [endpoint, path] of [
      ["odft-geography", "/geography/mcp"],
      ["odft-travel-data", "/travel-data/mcp"],
      ["odft-itinerary-tools", "/itinerary-tools/mcp"],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${MCP_TEST_PORTS[endpointKey(path)]}/health`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { status: string; endpoint: string };
      expect(body.status).toBe("ok");
      expect(body.endpoint).toBe(endpoint);
    }
  });

  it("negotiates the pinned modern protocol and lists the exact tool inventory", async () => {
    const client = new McpClient({ config: mcpConfigFor("city-guide-agent") });
    expect(await client.negotiatedProtocolVersion("odft-geography")).toBe("2026-07-28");

    const geography = await client.listTools("odft-geography");
    expect(geography.tools.map((tool) => tool.name).sort()).toEqual([
      "estimate_distance",
      "find_airports",
      "get_airport_details",
      "get_city_airports",
      "get_city_details",
      "search_cities",
      "search_countries",
      "validate_air_route",
    ]);

    const travelData = await client.listTools("odft-travel-data");
    expect(travelData.tools.map((tool) => tool.name).sort()).toEqual([
      "get_scenario_metadata",
      "search_attractions",
      "search_events",
      "search_flights",
      "search_hotels",
      "search_restaurants",
    ]);

    const itineraryTools = await client.listTools("odft-itinerary-tools");
    expect(itineraryTools.tools.map((tool) => tool.name).sort()).toEqual([
      "calculate_trip_cost",
      "estimate_travel_time",
      "validate_itinerary",
    ]);
  });

  it("exposes the versioned static resources and the scoped manifest template", async () => {
    const client = new McpClient({ config: mcpConfigFor("city-guide-agent") });
    const geography = await client.listResources("odft-geography");
    const uris = geography.resources.map((resource) => resource.uri);
    expect(uris).toContain("odft://geography/coverage");
    expect(uris).toContain("odft://geography/licenses");

    const itinerary = await client.listResources("odft-itinerary-tools");
    expect(itinerary.resources.map((resource) => resource.uri)).toContain(
      "odft://itinerary/pace-profiles",
    );

    const pace = await client.readResource("odft-itinerary-tools", {
      uri: "odft://itinerary/pace-profiles",
    });
    const text = pace.contents[0] && "text" in pace.contents[0] ? pace.contents[0].text : "";
    const parsed = JSON.parse(text) as { version: string; profiles: Record<string, unknown> };
    expect(parsed.version).toBe("pace-v1");
    expect(Object.keys(parsed.profiles).sort()).toEqual(["intensive", "moderate", "relaxed"]);
  });

  it("reads the delegation-scoped manifest resource and denies without a delegation", async () => {
    const client = new McpClient({ config: mcpConfigFor("accommodation-agent") });
    const seededSnapshot = await seedDelegatedSnapshot(pool, pools);
    const read = await client.readResource("odft-travel-data", {
      uri: `odft://scenario/${seededSnapshot.snapshotId}/manifest`,
    });
    const text = read.contents[0] && "text" in read.contents[0] ? read.contents[0].text : "";
    const parsed = JSON.parse(text) as {
      snapshotId: string;
      domainContentHashes: Record<string, string>;
    };
    expect(parsed.snapshotId).toBe(seededSnapshot.snapshotId);

    // Revoking the delegation makes the manifest unreadable immediately.
    await pool.query(
      `UPDATE odft_app.agent_delegations SET status = 'revoked', revoked_at = now(), revoke_reason = 'test'
        WHERE trip_id = $1 AND agent_identity = 'accommodation-agent'`,
      [seededSnapshot.tripId],
    );
    await expect(
      client.readResource("odft-travel-data", {
        uri: `odft://scenario/${seededSnapshot.snapshotId}/manifest`,
      }),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("rejects an unauthenticated request before any dispatch", async () => {
    const response = await fetch(`http://127.0.0.1:${MCP_TEST_PORTS.geography}/geography/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects a foreign Host/Origin and times out an unavailable endpoint", async () => {
    const badHost = await fetch(`http://127.0.0.1:${MCP_TEST_PORTS.geography}/geography/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "evil.example",
        authorization: "Bearer test-token-flight-agent-0123456789",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    // Host validation is enforced by the SDK's handler chain (400/421); either
    // way the request is rejected before any dispatch.
    expect(badHost.status).toBeGreaterThanOrEqual(400);

    const badOrigin = await fetch(`http://127.0.0.1:${MCP_TEST_PORTS.geography}/geography/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://evil.example",
        authorization: "Bearer test-token-flight-agent-0123456789",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(badOrigin.status).toBe(403);

    // An unreachable endpoint must fail within the explicit deadline.
    const { McpClient, DEFAULT_PROTOCOL_TIMEOUTS } = await import("@odft/protocols");
    const config = mcpConfigFor("flight-agent");
    const unreachable = new McpClient({
      config: {
        ...config,
        timeouts: { ...DEFAULT_PROTOCOL_TIMEOUTS, mcpTimeoutMs: 1_500 },
        mcpRegistry: {
          schemaVersion: 1,
          services: [
            {
              serviceName: "odft-geography",
              endpointUrl: "http://127.0.0.1:4599/geography/mcp",
              credentialRef: "TEST_TOKEN",
            },
          ],
        },
      },
    });
    const startedAt = Date.now();
    await expect(unreachable.negotiatedProtocolVersion("odft-geography")).rejects.toThrow(
      /unavailable|did not complete its handshake/,
    );
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 30_000);

  it("records only sanitized observations for real invocations", async () => {
    const client = new McpClient({ config: mcpConfigFor("flight-agent") });
    const before = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM odft_app.protocol_observations WHERE source = 'mcp-geography'`,
    );
    await client.callTool("odft-geography", {
      name: "search_countries",
      arguments: { q: "Czech" },
    });
    const rows = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM odft_app.protocol_observations
        WHERE source = 'mcp-geography' ORDER BY created_at DESC LIMIT 1`,
    );
    const after = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM odft_app.protocol_observations WHERE source = 'mcp-geography'`,
    );
    expect(Number(after.rows[0]?.count)).toBeGreaterThan(Number(before.rows[0]?.count));
    const payload = rows.rows[0]?.payload ?? {};
    expect(Object.keys(payload).sort()).toEqual([
      "counters",
      "detail",
      "durationMs",
      "failureCategory",
      "status",
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/Czech|test-token/);
  });

  it("rejects a legacy 2025-era client", async () => {
    const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${MCP_TEST_PORTS.geography}/geography/mcp`),
      { requestInit: { headers: { authorization: "Bearer test-token-flight-agent-0123456789" } } },
    );
    const legacy = new Client({ name: "legacy", version: "1.0.0" });
    await expect(legacy.connect(transport)).rejects.toBeTruthy();
  });
});

function endpointKey(path: string): keyof typeof MCP_TEST_PORTS {
  return path.includes("geography")
    ? "geography"
    : path.includes("travel-data")
      ? "travelData"
      : "itineraryTools";
}
