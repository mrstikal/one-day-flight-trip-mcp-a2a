import { z } from "zod";
import {
  activityPaceSchema,
  activityTagSchema,
  mealSchema,
  nonEmptyStringSchema,
  serviceLevelSchema,
  tripPreferencesSchema,
  moneyMinorSchema,
} from "@odft/contracts";

/**
 * Strict role contexts for recommendation/planner/reviewer
 * (06-ai-agent-design.md section 2). Configured and contract-tested in Phase 08;
 * called by the graph in later phases.
 */

const candidateSchema = z
  .object({
    offerId: nonEmptyStringSchema,
    partyTotalMinor: moneyMinorSchema,
    level: serviceLevelSchema.optional(),
    rating: z.number().min(0).max(10).optional(),
    centerDistanceKm: z.number().min(0).optional(),
    tags: z.array(activityTagSchema).max(9).optional(),
  })
  .strict();

export const recommendationContextSchema = z
  .object({
    role: z.literal("recommendation"),
    tradeoff: nonEmptyStringSchema,
    target: z.enum(["hotel", "breakfast", "lunch", "dinner", "activities"]),
    baselineOfferId: nonEmptyStringSchema.nullable(),
    candidates: z.array(candidateSchema).min(1).max(20),
  })
  .strict();
export type RecommendationContext = z.infer<typeof recommendationContextSchema>;

const fixedWindowSchema = z
  .object({
    kind: z.enum(["airport", "meal", "reservation", "transfer"]),
    refId: nonEmptyStringSchema,
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(0).max(1439),
  })
  .strict();

const plannerCandidateSchema = z
  .object({
    id: nonEmptyStringSchema,
    kind: z.enum(["meal", "activity"]),
    /** Meal identity for meal candidates (breakfast/lunch/dinner). */
    meal: mealSchema.optional(),
    tags: z.array(activityTagSchema).max(9),
    durationMinutes: z.number().int().min(5).max(180),
    openingStartMinute: z.number().int().min(0).max(1439).optional(),
    openingEndMinute: z.number().int().min(0).max(1439).optional(),
  })
  .strict();

export const plannerContextSchema = z
  .object({
    role: z.literal("planner"),
    sightseeingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    destinationCityId: nonEmptyStringSchema,
    pace: activityPaceSchema,
    interests: tripPreferencesSchema.shape.interests,
    minimumActivityCounts: tripPreferencesSchema.shape.minimumActivityCounts,
    /**
     * Explicitly pinned activity IDs (2026-10-14): visits are OPT-IN — the
     * planner plans exactly these plus whatever satisfies the tag minimums and
     * never adds any other visit.
     */
    preferredActivityIds: z.array(nonEmptyStringSchema).max(30).default(() => []),
    budgetMinor: moneyMinorSchema.nullable(),
    fixedWindows: z.array(fixedWindowSchema).max(24),
    candidates: z.array(plannerCandidateSchema).max(60),
    validationFeedback: z.array(z.string().min(1).max(300)).max(10),
  })
  .strict();
export type PlannerContext = z.infer<typeof plannerContextSchema>;

const reviewerEventSchema = z
  .object({
    id: nonEmptyStringSchema,
    kind: z.enum(["meal", "activity", "break", "transfer", "airport_buffer", "free_time"]),
    title: nonEmptyStringSchema.max(200),
    refId: nonEmptyStringSchema.nullable(),
    tags: z.array(activityTagSchema).max(9),
    startMinute: z.number().int().min(0).max(1439),
    durationMinutes: z.number().int().min(0).max(1440),
    locked: z.boolean().default(false),
    /** Resolved stop coordinates (meal/activity events) for sequence review. */
    location: z
      .object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })
      .strict()
      .nullable(),
  })
  .strict();

export const reviewerContextSchema = z
  .object({
    role: z.literal("reviewer"),
    events: z.array(reviewerEventSchema).max(24),
    metrics: z
      .object({
        totalWalkingMinutes: z.number().min(0),
        totalTransferMinutes: z.number().min(0),
        activityCount: z.number().int().min(0),
        museumCount: z.number().int().min(0),
      })
      .strict(),
    preferences: tripPreferencesSchema,
    preferredActivityIds: z
      .array(nonEmptyStringSchema)
      .max(30)
      .default(() => []),
    activitiesSelfArranged: z.boolean().default(false),
    selfArrangedMeals: z
      .array(mealSchema)
      .max(3)
      .default(() => []),
    requirements: z
      .array(z.object({ tag: activityTagSchema, minimumCount: z.number().int().min(1).max(7) }).strict())
      .max(8),
  })
  .strict();
export type ReviewerContext = z.infer<typeof reviewerContextSchema>;
