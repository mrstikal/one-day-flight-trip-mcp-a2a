import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { haversineKm, validateRoute } from "@odft/data";
import {
  buildRouteInputs,
  getCityAirports,
  getReferenceAirport,
  getReferenceCity,
  searchAirports,
  searchCities,
  searchCountries,
} from "@odft/persistence";
import type { McpHostContext } from "../app.js";
import { createToolHandler } from "../app.js";

/**
 * Geography MCP tools (plan §3.4): reference search/details, catchments,
 * haversine distance and the pure Stage A route validator. All read-only; the
 * route tool additionally requires a valid delegated context.
 */

const countryQuery = z.object({ q: z.string().max(80).default(""), limit: z.number().int().min(1).max(50).default(20) }).strict();
const cityQuery = z
  .object({
    countryKey: z.string().length(2).nullable().default(null),
    q: z.string().max(80).default(""),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
const airportQuery = z.object({ q: z.string().max(80).default(""), limit: z.number().int().min(1).max(50).default(20) }).strict();
const cityId = z.object({ cityId: z.string().min(1).max(120) }).strict();
const airportId = z.object({ airportId: z.string().min(1).max(120) }).strict();
const distanceInput = z
  .object({
    fromCityId: z.string().min(1).max(120).nullable().default(null),
    fromAirportId: z.string().min(1).max(120).nullable().default(null),
    toCityId: z.string().min(1).max(120).nullable().default(null),
    toAirportId: z.string().min(1).max(120).nullable().default(null),
  })
  .strict()
  .refine(
    (value) =>
      (value.fromCityId !== null) !== (value.fromAirportId !== null) &&
      (value.toCityId !== null) !== (value.toAirportId !== null),
    { message: "exactly one of fromCityId/fromAirportId and one of toCityId/toAirportId is required" },
  );
const routeInput = z
  .object({
    delegationId: z.string().uuid(),
    originAirportId: z.string().min(1).max(120),
    destinationCityId: z.string().min(1).max(120),
    sightseeingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    travelVariant: z.enum(["one_night", "two_nights"]),
    adults: z.number().int().min(1).max(6),
  })
  .strict();

async function anchorOf(
  context: McpHostContext,
  ref: { cityId?: string | null; airportId?: string | null },
): Promise<{ lat: number; lon: number; label: string }> {
  if (ref.airportId) {
    const airport = await getReferenceAirport(context.readPool, ref.airportId);
    if (!airport) {
      throw new Error(`unknown airport ${ref.airportId}`);
    }
    return { lat: airport.lat, lon: airport.lon, label: airport.iata };
  }
  const city = await getReferenceCity(context.readPool, ref.cityId as string);
  if (!city) {
    throw new Error(`unknown city ${ref.cityId}`);
  }
  return { lat: city.lat, lon: city.lon, label: city.name };
}

export function registerGeographyTools(
  server: McpServer,
  context: McpHostContext,
  identity: string,
): void {
  server.registerTool(
    "search_countries",
    {
      title: "Search countries",
      description: "Search admitted countries by name or ISO key (bounded).",
      inputSchema: countryQuery,
    },
    createToolHandler(context, "geography", "search_countries", async (input) => ({
      items: await searchCountries(context.readPool, input.q, input.limit),
    })),
  );

  server.registerTool(
    "search_cities",
    {
      title: "Search cities",
      description: "Search reference cities, optionally bounded to a country.",
      inputSchema: cityQuery,
    },
    createToolHandler(context, "geography", "search_cities", async (input) => ({
      items: (
        await searchCities(context.readPool, {
          q: input.q,
          limit: input.limit,
          countryKey: input.countryKey ?? "",
        })
      ).items,
    })),
  );

  server.registerTool(
    "find_airports",
    {
      title: "Find airports",
      description: "Search eligible origin airports by IATA/ICAO/name.",
      inputSchema: airportQuery,
    },
    createToolHandler(context, "geography", "find_airports", async (input) => ({
      items: (
        await searchAirports(context.readPool, { q: input.q, limit: input.limit, scope: "origin" })
      ).items,
    })),
  );

  server.registerTool(
    "get_city_details",
    { title: "City details", description: "Reference details of one city.", inputSchema: cityId },
    createToolHandler(context, "geography", "get_city_details", async (input) => {
      const city = await getReferenceCity(context.readPool, input.cityId);
      if (!city) {
        throw new Error(`unknown city ${input.cityId}`);
      }
      return city;
    }),
  );

  server.registerTool(
    "get_airport_details",
    { title: "Airport details", description: "Reference details of one airport.", inputSchema: airportId },
    createToolHandler(context, "geography", "get_airport_details", async (input) => {
      const airport = await getReferenceAirport(context.readPool, input.airportId);
      if (!airport) {
        throw new Error(`unknown airport ${input.airportId}`);
      }
      return airport;
    }),
  );

  server.registerTool(
    "get_city_airports",
    {
      title: "City airports",
      description: "Reviewed destination airports of a city (catchment rules applied).",
      inputSchema: cityId,
    },
    createToolHandler(context, "geography", "get_city_airports", async (input) => ({
      ...(await getCityAirports(context.readPool, input.cityId)),
    })),
  );

  server.registerTool(
    "estimate_distance",
    { title: "Estimate distance", description: "Haversine distance between two reference anchors.", inputSchema: distanceInput },
    createToolHandler(context, "geography", "estimate_distance", async (input) => {
      const from = await anchorOf(context, { cityId: input.fromCityId, airportId: input.fromAirportId });
      const to = await anchorOf(context, { cityId: input.toCityId, airportId: input.toAirportId });
      return {
        from: from.label,
        to: to.label,
        distanceKm: Math.round(haversineKm(from, to) * 100) / 100,
      };
    }),
  );

  server.registerTool(
    "validate_air_route",
    {
      title: "Validate air route",
      description:
        "Deterministic Stage A feasibility of one route under a valid delegation (no generation, no writes).",
      inputSchema: routeInput,
    },
    createToolHandler(context, "geography", "validate_air_route", async (input) => {
      await context.authorize({
        identity,
        endpoint: "geography",
        delegationId: input.delegationId,
        needRouteValidation: true,
      });
      const routeInputs = await buildRouteInputs(context.readPool, {
        originAirportId: input.originAirportId,
        destinationCityId: input.destinationCityId,
        destinationCountryKey: "",
        sightseeingDate: input.sightseeingDate,
        travelVariant: input.travelVariant,
        adults: input.adults,
      });
      if (!routeInputs) {
        throw new Error("the reference data cannot evaluate this route");
      }
      return validateRoute(routeInputs);
    }),
  );
}
