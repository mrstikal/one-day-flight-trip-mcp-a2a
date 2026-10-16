import { z } from "zod";
import {
  activityPaceSchema,
  activityTagSchema,
  bookableKeySchema,
  preservableKeySchema,
  serviceKeySchema,
  serviceLevelSchema,
  simulationModeSchema,
  travelVariantSchema,
} from "./enums.js";
import {
  geographicRefIdSchema,
  localDateSchema,
  moneyMinorSchema,
  nonEmptyStringSchema,
} from "./primitives.js";
import { interestsSchema, mealSelectionsSchema, refineProgramSelection, selfArrangedMealsSchema } from "./preferences.js";

/** The exhaustive initial command family (04-domain-model.md section 6). */

const uniqueTags = z
  .array(activityTagSchema)
  .max(8)
  .refine((tags) => new Set(tags).size === tags.length, "preferred tags must be unique");

const setRoute = z
  .object({
    type: z.literal("set_route"),
    originAirportId: geographicRefIdSchema.optional(),
    destinationCityId: geographicRefIdSchema.optional(),
    sightseeingDate: localDateSchema.optional(),
    travelVariant: travelVariantSchema.optional(),
  })
  .strict();

/**
 * Conversational command members, shared by the full union and the model-facing
 * subset so the two lists cannot drift apart.
 */
const conversationalMembers = [
  setRoute,
  z.object({ type: z.literal("set_default_service_level"), level: serviceLevelSchema }).strict(),
  z
    .object({
      type: z.literal("set_service_override"),
      service: serviceKeySchema,
      level: serviceLevelSchema.nullable(),
    })
    .strict(),
  z.object({ type: z.literal("set_activity_pace"), pace: activityPaceSchema }).strict(),
  z
    .object({
      type: z.literal("set_interests"),
      interests: interestsSchema,
      preferredTags: uniqueTags,
    })
    .strict(),
  z
    .object({
      type: z.literal("set_activity_requirement"),
      tag: activityTagSchema,
      minimumCount: z.number().int().min(1).max(7).nullable(),
    })
    .strict(),
  z.object({ type: z.literal("set_budget"), maxBudgetMinor: moneyMinorSchema.nullable() }).strict(),
  z
    .object({
      type: z.literal("find_alternatives"),
      target: z.union([serviceKeySchema, z.literal("activities")]),
      objective: z.enum(["cheaper", "better_location", "higher_rating", "match_preferences"]),
      level: serviceLevelSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("propose_selection"),
      service: bookableKeySchema,
      offerId: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("set_program"),
      mealOfferIds: mealSelectionsSchema,
      selfArrangedMeals: selfArrangedMealsSchema,
      preferredActivityIds: z.array(nonEmptyStringSchema).max(20),
      activitiesSelfArranged: z.boolean().default(false),
    })
    .strict()
    .superRefine(refineProgramSelection),
  z.object({ type: z.literal("build_itinerary") }).strict(),
  z.object({ type: z.literal("retry_failed_domains") }).strict(),
] as const;

const setSimulation = z.object({ type: z.literal("set_simulation"), mode: simulationModeSchema }).strict();

export const domainCommandSchema = z.discriminatedUnion("type", [
  ...conversationalMembers,
  setSimulation,
]);

export type DomainCommand = z.infer<typeof domainCommandSchema>;

/** Commands acceptable from model/chat output (excludes the protected inspector command). */
export const modelFacingCommandSchema = z.discriminatedUnion("type", [...conversationalMembers]);
export type ModelFacingCommand = z.infer<typeof modelFacingCommandSchema>;

/** `set_route` must change at least one route field. */
export function isNoOpSetRoute(command: DomainCommand): boolean {
  return (
    command.type === "set_route" &&
    command.originAirportId === undefined &&
    command.destinationCityId === undefined &&
    command.sightseeingDate === undefined &&
    command.travelVariant === undefined
  );
}

export const intentResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("commands"),
      commands: z.array(domainCommandSchema).max(4),
      preserve: z.array(preservableKeySchema),
      interpretation: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("clarification"),
      question: nonEmptyStringSchema,
      requestedCommands: z.array(domainCommandSchema).max(4),
      preserve: z.array(preservableKeySchema),
      options: z
        .array(
          z
            .object({
              id: nonEmptyStringSchema,
              label: nonEmptyStringSchema,
              commands: z.array(domainCommandSchema).max(4),
            })
            .strict(),
        )
        .min(2)
        .max(4),
    })
    .strict(),
  z.object({ kind: z.literal("unsupported"), explanation: nonEmptyStringSchema }).strict(),
]);

export type IntentResult = z.infer<typeof intentResultSchema>;

/**
 * Model-facing intent result: identical shape to `IntentResult` but restricted to
 * the conversational command subset, so `set_simulation` cannot be smuggled into
 * a chat result (04-domain-model.md section 6 / 10-security section 6).
 */
export const modelFacingIntentResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("commands"),
      commands: z.array(modelFacingCommandSchema).max(4),
      preserve: z.array(preservableKeySchema),
      interpretation: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("clarification"),
      question: nonEmptyStringSchema,
      requestedCommands: z.array(modelFacingCommandSchema).max(4),
      preserve: z.array(preservableKeySchema),
      options: z
        .array(
          z
            .object({
              id: nonEmptyStringSchema,
              label: nonEmptyStringSchema,
              commands: z.array(modelFacingCommandSchema).max(4),
            })
            .strict(),
        )
        .min(2)
        .max(4),
    })
    .strict(),
  z.object({ kind: z.literal("unsupported"), explanation: nonEmptyStringSchema }).strict(),
]);
export type ModelFacingIntentResult = z.infer<typeof modelFacingIntentResultSchema>;
