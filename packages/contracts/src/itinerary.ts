import { z } from "zod";
import { activityTagSchema, activityPaceSchema, mealSchema, travelVariantSchema } from "./enums.js";
import {
  coordinatesSchema,
  fingerprintSchema,
  instantSchema,
  localDateSchema,
  moneyMinorSchema,
  nonEmptyStringSchema,
  timeZoneSchema,
  uuidSchema,
} from "./primitives.js";

/**
 * Itinerary and validator contracts (04-domain-model.md section 8,
 * 03-langgraph-design.md section 4, Phase 10).
 *
 * An immutable itinerary version contains the date/zone, source fingerprints,
 * selected/booked offer refs, travel variant, pace, the deterministic party cost
 * breakdown, and ordered events. The validator result carries machine-readable
 * errors/warnings, metrics, and a fingerprint. Every field here is server-computed
 * by deterministic code; the client renders it and never derives it.
 */

export const itineraryEventKindSchema = z.enum([
  "meal",
  "activity",
  "break",
  "transfer",
  "airport_buffer",
  "free_time",
]);
export type ItineraryEventKind = z.infer<typeof itineraryEventKindSchema>;

export const itineraryPhysicalDemandSchema = z.enum(["low", "moderate", "high"]);
export type ItineraryPhysicalDemand = z.infer<typeof itineraryPhysicalDemandSchema>;

/**
 * Blocking validator errors (Phase 10 section 4). `invalid_proposal` is the
 * deterministic rejection of a planner output that referenced unknown candidates
 * or an unparsable schema — it is reported through the same taxonomy so the
 * bounded loop and the clarification decision treat it uniformly.
 */
export const itineraryErrorCodeSchema = z.enum([
  "overlap",
  "opening_hours_mismatch",
  "transfer_gap",
  "airport_buffer",
  "insufficient_sightseeing",
  "missing_required_meal",
  "missing_break",
  "excessive_walking",
  "incompatible_reservation",
  "preference_conflict",
  "budget_exceeded",
  "unmet_minimum_activity_count",
  "invalid_proposal",
]);
export type ItineraryErrorCode = z.infer<typeof itineraryErrorCodeSchema>;

/** Nonblocking warnings; each requires an explicit visible explanation. */
export const itineraryWarningCodeSchema = z.enum([
  "pace_guideline_deviation",
  "preferred_activity_missing",
  "review_suggestion",
]);
export type ItineraryWarningCode = z.infer<typeof itineraryWarningCodeSchema>;

export const itineraryIssueSchema = z
  .object({
    severity: z.enum(["error", "warning"]),
    code: z.union([itineraryErrorCodeSchema, itineraryWarningCodeSchema]),
    message: nonEmptyStringSchema.max(400),
    /** Event ids the issue anchors to (empty for whole-day issues). */
    eventIds: z.array(uuidSchema).max(8),
    /** True when the issue was caused by an explicitly labeled injected fault. */
    simulatedFailure: z.boolean(),
  })
  .strict();
export type ItineraryIssue = z.infer<typeof itineraryIssueSchema>;

export const itineraryEventSchema = z
  .object({
    id: uuidSchema,
    kind: itineraryEventKindSchema,
    title: nonEmptyStringSchema.max(200),
    /** Destination-local date; equals the sightseeing date (no overnight plans). */
    localDate: localDateSchema,
    /** Destination-local minutes of day [0, 1440). */
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(0).max(1440),
    startLocal: z.string().regex(/^\d{2}:\d{2}$/),
    endLocal: z.string().regex(/^\d{2}:\d{2}$/),
    startInstant: instantSchema,
    endInstant: instantSchema,
    zone: timeZoneSchema,
    durationMinutes: z.number().int().min(0).max(1440),
    /** Offer/reference id for meal/activity events (never invented by AI). */
    refId: nonEmptyStringSchema.nullable(),
    /** Resolved activity tags (empty for non-activity events). */
    activityTags: z.array(activityTagSchema).max(9).default(() => []),
    /** Human-readable provenance labels ("Selected breakfast (Standard)"). */
    provenance: z.array(nonEmptyStringSchema.max(200)).min(1).max(6),
    physicalDemand: itineraryPhysicalDemandSchema,
    /** Unique inclusion key for the party cost total; null = nothing to add. */
    costInclusionKey: nonEmptyStringSchema.nullable(),
    costMinor: moneyMinorSchema,
    location: coordinatesSchema.nullable(),
    /** Confirmed reservations and airport windows cannot be moved. */
    locked: z.boolean(),
    lockReason: nonEmptyStringSchema.max(200).nullable(),
    /** Transfer/route estimates are always simulated. */
    simulated: z.boolean(),
  })
  .strict();
export type ItineraryEvent = z.infer<typeof itineraryEventSchema>;

export const itineraryMetricsSchema = z
  .object({
    activityCount: z.number().int().min(0).max(80),
    visitMinutes: z.number().int().min(0).max(1440),
    mealMinutes: z.number().int().min(0).max(1440),
    breakMinutes: z.number().int().min(0).max(1440),
    transferMinutes: z.number().int().min(0).max(1440),
    walkingMinutes: z.number().int().min(0).max(1440),
    walkingKm: z.number().min(0).max(100),
    museumCount: z.number().int().min(0).max(80),
    /** Only tags present in the plan are recorded (partial by design). */
    activityTagCounts: z.partialRecord(activityTagSchema, z.number().int().min(0).max(80)),
    firstContentStartLocal: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
    lastContentEndLocal: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
    totalCostMinor: moneyMinorSchema,
    budgetMinor: moneyMinorSchema.nullable(),
    remainingBudgetMinor: z.number().int().nullable(),
  })
  .strict();
export type ItineraryMetrics = z.infer<typeof itineraryMetricsSchema>;

export const itineraryValidationSchema = z
  .object({
    status: z.enum(["valid", "invalid"]),
    // A 24-stop proposal with inserted transfers/breaks can legitimately exceed
    // the earlier caps, so the bounds cover the assembled worst case.
    errors: z.array(itineraryIssueSchema).max(64),
    warnings: z.array(itineraryIssueSchema).max(64),
    metrics: itineraryMetricsSchema,
    /** Full input+content hash (evidence). */
    fingerprint: fingerprintSchema,
    /** Inputs-only hash re-verified at approval time. */
    sourceFingerprint: fingerprintSchema,
  })
  .strict();
export type ItineraryValidation = z.infer<typeof itineraryValidationSchema>;

/** Reviewer issue enums (06-ai-agent-design.md section 5). */
export const reviewIssueCodeSchema = z.enum([
  "poor_sequence",
  "excess_travel",
  "pace_mismatch",
  "interest_mismatch",
  "insufficient_variety",
  "unexplained_compromise",
]);
export type ReviewIssueCode = z.infer<typeof reviewIssueCodeSchema>;

export const itineraryReviewIssueSchema = z
  .object({
    code: reviewIssueCodeSchema,
    eventIds: z.array(uuidSchema).max(8),
    explanation: nonEmptyStringSchema.max(300),
  })
  .strict();

export const itineraryReviewSchema = z
  .object({
    verdict: z.enum(["acceptable", "revise", "conflict"]),
    issues: z.array(itineraryReviewIssueSchema).max(8),
    suggestedOrder: z.array(nonEmptyStringSchema).max(24),
    explanation: z.string().min(1).max(1000),
    /** True when nonblocking suggestions were demoted to visible warnings. */
    suggestionsAsWarnings: z.boolean(),
  })
  .strict();
export type ItineraryReview = z.infer<typeof itineraryReviewSchema>;

export const itineraryCostItemSchema = z
  .object({
    key: nonEmptyStringSchema,
    label: nonEmptyStringSchema.max(200),
    category: z.enum(["flights", "hotel", "meals", "activities", "transfers"]),
    amountMinor: moneyMinorSchema,
    provenance: z.array(nonEmptyStringSchema.max(200)).min(1).max(6),
  })
  .strict();
export type ItineraryCostItem = z.infer<typeof itineraryCostItemSchema>;

export const itineraryCostsSchema = z
  .object({
    items: z.array(itineraryCostItemSchema).max(64),
    totalMinor: moneyMinorSchema,
    /** True when the dinner slot was excluded by the deterministic no-slot result. */
    dinnerExcluded: z.boolean(),
    dinnerExcludedReason: nonEmptyStringSchema.max(400).nullable(),
    excludedNotes: z.array(nonEmptyStringSchema.max(400)).max(8),
  })
  .strict();
export type ItineraryCosts = z.infer<typeof itineraryCostsSchema>;

export const itineraryStatusSchema = z.enum(["draft", "approved", "superseded"]);
export type ItineraryStatus = z.infer<typeof itineraryStatusSchema>;

/** Persisted immutable itinerary version (read model of `odft_app.itineraries`). */
export const itineraryRecordSchema = z
  .object({
    id: uuidSchema,
    tripId: uuidSchema,
    version: z.number().int().min(1),
    status: itineraryStatusSchema,
    sightseeingDate: localDateSchema,
    zone: timeZoneSchema,
    adults: z.number().int().min(1).max(6),
    pace: activityPaceSchema,
    travelVariant: travelVariantSchema,
    events: z.array(itineraryEventSchema).max(80),
    validation: itineraryValidationSchema,
    costs: itineraryCostsSchema,
    review: itineraryReviewSchema.nullable(),
    simulatedFailure: z.boolean(),
    simulatedFailureNote: z.string().max(400).nullable(),
    createdAt: instantSchema,
  })
  .strict();
export type ItineraryRecord = z.infer<typeof itineraryRecordSchema>;

/** Safe map marker derived server-side (every fact also exists as text). */
export const publicMapMarkerSchema = z
  .object({
    id: nonEmptyStringSchema,
    kind: z.enum(["meal", "activity", "hotel", "airport"]),
    label: nonEmptyStringSchema.max(200),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    approximate: z.boolean(),
    /** Simulated transfer minutes from the previous marker in timeline order. */
    simulatedTransferMinutes: z.number().int().min(0).max(240).nullable(),
  })
  .strict();
export type PublicMapMarker = z.infer<typeof publicMapMarkerSchema>;

/** Public itinerary DTO: no internal fingerprints, no provider payloads. */
export const publicItinerarySchema = z
  .object({
    id: uuidSchema,
    version: z.number().int().min(1),
    status: itineraryStatusSchema,
    sightseeingDate: localDateSchema,
    zone: timeZoneSchema,
    adults: z.number().int().min(1).max(6),
    pace: activityPaceSchema,
    travelVariant: travelVariantSchema,
    events: z.array(itineraryEventSchema).max(80),
    validation: z
      .object({
        status: z.enum(["valid", "invalid"]),
        errors: z.array(itineraryIssueSchema).max(64),
        warnings: z.array(itineraryIssueSchema).max(64),
        metrics: itineraryMetricsSchema,
      })
      .strict(),
    review: itineraryReviewSchema.nullable(),
    costs: itineraryCostsSchema,
    simulatedFailure: z.boolean(),
    simulatedFailureNote: z.string().max(400).nullable(),
    /**
     * Current "I'll arrange it myself" program state, displayed on the itinerary
     * page: these meals/activities are intentionally not part of the plan.
     */
    selfArranged: z
      .object({
        meals: z.array(mealSchema),
        activities: z.boolean(),
      })
      .strict(),
    /** Latest approved version of this trip (badge context for a newer draft). */
    approvedVersion: z.number().int().min(1).nullable(),
    markers: z.array(publicMapMarkerSchema).max(80),
  })
  .strict();
export type PublicItinerary = z.infer<typeof publicItinerarySchema>;
