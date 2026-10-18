import type { ChildProcess } from "node:child_process";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpClient } from "@odft/protocols";
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
 * Phase 04 geography tools over real HTTP: reference search/details, catchments,
 * deterministic distance and the pure Stage A route validator (FEASIBLE and the
 * PRG -> České Budějovice rejection), all read-only.
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

describe("geography MCP tools", () => {
  it("searches countries, cities and airports deterministically", async () => {
    const client = new McpClient({ config: mcpConfigFor("flight-agent") });
    const countries = structured<{ items: { countryKey: string }[] }>(
      await client.callTool("odft-geography", {
        name: "search_countries",
        arguments: { q: "Czech" },
      }),
    );
    expect(countries.items.some((country) => country.countryKey === "CZ")).toBe(true);

    const cities = structured<{ items: { id: string }[] }>(
      await client.callTool("odft-geography", {
        name: "search_cities",
        arguments: { q: "Rome", countryKey: "IT" },
      }),
    );
    expect(cities.items.some((city) => city.id === "geonames:3169070")).toBe(true);

    const airports = structured<{ items: { iata: string }[] }>(
      await client.callTool("odft-geography", { name: "find_airports", arguments: { q: "PRG" } }),
    );
    expect(airports.items.some((airport) => airport.iata === "PRG")).toBe(true);
  });

  it("returns city details, airport details and reviewed city airports", async () => {
    const client = new McpClient({ config: mcpConfigFor("flight-agent") });
    const city = structured<{ id: string; name: string }>(
      await client.callTool("odft-geography", {
        name: "get_city_details",
        arguments: { cityId: "geonames:3169070" },
      }),
    );
    expect(city.name).toBe("Rome");

    const airport = structured<{ iata: string; zone: string }>(
      await client.callTool("odft-geography", {
        name: "get_airport_details",
        arguments: { airportId: "ourairports:4408" },
      }),
    );
    expect(airport.iata).toBe("PRG");

    const cityAirports = structured<{ links: { airportId: string }[] }>(
      await client.callTool("odft-geography", {
        name: "get_city_airports",
        arguments: { cityId: "geonames:3169070" },
      }),
    );
    expect(Array.isArray(cityAirports.links)).toBe(true);
  });

  it("estimates a stable distance between reference anchors", async () => {
    const client = new McpClient({ config: mcpConfigFor("flight-agent") });
    const first = structured<{ distanceKm: number }>(
      await client.callTool("odft-geography", {
        name: "estimate_distance",
        arguments: { fromAirportId: "ourairports:4408", toCityId: "geonames:3169070" },
      }),
    );
    const second = structured<{ distanceKm: number }>(
      await client.callTool("odft-geography", {
        name: "estimate_distance",
        arguments: { fromAirportId: "ourairports:4408", toCityId: "geonames:3169070" },
      }),
    );
    expect(first.distanceKm).toBe(second.distanceKm);
    expect(first.distanceKm).toBeGreaterThan(900);
  });

  it("validates a feasible delegated route and rejects the ground-travel route", async () => {
    const client = new McpClient({ config: mcpConfigFor("flight-agent") });
    const delegationId = await delegationOf(pool, {
      tripId: seeded.tripId,
      agentIdentity: "flight-agent",
    });
    const feasible = structured<{ status: string }>(
      await client.callTool("odft-geography", {
        name: "validate_air_route",
        arguments: {
          delegationId,
          originAirportId: "ourairports:4408",
          destinationCityId: "geonames:3169070",
          sightseeingDate: "2026-12-01",
          travelVariant: "one_night",
          adults: 1,
        },
      }),
    );
    if (feasible.status === undefined) {
      // Surface the safe tool error for debugging.
      throw new Error(`route tool failed: ${JSON.stringify(feasible)}`);
    }
    expect(feasible.status).toBe("FEASIBLE");

    const rejected = structured<{ status: string; reasons: { code: string }[] }>(
      await client.callTool("odft-geography", {
        name: "validate_air_route",
        arguments: {
          delegationId,
          originAirportId: "ourairports:4408",
          destinationCityId: "geonames:3077916",
          sightseeingDate: "2026-12-01",
          travelVariant: "one_night",
          adults: 1,
        },
      }),
    );
    expect(rejected.status).toBe("INFEASIBLE");
    expect(rejected.reasons.map((reason) => reason.code)).toContain("GROUND_TRAVEL_PREFERRED");
  });

  it("refuses the route tool without a valid delegated context", async () => {
    const client = new McpClient({ config: mcpConfigFor("flight-agent") });
    const result = (await client.callTool("odft-geography", {
      name: "validate_air_route",
      arguments: {
        delegationId: "11111111-1111-4111-8111-111111111111",
        originAirportId: "ourairports:4408",
        destinationCityId: "geonames:3169070",
        sightseeingDate: "2026-12-01",
        travelVariant: "one_night",
        adults: 1,
      },
    })) as { isError?: boolean; structuredContent?: { error?: string } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatch(/not found/);
  });
});
