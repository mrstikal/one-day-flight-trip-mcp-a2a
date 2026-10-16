import { z } from "zod";
import { errorEnvelopeSchema } from "./errors.js";
import { pendingDecisionSchema, resumeRequestSchema } from "./decisions.js";
import { operationStatusSchema } from "./enums.js";
import { uuidSchema, nonEmptyStringSchema } from "./primitives.js";
import { tripSummarySchema } from "./operations.js";
import {
  flightGatingSchema,
  publicHotelOfferSchema,
  publicMealOfferSchema,
  publicProgramChoicesSchema,
  publicProposalSchema,
  publicResearchStateSchema,
  publicReservationSchema,
  publicRouteChangePreviewSchema,
  publicServiceLevelsSchema,
  tripDisplaySchema,
} from "./projection.js";
import { publicInspectorSchema } from "./inspector.js";
import { publicClarificationSchema, publicConversationMessageSchema } from "./ai.js";
import { publicItinerarySchema } from "./itinerary.js";
import { customSearchObjectiveSchema } from "./preferences.js";
import {
  admissionAcceptedSchema,
  commandRequestSchema,
  creationInputSchema,
} from "./operations.js";

/** API request/response envelopes shared by the BFF and future handlers. */

/**
 * Live activity visit-time budget for the activities step (08 section 7):
 * computed server-side against the pace cap so the UI can warn and disable Save
 * without deriving pace feasibility itself.
 */
export const activityFitResponseSchema = z
  .object({
    fits: z.boolean(),
    selectedCount: z.number().int().nonnegative(),
    selectedMinutes: z.number().int().nonnegative(),
    capMinutes: z.number().int().positive(),
    overMinutes: z.number().int().nonnegative(),
    targetMin: z.number().int().positive(),
    targetMax: z.number().int().positive(),
  })
  .strict();
export type ActivityFitResponse = z.infer<typeof activityFitResponseSchema>;

export const createTripRequestSchema = creationInputSchema;
export type CreateTripRequest = z.infer<typeof createTripRequestSchema>;

export const commandApiRequestSchema = commandRequestSchema;
export type CommandApiRequest = z.infer<typeof commandApiRequestSchema>;

export const admissionResponseSchema = z.union([admissionAcceptedSchema, errorEnvelopeSchema]);
export type AdmissionResponse = z.infer<typeof admissionResponseSchema>;

export const createTripResponseSchema = z.union([
  z
    .object({
      tripId: z.string().uuid(),
      operationId: z.string().uuid(),
      revision: z.literal(1),
    })
    .strict(),
  errorEnvelopeSchema,
]);
export type CreateTripResponse = z.infer<typeof createTripResponseSchema>;

/* ---- Phase 05 BFF contracts ------------------------------------------------- */

export const sessionResponseSchema = z
  .object({
    sessionId: uuidSchema,
    expiresAt: z.string().min(1),
    csrfToken: z.string().min(1),
  })
  .strict();
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/** Resume request accepted by the BFF; the server may generate the requestId. */
export const resumeApiRequestSchema = resumeRequestSchema.extend({
  requestId: uuidSchema.optional(),
});
export type ResumeApiRequest = z.infer<typeof resumeApiRequestSchema>;

export const technicalRetryApiRequestSchema = z
  .object({
    controlRequestId: uuidSchema.optional(),
    expectedRevision: z.number().int().min(0),
  })
  .strict();
export type TechnicalRetryApiRequest = z.infer<typeof technicalRetryApiRequestSchema>;

/** Public pending-decision projection: never includes internal hashes/fingerprints. */
export const publicPendingDecisionSchema = pendingDecisionSchema
  .pick({
    id: true,
    kind: true,
    createdRevision: true,
    allowedOfferIds: true,
    allowedOptionIds: true,
    status: true,
  })
  .extend({
    checkpointId: z.string().min(1).optional(),
    proposalId: uuidSchema.optional(),
  })
  .strict();
export type PublicPendingDecision = z.infer<typeof publicPendingDecisionSchema>;

export const operationStatusResponseSchema = z
  .object({
    operationId: uuidSchema,
    status: operationStatusSchema,
    acceptedRevision: z.number().int().min(0),
    attempts: z.number().int().min(0),
    result: z.unknown().optional(),
    progress: z
      .object({
        stage: z.enum(["program_saved", "planning_itinerary", "reviewing_itinerary"]),
        programSaved: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type OperationStatusResponse = z.infer<typeof operationStatusResponseSchema>;

export const tripProjectionSchema = z
  .object({
    trip: tripSummarySchema,
    operations: z.array(operationStatusResponseSchema),
    pendingDecision: publicPendingDecisionSchema.nullable(),
    flights: flightGatingSchema,
    /**
     * Selected-but-not-booked flight/hotel (Phase 12): "I don't want to book"
     * keeps the chosen offer as the trip's selection, so the plan is built as if
     * it existed while the overviews mark it "Not booked" and offer a late
     * booking. `booked` reflects the confirmed reservation.
     */
    selections: z
      .object({
        flights: z
          .object({ offerId: nonEmptyStringSchema.nullable(), booked: z.boolean() })
          .strict(),
        hotel: z
          .object({ offerId: nonEmptyStringSchema.nullable(), booked: z.boolean() })
          .strict(),
      })
      .strict(),
    hotel: z.array(publicHotelOfferSchema),
    meals: z.array(publicMealOfferSchema),
    program: publicProgramChoicesSchema.nullable(),
    serviceLevels: publicServiceLevelsSchema,
    /**
     * Phase 11: the objectives of the assistant searches that produced the
     * current offers per service (null = the plain category ranking).
     */
    searchObjectives: z
      .object({
        hotel: customSearchObjectiveSchema.nullable(),
        breakfast: customSearchObjectiveSchema.nullable(),
        lunch: customSearchObjectiveSchema.nullable(),
        dinner: customSearchObjectiveSchema.nullable(),
      })
      .strict(),
    /** Phase 09: latest per-domain research outcomes (safe, events-derived). */
    research: publicResearchStateSchema.nullable(),
    proposal: publicProposalSchema.nullable(),
    reservation: publicReservationSchema.nullable(),
    reservations: z.array(publicReservationSchema),
    /** Recent persistent conversation for the assistant rail (safe projection). */
    conversation: z.array(publicConversationMessageSchema),
    /** Server-side clarification question/options for the pending decision. */
    clarification: publicClarificationSchema.nullable(),
    /** Phase 10: latest immutable itinerary version (draft or approved). */
    itinerary: publicItinerarySchema.nullable(),
    /** Phase 11: server-built impact preview of a pending route change. */
    routeChange: publicRouteChangePreviewSchema.nullable(),
    /** Phase 11: safe execution inspector (demo-controls gated; null otherwise). */
    inspector: publicInspectorSchema.nullable(),
    display: tripDisplaySchema,
  })
  .strict();
export type TripProjection = z.infer<typeof tripProjectionSchema>;
