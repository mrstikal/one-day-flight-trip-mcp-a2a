import { z } from "zod";
import { StateSchema } from "@langchain/langgraph";
import {
  clarificationOptionSchema,
  decisionKindSchema,
  domainCommandSchema,
  mealSchema,
  preservableKeySchema,
  publicRouteChangeReservationSchema,
  publicRouteSummarySchema,
  researchDomainSchema,
  researchSearchIntentSchema,
  routeAlternativeSchema,
  routeChangeFieldSchema,
  routeReasonEntrySchema,
  routeValidationSchema,
  scheduleValidationSchema,
  type DecisionKind,
} from "@odft/contracts";
import { researchResultsValue } from "../state/research-reducer.js";

/**
 * Production travel-graph state (Phase 06, 03-langgraph-design.md).
 *
 * Compact references only: the checkpoint carries IDs and typed results, never
 * reference datasets or a second booking database. The domain truth stays in
 * PostgreSQL and is read through the invocation ports.
 */

export const TRAVEL_SCHEMA_VERSION = "travel-state-v6";
export const TRAVEL_GRAPH_VERSION = "travel-graph-v7";

export const travelGateSchema = z.enum([
  "pending",
  "route_rejected",
  "no_schedule",
  "flights_ready",
  "awaiting_booking",
  "booked",
  "hotels_ready",
  "program_ready",
  "withdrawn",
  "logistics_conflict",
  "research_failed",
  "clarification",
  "chat_done",
  "itinerary_ready",
  "itinerary_conflict",
  "approved",
]);
export type TravelGate = z.infer<typeof travelGateSchema>;

export const travelStageSchema = z.enum([
  "flight_decision",
  "stage",
  "commit",
  "decline",
  "program",
  "reselection",
  "clarification_apply",
  "clarification_modify",
  "approve",
  "commit_route",
  "end",
]);
export type TravelStage = z.infer<typeof travelStageSchema>;

/** Decision kinds the production travel graph can present to the user. */
export const travelDecisionKindSchema = z.enum([
  "flight_choice",
  "hotel_choice",
  "program_choices",
  "booking_confirmation",
  "replacement_confirmation",
  "route_change_confirmation",
  "itinerary_approval",
  "recovery",
  "clarification",
]);
export type TravelDecisionKind = z.infer<typeof travelDecisionKindSchema>;

export const travelBookingServiceSchema = z.enum([
  "flights",
  "hotel",
  "breakfast",
  "lunch",
  "dinner",
]);
export type TravelBookingService = z.infer<typeof travelBookingServiceSchema>;

/** The admitted command payload (creation input or a domain command). */
export const travelCommandSchema = z.unknown().default(null);

export const travelStateFields = {
  stateSchemaVersion: z.string().default(TRAVEL_SCHEMA_VERSION),
  graphVersion: z.string().default(TRAVEL_GRAPH_VERSION),
  tripId: z.string().min(1).default(""),
  operationId: z.string().min(1).default(""),
  acceptedRevision: z.number().int().min(0).default(0),
  operationKind: z.enum(["start", "command", "resume"]).default("start"),

  // Admitted input
  commandType: z.string().nullable().default(null),
  commandPayload: z.unknown().default(null),
  tripLoaded: z.boolean().default(false),

  // Stage A
  routeStatus: z.enum(["PENDING", "FEASIBLE", "INFEASIBLE", "UNDETERMINED"]).default("PENDING"),
  routeValidationId: z.string().nullable().default(null),
  routeFingerprint: z.string().nullable().default(null),
  routeReasons: z.array(routeReasonEntrySchema).default(() => []),
  routeAlternatives: z.array(routeAlternativeSchema).default(() => []),

  // Generation
  scenarioKey: z.string().nullable().default(null),
  snapshotId: z.string().nullable().default(null),

  // Stage B
  scheduleValidationId: z.string().nullable().default(null),
  scheduleStatus: z.enum(["PENDING", "VALID", "NO_VALID_OFFERS"]).default("PENDING"),
  validCombinationIds: z.array(z.string().min(1)).default(() => []),

  // Pending decision descriptor
  decisionKind: decisionKindSchema.nullable().default(null),
  nextDecisionKind: travelDecisionKindSchema.nullable().default("flight_choice"),
  decisionFingerprint: z.string().nullable().default(null),
  proposalId: z.string().nullable().default(null),
  allowedOfferIds: z.array(z.string().min(1)).default(() => []),
  allowedOptionIds: z.array(z.string().min(1)).default(() => []),
  /** Service a staged proposal / upcoming confirmation belongs to. */
  bookingService: travelBookingServiceSchema.nullable().default(null),

  // Decision results
  selectedOfferId: z.string().nullable().default(null),
  lastAction: z.string().nullable().default(null),
  lastOfferId: z.string().nullable().default(null),
  lastProposalId: z.string().nullable().default(null),
  lastDecisionId: z.string().nullable().default(null),
  lastOptionId: z.string().nullable().default(null),
  /** True while a staged proposal is a replacement for a confirmed service. */
  pendingReplacement: z.boolean().default(false),
  /**
   * Phase 12: a declined late booking replaced a DIFFERENT offer than the one
   * already kept, so the plan inputs changed and the day must be replanned
   * (written by `decline_booking`, read once by its router).
   */
  declinedSelectionChanged: z.boolean().default(false),
  /**
   * Kind and gate of the decision a `modify` resume interrupted, captured before
   * the operation-local state reset. ONLY an unsupported modification replays it
   * (a supported modification presents its own new decision).
   */
  interruptedDecision: z
    .object({
      decisionKind: decisionKindSchema,
      gate: travelGateSchema,
    })
    .nullable()
    .default(null),
  /**
   * Full descriptor of the interrupted decision, built only when the intent of a
   * modification is unsupported (no command to apply): the run re-presents the
   * exact decision instead of ending without one, which would strand the trip at
   * an incomplete step with nothing for the user to answer.
   */
  restoredDecision: z
    .object({
      decisionKind: decisionKindSchema,
      proposalId: z.string().nullable(),
      allowedOfferIds: z.array(z.string().min(1)),
      allowedOptionIds: z.array(z.string().min(1)),
      gate: travelGateSchema,
      pendingReplacement: z.boolean(),
    })
    .nullable()
    .default(null),
  /** Confirmed-progress flags so a preference change resumes at the right step. */
  hasConfirmedFlight: z.boolean().default(false),
  hasConfirmedHotel: z.boolean().default(false),

  // Booking
  reservationId: z.string().nullable().default(null),
  demoReference: z.string().nullable().default(null),

  // Phase 07: hotel/meal/program research + program choices
  domainsEnsured: z.boolean().default(false),
  researchStatus: z.enum(["pending", "ok", "partial", "failed"]).default("pending"),
  hotelOfferIds: z.array(z.string().min(1)).default(() => []),
  mealOfferIds: z
    .object({
      breakfast: z.array(z.string().min(1)).default(() => []),
      lunch: z.array(z.string().min(1)).default(() => []),
      dinner: z.array(z.string().min(1)).default(() => []),
    })
    .default(() => ({ breakfast: [], lunch: [], dinner: [] })),
  activityIds: z.array(z.string().min(1)).default(() => []),
  programDefaults: z
    .object({
      breakfast: z.string().nullable().default(null),
      lunch: z.string().nullable().default(null),
      dinner: z.string().nullable().default(null),
    })
    .default(() => ({ breakfast: null, lunch: null, dinner: null })),
  dinnerNotIncludedReason: z.string().nullable().default(null),
  submittedMealSelections: z
    .object({
      breakfast: z.string().min(1).nullable(),
      lunch: z.string().min(1).nullable(),
      dinner: z.string().min(1).nullable(),
    })
    .nullable()
    .default(null),
  /** Meals the traveler arranges themselves ("I'll arrange it myself"). */
  submittedSelfArrangedMeals: z.array(mealSchema).default(() => []),
  submittedActivitiesSelfArranged: z.boolean().default(false),
  submittedActivityIds: z.array(z.string().min(1)).default(() => []),
  programApplied: z.boolean().default(false),
  replacementStaged: z.boolean().default(false),
  logisticsStatus: z.enum(["pending", "valid", "conflict"]).default("pending"),
  logisticsReason: z.string().nullable().default(null),

  pendingStage: travelStageSchema.nullable().default(null),
  gate: travelGateSchema.default("pending"),
  lastOutcome: z.string().nullable().default(null),

  // Phase 10: itinerary planning/validation/review/approval
  /** Total `plan_itinerary` executions for the current user operation (max 3). */
  planningAttempt: z.number().int().min(0).max(3).default(0),
  itineraryId: z.string().nullable().default(null),
  itineraryVersion: z.number().int().nullable().default(null),
  itineraryStatus: z.enum(["draft", "approved"]).nullable().default(null),
  itineraryValidationStatus: z.enum(["valid", "invalid"]).nullable().default(null),
  itineraryErrorCodes: z.array(z.string().min(1)).max(32).default(() => []),
  itineraryWarningCodes: z.array(z.string().min(1)).max(32).default(() => []),
  /** Bounded validator/review feedback for the next planning attempt. */
  itineraryFeedback: z.array(z.string().min(1).max(300)).max(10).default(() => []),
  itineraryReviewVerdict: z.enum(["acceptable", "revise", "conflict"]).nullable().default(null),
  itineraryReviewSuggestions: z
    .array(z.string().min(1).max(300))
    .max(8)
    .default(() => []),
  itineraryReviewFingerprint: z.string().nullable().default(null),
  /** True when the deterministic validator reported a budget conflict. */
  itineraryBudgetConflict: z.boolean().default(false),
  /** Plan-derived cost total reported by the clarification (minor units). */
  itineraryTotalCostMinor: z.number().int().min(0).max(100_000_000).default(0),
  /** Recovery options chosen by the itinerary conflict builder (ICT/recovery). */
  recoveryOptionIds: z.array(z.string().min(1)).max(4).default(() => []),

  // Phase 09: parallel research fan-out (Send) with keyed results and retry
  /**
   * Current research-run scope; reducer keys are `<researchRunId>:<domain>`.
   * Empty until `dispatch_research` opens the first scope (the schema must keep
   * an empty default: LangGraph validates applied defaults).
   */
  researchRunId: z.string().default(""),
  /** Domains dispatched in the current run scope (never all six on a refresh). */
  requiredDomains: z.array(researchDomainSchema).default(() => []),
  /** Keyed per-domain results; each task writes only its own key. */
  researchResults: researchResultsValue,
  /** Provider attempts used per domain in this operation (bounded to two). */
  researchAttempts: z.record(z.string(), z.number().int().min(1).max(2)).default(() => ({})),
  /** Research run round within the operation; a retry opens round + 1. */
  researchRound: z.number().int().min(0).max(8).default(0),
  /** Domains whose automatic retry is pending (`join_research` -> dispatch). */
  researchRetryPending: z.boolean().default(false),
  /** Domains that failed this run scope; inputs for the retry dispatch. */
  failedDomains: z.array(researchDomainSchema).default(() => []),
  /** Deterministic research input fingerprint per domain of the last dispatch. */
  researchInputFingerprints: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).default(() => ({})),
  /** Dispatch routing flag: `none` continues directly with retained results. */
  dispatchMode: z.enum(["none", "fanout"]).default("none"),
  /** Necessary domains that stayed unavailable after the bounded retry. */
  researchFailedDomains: z.array(researchDomainSchema).default(() => []),
  /** Safe short reason for the research-failure recovery decision. */
  researchReason: z.string().nullable().default(null),

  // Phase 08: chat intent interpretation and clarification
  chatMessage: z.string().nullable().default(null),
  intentStatus: z
    .enum(["pending", "commands", "clarification", "unsupported", "search_pending"])
    .default("pending"),
  intentInterpretation: z.string().nullable().default(null),
  intentPreserve: z.array(preservableKeySchema).default(() => []),
  clarificationQuestion: z.string().nullable().default(null),
  /** Full server-side options (opaque id, label, validated commands). */
  clarificationOptions: z.array(clarificationOptionSchema).default(() => []),
  clarificationRequestedCommands: z.array(domainCommandSchema).default(() => []),
  /** Internal `modify` reference for a free-text follow-up on a clarification. */
  modificationOperationId: z.string().nullable().default(null),

  // Phase 11: invalidation-matrix dispatch and route-change impact confirmation
  /** The work item the routing layer selected for this run. */
  nextWork: z
    .enum(["none", "route", "research", "progress", "plan", "validate", "summary", "decision"])
    .default("none"),
  /** Targeted research subset for a search (`find_alternatives`) command. */
  searchTargetDomains: z.array(researchDomainSchema).default(() => []),
  /** Operation-scoped search intent (level override / cheaper comparison). */
  searchIntent: researchSearchIntentSchema.nullable().default(null),
  /** Confirmed/selected services read from the domain truth for preservation. */
  confirmedServices: z.array(travelBookingServiceSchema).default(() => []),
  selectedServices: z.array(travelBookingServiceSchema).default(() => []),
  /** The proposal id (`uuid`) a route-change confirmation is bound to. */
  routeChangeProposalId: z.string().nullable().default(null),
  /** Server-built impact preview; carries the deferred command batch. */
  routeChangePreview: z
    .object({
      proposalId: z.string().uuid(),
      commands: z.array(domainCommandSchema).min(1).max(4),
      changedFields: z.array(routeChangeFieldSchema).min(1),
      from: publicRouteSummarySchema,
      to: publicRouteSummarySchema,
      affectedReservations: z.array(publicRouteChangeReservationSchema),
    })
    .strict()
    .nullable()
    .default(null),
  /** Reservation ids the confirmed route change named (exact-set check). */
  lastAffectedReservationIds: z.array(z.string().min(1)).default(() => []),
};

export const travelStateSchema = new StateSchema(travelStateFields);

export type TravelState = typeof travelStateSchema.State;
export type TravelUpdate = typeof travelStateSchema.Update;

/**
 * Operation-local execution state that must restart whenever a NEW operation
 * resumes a checkpoint (a decision response, a pending-decision modification, or
 * a route-change confirmation).
 *
 * LangGraph keeps the previous operation's channel values across a resume, so
 * without this reset a modification would keep `researchStatus: "ok"` and the
 * graph would skip the research dispatch (`routeAfterSchedules` only dispatches
 * while the status is "pending"), presenting stale offers for a freshly
 * persisted preference. The provider-attempt budget and the run scope are
 * per-operation too: retaining `researchAttempts` across independent operations
 * would push the third route change past the task schema's attempt ceiling.
 *
 * Deliberately NOT reset here:
 * - the keyed `researchResults` map (it carries the retained usable results
 *   across operations, pruned by `join_research`, so a selective refresh never
 *   reruns unrelated domains);
 * - the derived offer/activity lists (`hotelOfferIds`/`mealOfferIds`/...): the
 *   hotel-confirmation path reaches `prepare_decision(program_choices)` without
 *   a research round, so it must keep the offers the previous operation ranked
 *   from the SAME snapshot. Every snapshot change (load_context, ensure_domains,
 *   commit_route_change) re-derives or clears them explicitly.
 */
export const OPERATION_LOCAL_RESETS = {
  researchStatus: "pending",
  researchRunId: "",
  researchRound: 0,
  researchAttempts: {},
  researchRetryPending: false,
  failedDomains: [],
  researchInputFingerprints: {},
  dispatchMode: "none",
  requiredDomains: [],
  researchFailedDomains: [],
  researchReason: null,
  nextDecisionKind: "flight_choice",
  searchTargetDomains: [],
  searchIntent: null,
  // A new operation must not inherit a previous run's program submission: the
  // self-arranged state is written explicitly by the admission/routing update.
  submittedSelfArrangedMeals: [],
  submittedActivitiesSelfArranged: false,
} satisfies Partial<TravelUpdate>;

/**
 * Plain start input when a run begins at START (never a `Command({ update })`).
 * The command payload is validated by the persistence admission layer; the graph
 * only forwards it to the ports.
 */
export const travelStartInputSchema = z
  .object({
    tripId: z.string().min(1),
    operationId: z.string().min(1),
    acceptedRevision: z.number().int().min(0),
    operationKind: z.enum(["start", "command"]),
    commandType: z.string().nullable(),
    commandPayload: z.unknown(),
  })
  .strict();
export type TravelStartInput = z.infer<typeof travelStartInputSchema>;

/** Parse a raw route-validation result into the state slice (server-side only). */
export function routeValidationToState(result: z.infer<typeof routeValidationSchema>) {
  if (result.status === "FEASIBLE") {
    return {
      routeStatus: "FEASIBLE" as const,
      routeFingerprint: result.fingerprint,
      routeReasons: result.warnings,
      routeAlternatives: [],
    };
  }
  return {
    routeStatus: result.status,
    routeFingerprint: result.fingerprint,
    routeReasons: result.reasons,
    routeAlternatives: result.alternatives,
  };
}

export function scheduleValidationToState(result: z.infer<typeof scheduleValidationSchema>) {
  return {
    scheduleStatus: result.status,
    validCombinationIds: result.validCombinationIds,
  };
}

export const DECISION_KIND_FOR_STAGE: Readonly<Record<TravelDecisionKind, DecisionKind>> = {
  flight_choice: "flight_choice",
  hotel_choice: "hotel_choice",
  program_choices: "program_choices",
  booking_confirmation: "booking_confirmation",
  replacement_confirmation: "replacement_confirmation",
  route_change_confirmation: "route_change_confirmation",
  itinerary_approval: "itinerary_approval",
  recovery: "recovery",
  clarification: "clarification",
};
