import { z } from "zod";
import { mealSchema } from "./enums.js";
import {
  localDateSchema,
  nonEmptyStringSchema,
  uuidSchema,
} from "./primitives.js";
import {
  mealSelectionsSchema,
  selfArrangedMealsSchema,
  tripPreferencesSchema,
} from "./preferences.js";

/**
 * Phase 08 itinerary task contracts (ODTF_PLAN.md §3.11).
 *
 * The coordinator supplies the already compact planner context and the exact
 * deterministic tool context; the City Guide agent never reads trip tables.
 * Both are strict so a malformed request fails as INVALID_ARTIFACT instead of
 * reaching the planner with missing anchors.
 */

/** MCP Itinerary Tools context: the exact persisted inputs of the proposal. */
export const itineraryToolContextSchema = z
  .object({
    adults: z.number().int().min(1).max(6),
    sightseeingDate: localDateSchema,
    travelVariant: z.enum(["one_night", "two_nights"]),
    preferences: tripPreferencesSchema,
    flightOfferId: nonEmptyStringSchema,
    hotelOfferId: nonEmptyStringSchema.nullable().default(null),
    destinationAirportId: nonEmptyStringSchema.nullable().default(null),
    mealSelections: mealSelectionsSchema,
    confirmedMealIds: z.array(nonEmptyStringSchema).max(3).default([]),
    selfArrangedMeals: selfArrangedMealsSchema,
    selfArrangedActivities: z.boolean().default(false),
    preferredActivityIds: z.array(nonEmptyStringSchema).max(20).default([]),
    dinnerExcludedReason: z.string().max(400).nullable().default(null),
  })
  .strict();
export type ItineraryToolContext = z.infer<typeof itineraryToolContextSchema>;

/**
 * Compact query context of `itinerary.propose.v1`. `plannerContext` is the
 * existing planner role context (validated by the agent against the AI role
 * schema); `toolContext` is the deterministic MCP preflight context.
 */
export const itineraryTaskContextSchema = z
  .object({
    attempt: z.number().int().min(1).max(3),
    feedback: z.array(z.string().min(1).max(300)).max(10).default([]),
    plannerContext: z.record(z.string(), z.unknown()),
    toolContext: itineraryToolContextSchema,
    zone: nonEmptyStringSchema,
    /** Minutes since midnight of the sightseeing date; a next-day return can exceed 1439. */
    departureMinuteRaw: z.number().int().min(0).max(2879),
    selectedMealIds: mealSelectionsSchema,
    confirmedMealIds: z.array(nonEmptyStringSchema).max(3).default([]),
    selfArrangedMeals: selfArrangedMealsSchema,
    selfArrangedActivities: z.boolean(),
    preferredActivityIds: z.array(nonEmptyStringSchema).max(20),
    flightOfferId: nonEmptyStringSchema,
    hotelOfferId: nonEmptyStringSchema.nullable(),
    destinationAirportId: nonEmptyStringSchema.nullable(),
    dinnerExcludedReason: z.string().max(400).nullable(),
  })
  .strict();
export type ItineraryTaskContext = z.infer<typeof itineraryTaskContextSchema>;

/** One delegation/tool stop (shared shape of the proposal and MCP preflight). */
export const itineraryStopSchema = z
  .object({
    kind: z.enum(["meal", "activity", "free_time", "break", "transfer"]),
    refId: nonEmptyStringSchema.nullable(),
    startMinute: z.number().int().min(0).max(1439),
    durationMinutes: z.number().int().min(5).max(600),
  })
  .strict();
export type ItineraryStop = z.infer<typeof itineraryStopSchema>;

/** Meal refs of one proposal: a null ref means the meal is not planned. */
export const itineraryMealRefsSchema = z.record(
  mealSchema,
  nonEmptyStringSchema.nullable(),
);
export type ItineraryMealRefs = z.infer<typeof itineraryMealRefsSchema>;

/** Snapshot metadata the itinerary task must echo (safe discovery facts). */
export const itinerarySnapshotMetadataSchema = z
  .object({
    delegationId: uuidSchema,
    snapshotId: uuidSchema,
    scenarioKey: nonEmptyStringSchema,
    domainFingerprints: z.record(z.string(), z.string()).default({}),
  })
  .strict();
export type ItinerarySnapshotMetadata = z.infer<typeof itinerarySnapshotMetadataSchema>;
