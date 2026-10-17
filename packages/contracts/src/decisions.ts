import { z } from "zod";
import { decisionKindSchema, engineSchema, type DecisionKind } from "./enums.js";
import { fingerprintSchema, nonEmptyStringSchema, uuidSchema } from "./primitives.js";
import { mealSelectionsSchema, refineProgramSelection, selfArrangedMealsSchema } from "./preferences.js";

/** Decision responses and resume envelopes (04-domain-model.md section 7). */

const chooseOffer = z
  .object({ action: z.literal("choose_offer"), offerId: nonEmptyStringSchema })
  .strict();
const confirmBooking = z
  .object({
    action: z.literal("confirm_booking"),
    proposalId: uuidSchema,
    acceptedDemoDisclaimer: z.literal(true),
  })
  .strict();
const rejectProposal = z
  .object({ action: z.literal("reject_proposal"), proposalId: uuidSchema })
  .strict();
/**
 * "I don't want to book": decline the simulated reservation for a staged flight
 * or hotel offer while keeping it as the trip's selection. The plan is built as
 * if the service existed (costs, airport buffer, hotel anchor); only the
 * reservation is skipped, and it can still be booked later.
 */
const declineBooking = z
  .object({ action: z.literal("decline_booking"), proposalId: uuidSchema })
  .strict();
const confirmRouteChange = z
  .object({
    action: z.literal("confirm_route_change"),
    proposalId: uuidSchema,
    affectedReservationIds: z.array(uuidSchema),
  })
  .strict();
const submitProgram = z
  .object({
    action: z.literal("submit_program"),
    mealOfferIds: mealSelectionsSchema,
    selfArrangedMeals: selfArrangedMealsSchema,
    preferredActivityIds: z.array(nonEmptyStringSchema),
    activitiesSelfArranged: z.boolean().default(false),
  })
  .strict()
  .superRefine(refineProgramSelection);
const approveItinerary = z
  .object({ action: z.literal("approve_itinerary"), itineraryId: uuidSchema })
  .strict();
const chooseOption = z
  .object({ action: z.literal("choose_option"), optionId: nonEmptyStringSchema })
  .strict();
const modify = z
  .object({ action: z.literal("modify"), commandOperationId: uuidSchema })
  .strict();

const publicMembers = [
  chooseOffer,
  confirmBooking,
  rejectProposal,
  declineBooking,
  confirmRouteChange,
  submitProgram,
  approveItinerary,
  chooseOption,
] as const;

/** Exactly the public decision union; the internal `modify` action is excluded. */
export const publicDecisionResponseSchema = z.discriminatedUnion("action", [...publicMembers]);
export type PublicDecisionResponse = z.infer<typeof publicDecisionResponseSchema>;

/** Worker-only union that additionally carries the internal `modify` action. */
export const internalDecisionResponseSchema = z.discriminatedUnion("action", [
  ...publicMembers,
  modify,
]);
export type InternalDecisionResponse = z.infer<typeof internalDecisionResponseSchema>;

export const graphResumeEnvelopeSchema = z
  .object({
    operationId: uuidSchema,
    acceptedRevision: z.number().int().min(0),
    decisionId: uuidSchema,
    response: internalDecisionResponseSchema,
  })
  .strict();
export type GraphResumeEnvelope = z.infer<typeof graphResumeEnvelopeSchema>;

export const resumeRequestSchema = z
  .object({
    requestId: uuidSchema,
    expectedRevision: z.number().int().min(0),
    decisionId: uuidSchema,
    response: publicDecisionResponseSchema,
  })
  .strict();
export type ResumeRequest = z.infer<typeof resumeRequestSchema>;

export const pendingDecisionStatusSchema = z.enum(["pending", "resolved", "cancelled"]);

export const pendingDecisionBaseSchema = z
  .object({
    id: uuidSchema,
    kind: decisionKindSchema,
    /**
     * Phase 03 engine binding: graph decisions keep their checkpoint fields;
     * coordinator decisions bind their run instead and must not invent graph
     * ids (validated below, persisted by migration 0013).
     */
    engine: engineSchema.default("langgraph"),
    threadId: z.string().min(1).optional(),
    interruptId: z.string().min(1).optional(),
    checkpointId: z.string().min(1).optional(),
    graphVersion: z.string().min(1).optional(),
    coordinatorRunId: uuidSchema.optional(),
    createdRevision: z.number().int().min(0),
    sourceFingerprint: fingerprintSchema,
    proposalId: uuidSchema.optional(),
    allowedOfferIds: z.array(nonEmptyStringSchema),
    allowedOptionIds: z.array(nonEmptyStringSchema),
    payloadHash: fingerprintSchema,
    status: pendingDecisionStatusSchema,
  })
  .strict();

/**
 * The engine-binding-validated pending decision: graph decisions require their
 * checkpoint fields, coordinator decisions require their run and must not carry
 * graph identifiers.
 */
export const pendingDecisionSchema = pendingDecisionBaseSchema.superRefine((decision, context) => {
    if (decision.engine === "langgraph") {
      if (!decision.threadId) {
        context.addIssue({ code: "custom", message: "graph decisions require a threadId" });
      }
      if (!decision.graphVersion) {
        context.addIssue({ code: "custom", message: "graph decisions require a graphVersion" });
      }
      if (decision.coordinatorRunId !== undefined) {
        context.addIssue({ code: "custom", message: "graph decisions cannot bind a coordinator run" });
      }
      return;
    }
    if (!decision.coordinatorRunId) {
      context.addIssue({ code: "custom", message: "coordinator decisions require a coordinatorRunId" });
    }
    if (decision.threadId !== undefined || decision.graphVersion !== undefined) {
      context.addIssue({
        code: "custom",
        message: "coordinator decisions cannot carry graph checkpoint identifiers",
      });
    }
  });
export type PendingDecision = z.infer<typeof pendingDecisionSchema>;

/** Which public actions each decision kind accepts (09-booking-simulation.md section 6). */
export const DECISION_ALLOWED_ACTIONS: Readonly<Record<DecisionKind, readonly string[]>> = {
  flight_choice: ["choose_offer"],
  hotel_choice: ["choose_offer"],
  program_choices: ["submit_program"],
  booking_confirmation: ["confirm_booking", "reject_proposal", "decline_booking"],
  replacement_confirmation: ["confirm_booking", "reject_proposal"],
  route_change_confirmation: ["confirm_route_change"],
  itinerary_approval: ["approve_itinerary"],
  clarification: ["choose_option"],
  recovery: ["choose_option"],
  /** Phase 03: genuine specialist question (plan §3.10). */
  agent_input: ["choose_option"],
};
