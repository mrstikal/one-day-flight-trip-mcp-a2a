import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { loadCurrentScheduleValidation, loadFeasibleRouteApproval } from "@odft/persistence";
import type { McpHostContext } from "../app.js";
import { McpAuthorizationError, createToolHandler } from "../app.js";
import { TRAVEL_DATA_DOMAIN_ALLOWLIST } from "../config.js";

/**
 * Travel Data MCP tools (plan §3.4): explicit frozen-snapshot queries with
 * delegation-scoped domain membership. Every tool takes `delegationId` plus the
 * explicitly authorized `snapshotId`; the active trip pointer is never read.
 * The per-identity domain allowlist is enforced on top of the delegation scope.
 */

const pageFields = {
  page: z.number().int().min(1).max(100).default(1),
  pageSize: z.number().int().min(1).max(50).default(20),
};

const scoped = z
  .object({
    delegationId: z.string().uuid(),
    snapshotId: z.string().uuid(),
    ...pageFields,
  })
  .strict();

const restaurantsInput = z
  .object({
    delegationId: z.string().uuid(),
    snapshotId: z.string().uuid(),
    meal: z.enum(["breakfast", "lunch", "dinner"]),
    ...pageFields,
  })
  .strict();

const metadataInput = z
  .object({ delegationId: z.string().uuid(), snapshotId: z.string().uuid() })
  .strict();

function assertIdentityDomain(identity: string, domain: string): void {
  const allowed = TRAVEL_DATA_DOMAIN_ALLOWLIST[identity] ?? [];
  if (!allowed.includes(domain)) {
    throw new McpAuthorizationError(
      "FORBIDDEN",
      `identity ${identity} may not query the ${domain} domain`,
    );
  }
}

export function registerTravelDataTools(
  server: McpServer,
  context: McpHostContext,
  identity: string,
): void {
  server.registerTool(
    "search_flights",
    {
      title: "Search flights",
      description:
        "Schedule-valid flight combinations of the delegated frozen snapshot (ranked by party total).",
      inputSchema: scoped,
    },
    createToolHandler(context, "travelData", "search_flights", async (input) => {
      assertIdentityDomain(identity, "flights");
      const authorized = await context.authorize({
        identity,
        endpoint: "travelData",
        delegationId: input.delegationId,
        domain: "flights",
        snapshotId: input.snapshotId,
      });
      const approval = await loadFeasibleRouteApproval(context.readPool, authorized.trip.id);
      if (!approval) {
        throw new Error("the delegated trip has no FEASIBLE route approval");
      }
      const schedule = await loadCurrentScheduleValidation(context.readPool, authorized.trip.id);
      if (!schedule) {
        throw new Error("the delegated trip has no schedule validation");
      }
      return context.snapshotRead.searchFlights({
        snapshotId: input.snapshotId,
        trip: authorized.trip,
        behavior: authorized.behavior,
        attempt: authorized.attempt,
        levelOverride: authorized.scope.levelOverride,
        approval,
        validCombinationIds: schedule.validCombinationIds,
        page: input.page,
        pageSize: input.pageSize,
      });
    }),
  );

  server.registerTool(
    "search_hotels",
    {
      title: "Search hotels",
      description: "Hotel candidates of the delegated frozen snapshot within the delegated category.",
      inputSchema: scoped,
    },
    createToolHandler(context, "travelData", "search_hotels", async (input) => {
      assertIdentityDomain(identity, "hotel");
      const authorized = await context.authorize({
        identity,
        endpoint: "travelData",
        delegationId: input.delegationId,
        domain: "hotel",
        snapshotId: input.snapshotId,
      });
      return context.snapshotRead.searchHotels({
        snapshotId: input.snapshotId,
        trip: authorized.trip,
        behavior: authorized.behavior,
        attempt: authorized.attempt,
        levelOverride: authorized.scope.levelOverride,
        page: input.page,
        pageSize: input.pageSize,
      });
    }),
  );

  server.registerTool(
    "search_restaurants",
    {
      title: "Search restaurants",
      description: "Meal candidates of the delegated frozen snapshot for one meal service.",
      inputSchema: restaurantsInput,
    },
    createToolHandler(context, "travelData", "search_restaurants", async (input) => {
      assertIdentityDomain(identity, input.meal);
      const authorized = await context.authorize({
        identity,
        endpoint: "travelData",
        delegationId: input.delegationId,
        domain: input.meal,
        snapshotId: input.snapshotId,
      });
      return context.snapshotRead.searchRestaurants({
        snapshotId: input.snapshotId,
        trip: authorized.trip,
        behavior: authorized.behavior,
        attempt: authorized.attempt,
        levelOverride: authorized.scope.levelOverride,
        meal: input.meal,
        page: input.page,
        pageSize: input.pageSize,
      });
    }),
  );

  server.registerTool(
    "search_attractions",
    {
      title: "Search attractions",
      description: "Activity candidates of the delegated frozen snapshot (deterministic ordering).",
      inputSchema: scoped,
    },
    createToolHandler(context, "travelData", "search_attractions", async (input) => {
      assertIdentityDomain(identity, "attractions");
      const authorized = await context.authorize({
        identity,
        endpoint: "travelData",
        delegationId: input.delegationId,
        domain: "attractions",
        snapshotId: input.snapshotId,
      });
      return context.snapshotRead.searchAttractions({
        snapshotId: input.snapshotId,
        trip: authorized.trip,
        behavior: authorized.behavior,
        attempt: authorized.attempt,
        levelOverride: authorized.scope.levelOverride,
        page: input.page,
        pageSize: input.pageSize,
      });
    }),
  );

  server.registerTool(
    "search_events",
    {
      title: "Search events",
      description: "Event candidates of the delegated frozen snapshot for the sightseeing date.",
      inputSchema: scoped,
    },
    createToolHandler(context, "travelData", "search_events", async (input) => {
      assertIdentityDomain(identity, "events");
      const authorized = await context.authorize({
        identity,
        endpoint: "travelData",
        delegationId: input.delegationId,
        domain: "events",
        snapshotId: input.snapshotId,
      });
      return context.snapshotRead.searchEvents({
        snapshotId: input.snapshotId,
        trip: authorized.trip,
        behavior: authorized.behavior,
        attempt: authorized.attempt,
        levelOverride: authorized.scope.levelOverride,
        page: input.page,
        pageSize: input.pageSize,
      });
    }),
  );

  server.registerTool(
    "get_scenario_metadata",
    {
      title: "Scenario metadata",
      description:
        "Frozen snapshot identity: versions, domain hashes and bounded content counts (delegation-scoped).",
      inputSchema: metadataInput,
    },
    createToolHandler(context, "travelData", "get_scenario_metadata", async (input) => {
      // The same snapshot authorization as every other scenario tool: an
      // authenticated identity alone is not evidence that it may read a
      // snapshot's metadata.
      await context.authorize({
        identity,
        endpoint: "travelData",
        delegationId: input.delegationId,
        snapshotId: input.snapshotId,
      });
      return context.snapshotRead.readScenarioMetadata(input.snapshotId);
    }),
  );
}
