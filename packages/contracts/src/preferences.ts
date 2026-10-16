import { z } from "zod";
import {
  activityPaceSchema,
  activityTagSchema,
  mealSchema,
  serviceKeySchema,
  serviceLevelSchema,
  travelVariantSchema,
  type Meal,
} from "./enums.js";
import { moneyMinorSchema, nonEmptyStringSchema } from "./primitives.js";

/** Trip preferences and meal selections (04-domain-model.md section 2). */

/**
 * Phase 11: the operation-scoped search intent of a `find_alternatives` request.
 * An explicit `level` searches that category without changing preferences, and
 * `cheaper` preserves the selected/confirmed offer's category even when the
 * global effective preference has since changed.
 */
export const researchSearchIntentSchema = z
  .object({
    target: z.union([serviceKeySchema, z.literal("activities")]),
    objective: z.enum(["cheaper", "better_location", "higher_rating", "match_preferences"]),
    level: serviceLevelSchema.nullable(),
  })
  .strict();
export type ResearchSearchIntent = z.infer<typeof researchSearchIntentSchema>;

/**
 * A targeted assistant search objective (Phase 11). The neutral
 * `match_preferences` refresh is excluded: it reproduces the plain ranking.
 */
export const customSearchObjectiveSchema = z.enum(["cheaper", "better_location", "higher_rating"]);
export type CustomSearchObjective = z.infer<typeof customSearchObjectiveSchema>;

export const interestsSchema = z
  .object({
    culture: z.number().int().min(0).max(5),
    relaxation: z.number().int().min(0).max(5),
    entertainment: z.number().int().min(0).max(5),
  })
  .strict()
  .refine(
    (value) => value.culture + value.relaxation + value.entertainment > 0,
    "at least one interest must be positive",
  );

const optionalLevel = serviceLevelSchema.optional();
const optionalCount = z.number().int().min(1).max(7).optional();

export const serviceOverridesSchema = z
  .object({
    hotel: optionalLevel,
    breakfast: optionalLevel,
    lunch: optionalLevel,
    dinner: optionalLevel,
  })
  .strict();

export const minimumActivityCountsSchema = z
  .object({
    museum: optionalCount,
    landmark: optionalCount,
    gallery: optionalCount,
    architecture: optionalCount,
    park: optionalCount,
    garden: optionalCount,
    waterfront: optionalCount,
    viewpoint: optionalCount,
    performance: optionalCount,
  })
  .strict();

export const tripPreferencesSchema = z
  .object({
    travelVariant: travelVariantSchema,
    defaultServiceLevel: serviceLevelSchema,
    serviceOverrides: serviceOverridesSchema,
    activityPace: activityPaceSchema,
    interests: interestsSchema,
    preferredActivityTags: z
      .array(activityTagSchema)
      .max(8)
      .refine((tags) => new Set(tags).size === tags.length, "preferred tags must be unique"),
    minimumActivityCounts: minimumActivityCountsSchema,
    maxBudgetMinor: moneyMinorSchema.optional(),
  })
  .strict();

export type TripPreferences = z.infer<typeof tripPreferencesSchema>;

/**
 * Meal choices of one program. A `null` meal is never a plain "not chosen":
 * breakfast/lunch must be listed in `selfArrangedMeals` ("I'll arrange it
 * myself"), and a null dinner is either self-arranged or the deterministic
 * no-slot result the server verifies separately.
 */
export const mealSelectionsSchema = z
  .object({
    breakfast: nonEmptyStringSchema.nullable(),
    lunch: nonEmptyStringSchema.nullable(),
    dinner: z.union([nonEmptyStringSchema, z.null()]),
  })
  .strict();

export type MealSelections = z.infer<typeof mealSelectionsSchema>;

/** Meals the traveler arranges themselves; they are never planned or offered. */
export const selfArrangedMealsSchema = z
  .array(mealSchema)
  .max(3)
  .refine((meals) => new Set(meals).size === meals.length, "self-arranged meals must be unique")
  .default(() => []);

/** Program activity ids (no booking; preferences only). */
export const preferredActivityIdsSchema = z.array(nonEmptyStringSchema).max(20);

/**
 * Consistency of one program selection: a self-arranged meal never carries an
 * offer id, and breakfast/lunch must be either selected or explicitly
 * self-arranged (a null dinner without the state stays the deterministic
 * no-slot result).
 */
export function refineProgramSelection(
  value: {
    readonly mealOfferIds: MealSelections;
    readonly selfArrangedMeals: readonly Meal[];
  },
  ctx: z.RefinementCtx,
): void {
  const selfArranged = new Set(value.selfArrangedMeals);
  for (const meal of mealSchema.options) {
    if (selfArranged.has(meal) && value.mealOfferIds[meal] !== null) {
      ctx.addIssue({
        code: "custom",
        message: `${meal} cannot be selected and self-arranged at the same time`,
        path: ["selfArrangedMeals"],
      });
    }
  }
  for (const meal of ["breakfast", "lunch"] as const) {
    if (value.mealOfferIds[meal] === null && !selfArranged.has(meal)) {
      ctx.addIssue({
        code: "custom",
        message: `${meal} must either be selected or marked as self-arranged`,
        path: ["mealOfferIds", meal],
      });
    }
  }
}

export const DEFAULT_TRIP_PREFERENCES: TripPreferences = {
  travelVariant: "two_nights",
  defaultServiceLevel: "standard",
  serviceOverrides: {},
  activityPace: "moderate",
  interests: { culture: 3, relaxation: 2, entertainment: 1 },
  preferredActivityTags: [],
  minimumActivityCounts: {},
};

export const DEFAULT_ADULTS = 1;
