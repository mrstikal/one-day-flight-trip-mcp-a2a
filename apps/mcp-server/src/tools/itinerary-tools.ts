import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { tripPreferencesSchema } from "@odft/contracts";
import type { McpHostContext } from "../app.js";
import { createToolHandler } from "../app.js";

/**
 * Itinerary Tools MCP tools (plan §3.4): deterministic routing, assembly,
 * validation, metrics and cost over an explicit frozen snapshot. Every
 * referenced candidate is validated against the snapshot; nothing is persisted.
 */

const travelTimeInput = z
  .object({
    delegationId: z.string().uuid(),
    snapshotId: z.string().uuid(),
    fromRefId: z.string().min(1).max(160).nullable().default(null),
    fromAirportId: z.string().min(1).max(160).nullable().default(null),
    toRefId: z.string().min(1).max(160).nullable().default(null),
    toAirportId: z.string().min(1).max(160).nullable().default(null),
    mode: z.enum(["walking", "public_transport", "taxi", "airport_transfer"]),
    adults: z.number().int().min(1).max(6),
  })
  .strict()
  .refine(
    (value) =>
      (value.fromRefId !== null) !== (value.fromAirportId !== null) &&
      (value.toRefId !== null) !== (value.toAirportId !== null),
    { message: "exactly one of fromRefId/fromAirportId and one of toRefId/toAirportId is required" },
  );

const contextInput = z
  .object({
    adults: z.number().int().min(1).max(6),
    sightseeingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    travelVariant: z.enum(["one_night", "two_nights"]),
    preferences: tripPreferencesSchema,
    flightOfferId: z.string().min(1).max(160),
    hotelOfferId: z.string().min(1).max(160).nullable().default(null),
    destinationAirportId: z.string().min(1).max(160).nullable().default(null),
    mealSelections: z
      .object({
        breakfast: z.string().min(1).max(160).nullable(),
        lunch: z.string().min(1).max(160).nullable(),
        dinner: z.string().min(1).max(160).nullable(),
      })
      .strict(),
    confirmedMealIds: z.array(z.string().min(1).max(160)).max(3).default([]),
    selfArrangedMeals: z.array(z.enum(["breakfast", "lunch", "dinner"])).max(3).default([]),
    selfArrangedActivities: z.boolean().default(false),
    preferredActivityIds: z.array(z.string().min(1).max(160)).max(20).default([]),
    dinnerExcludedReason: z.string().max(400).nullable().default(null),
  })
  .strict();

const validateInput = z
  .object({
    delegationId: z.string().uuid(),
    snapshotId: z.string().uuid(),
    context: contextInput,
    stops: z
      .array(
        z
          .object({
            kind: z.enum(["meal", "activity", "free_time", "break", "transfer"]),
            refId: z.string().min(1).max(160).nullable(),
            startMinute: z.number().int().min(0).max(1439),
            durationMinutes: z.number().int().min(5).max(600),
          })
          .strict(),
      )
      .max(40)
      .default([]),
  })
  .strict();

const costInput = z
  .object({
    delegationId: z.string().uuid(),
    snapshotId: z.string().uuid(),
    context: contextInput,
  })
  .strict();

export function registerItineraryTools(
  server: McpServer,
  context: McpHostContext,
  identity: string,
): void {
  server.registerTool(
    "estimate_travel_time",
    {
      title: "Estimate travel time",
      description: "Deterministic routed travel time between two snapshot/reference anchors.",
      inputSchema: travelTimeInput,
    },
    createToolHandler(context, "itineraryTools", "estimate_travel_time", async (input) => {
      await context.authorize({
        identity,
        endpoint: "itineraryTools",
        delegationId: input.delegationId,
        snapshotId: input.snapshotId,
        needItinerary: true,
      });
      return context.itineraryTools.estimateTravelTime({
        snapshotId: input.snapshotId,
        from: {
          ...(input.fromRefId ? { refId: input.fromRefId } : {}),
          ...(input.fromAirportId ? { airportId: input.fromAirportId } : {}),
        },
        to: {
          ...(input.toRefId ? { refId: input.toRefId } : {}),
          ...(input.toAirportId ? { airportId: input.toAirportId } : {}),
        },
        mode: input.mode,
        adults: input.adults,
      });
    }),
  );

  server.registerTool(
    "validate_itinerary",
    {
      title: "Validate itinerary",
      description:
        "Deterministic assembly/validation of a proposed day: schedule conflicts, pace findings, metrics and costs.",
      inputSchema: validateInput,
    },
    createToolHandler(context, "itineraryTools", "validate_itinerary", async (input) => {
      await context.authorize({
        identity,
        endpoint: "itineraryTools",
        delegationId: input.delegationId,
        snapshotId: input.snapshotId,
        needItinerary: true,
      });
      return context.itineraryTools.validateProposal({
        scope: { snapshotId: input.snapshotId },
        context: input.context,
        stops: input.stops,
      });
    }),
  );

  server.registerTool(
    "calculate_trip_cost",
    {
      title: "Calculate trip cost",
      description: "Deterministic party cost of the selected flight/hotel/meals/activities.",
      inputSchema: costInput,
    },
    createToolHandler(context, "itineraryTools", "calculate_trip_cost", async (input) => {
      await context.authorize({
        identity,
        endpoint: "itineraryTools",
        delegationId: input.delegationId,
        snapshotId: input.snapshotId,
        needItinerary: true,
      });
      return context.itineraryTools.calculateTripCost({
        scope: { snapshotId: input.snapshotId },
        context: input.context,
      });
    }),
  );
}
