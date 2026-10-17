import { z } from "zod";
import { mealSchema, researchDomainSchema, serviceLevelSchema } from "./enums.js";
import {
  fingerprintSchema,
  instantSchema,
  nonEmptyStringSchema,
  uuidSchema,
} from "./primitives.js";

/**
 * Phase 03: SDK-independent communication and artifact contracts (plan §3.5).
 *
 * These Zod schemas are the canonical application representation of every
 * specialist request/result. Transport adapters (`@odft/protocols`) convert
 * them into A2A parts/artifacts and MCP structured results; SDK objects never
 * reach the browser bundle or the domain package.
 */

export const AGENT_ARTIFACT_SCHEMA_VERSION = 1 as const;

/** Versioned media types carried by A2A artifact parts. */
export const AGENT_ARTIFACT_MEDIA_TYPES = {
  flightRecommendations: "application/vnd.odft.flight-recommendations.v1+json",
  accommodationRecommendations: "application/vnd.odft.accommodation-recommendations.v1+json",
  cityGuideRecommendations: "application/vnd.odft.city-guide-recommendations.v1+json",
  itineraryProposal: "application/vnd.odft.itinerary-proposal.v1+json",
  agentInputRequest: "application/vnd.odft.agent-input-request.v1+json",
} as const;
export type AgentArtifactMediaType =
  (typeof AGENT_ARTIFACT_MEDIA_TYPES)[keyof typeof AGENT_ARTIFACT_MEDIA_TYPES];

export const agentSkillIdSchema = z.enum([
  "flight.recommend.v1",
  "accommodation.recommend.v1",
  "city-guide.research.v1",
  "itinerary.propose.v1",
]);
export type AgentSkillId = z.infer<typeof agentSkillIdSchema>;

/**
 * The authoritative correlation envelope every artifact carries. Business
 * fingerprints describe inputs, never delivery attempts: they must stay
 * independent of task IDs, transport request IDs, timestamps and trace IDs.
 */
export const artifactCorrelationSchema = z
  .object({
    schemaVersion: z.literal(AGENT_ARTIFACT_SCHEMA_VERSION),
    skillId: agentSkillIdSchema,
    tripId: uuidSchema,
    operationId: uuidSchema,
    acceptedRevision: z.number().int().min(0),
    delegationId: uuidSchema,
    traceId: nonEmptyStringSchema,
    snapshotId: uuidSchema,
    scenarioKey: nonEmptyStringSchema,
    inputFingerprint: fingerprintSchema,
    /** Fingerprints of the inputs the artifact was computed from, per domain. */
    domainFingerprints: z.partialRecord(researchDomainSchema, fingerprintSchema),
  })
  .strict();
export type ArtifactCorrelation = z.infer<typeof artifactCorrelationSchema>;

const rankedIdsSchema = z.array(nonEmptyStringSchema).min(1).max(64);

const shortExplanationSchema = z.string().trim().min(1).max(400);

/** Deterministic finding a specialist reports without inventing offers. */
export const artifactFindingSchema = z
  .object({
    code: nonEmptyStringSchema,
    explanation: shortExplanationSchema,
    offerIds: z.array(nonEmptyStringSchema).max(16).default([]),
  })
  .strict();
export type ArtifactFinding = z.infer<typeof artifactFindingSchema>;

export const flightRecommendationsSchema = z
  .object({
    correlation: artifactCorrelationSchema,
    /** Stage-B-valid combination IDs in ranked order (never invented ids). */
    rankedCombinationIds: rankedIdsSchema,
    findings: z.array(artifactFindingSchema).max(16),
    priceFacts: z
      .array(
        z
          .object({
            combinationId: nonEmptyStringSchema,
            partyTotalMinor: z.number().int().min(0),
            currency: z.literal("EUR"),
          })
          .strict(),
      )
      .max(64),
    explanations: z.array(shortExplanationSchema).max(8),
    /** Optional governed reorder note; ranking stays the id order above. */
    reorderNote: shortExplanationSchema.nullable(),
  })
  .strict();
export type FlightRecommendations = z.infer<typeof flightRecommendationsSchema>;

export const accommodationRecommendationsSchema = z
  .object({
    correlation: artifactCorrelationSchema,
    rankedHotelOfferIds: rankedIdsSchema,
    effectiveLevel: serviceLevelSchema,
    searchObjective: z.enum(["preserve_level", "cheaper"]),
    findings: z.array(artifactFindingSchema).max(16),
    comparisons: z
      .array(
        z
          .object({
            hotelOfferId: nonEmptyStringSchema,
            partyTotalMinor: z.number().int().min(0),
            distanceKm: z.number().min(0).max(1000),
            note: shortExplanationSchema,
          })
          .strict(),
      )
      .max(64),
    explanations: z.array(shortExplanationSchema).max(8),
  })
  .strict();
export type AccommodationRecommendations = z.infer<typeof accommodationRecommendationsSchema>;

export const cityGuideDomainOutcomeSchema = z
  .object({
    domain: researchDomainSchema,
    status: z.enum(["ok", "unavailable", "retryable_error", "unsupported"]),
    /** Ranked existing restaurant/activity/event IDs for a successful domain. */
    rankedOfferIds: z.array(nonEmptyStringSchema).max(64),
    inputFingerprint: fingerprintSchema.nullable(),
    reason: shortExplanationSchema.nullable(),
    simulatedFailure: z.boolean(),
  })
  .strict();
export type CityGuideDomainOutcome = z.infer<typeof cityGuideDomainOutcomeSchema>;

export const cityGuideRecommendationsSchema = z
  .object({
    correlation: artifactCorrelationSchema,
    outcomes: z.array(cityGuideDomainOutcomeSchema).min(1).max(6),
    findings: z.array(artifactFindingSchema).max(16),
  })
  .strict();
export type CityGuideRecommendations = z.infer<typeof cityGuideRecommendationsSchema>;

/** Existing planner-compatible proposal (opaque to the transport adapter). */
export const itineraryProposalSchema = z
  .object({
    correlation: artifactCorrelationSchema,
    attempt: z.number().int().min(1).max(3),
    /** Existing candidate IDs only; validated locally before persistence. */
    candidateIds: z.array(nonEmptyStringSchema).max(60),
    stops: z
      .array(
        z
          .object({
            kind: z.enum(["meal", "activity", "free_time", "break", "transfer"]),
            refId: nonEmptyStringSchema.nullable(),
            startMinute: z.number().int().min(0).max(1439),
            durationMinutes: z.number().int().min(5).max(600),
          })
          .strict(),
      )
      .max(40),
    mealRefs: z.record(mealSchema, nonEmptyStringSchema.nullable()),
    review: z
      .object({
        verdict: z.enum(["acceptable", "revise", "conflict"]),
        issueCount: z.number().int().min(0),
        findings: z.array(artifactFindingSchema).max(16),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ItineraryProposal = z.infer<typeof itineraryProposalSchema>;

/**
 * Genuine specialist input request (plan §3.10): stable IDs, finite options,
 * persisted expiry. `choose_option` is the only public answer action.
 */
export const agentInputRequestSchema = z
  .object({
    correlation: artifactCorrelationSchema,
    /** Stable across retries of the same question. */
    requestId: nonEmptyStringSchema,
    /** Exact task/context binding so a continuation cannot be misrouted. */
    taskId: nonEmptyStringSchema,
    contextId: nonEmptyStringSchema,
    /** Authority/input generation this question belongs to. */
    inputGeneration: z.number().int().min(1),
    reason: nonEmptyStringSchema,
    question: z.string().trim().min(1).max(400),
    options: z
      .array(
        z
          .object({ id: nonEmptyStringSchema, label: z.string().trim().min(1).max(120) })
          .strict(),
      )
      .min(2)
      .max(4),
    expiresAt: instantSchema,
    requestHash: fingerprintSchema,
  })
  .strict();
export type AgentInputRequest = z.infer<typeof agentInputRequestSchema>;

export const agentArtifactSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("flight_recommendations"), value: flightRecommendationsSchema }).strict(),
  z
    .object({ kind: z.literal("accommodation_recommendations"), value: accommodationRecommendationsSchema })
    .strict(),
  z
    .object({ kind: z.literal("city_guide_recommendations"), value: cityGuideRecommendationsSchema })
    .strict(),
  z.object({ kind: z.literal("itinerary_proposal"), value: itineraryProposalSchema }).strict(),
  z.object({ kind: z.literal("agent_input_request"), value: agentInputRequestSchema }).strict(),
]);
export type AgentArtifact = z.infer<typeof agentArtifactSchema>;

/**
 * Safe application error categories (plan §3.5). Mapped through the existing
 * error envelope and SDK task failures; never carries provider stacks, tokens
 * or prompts. Cancellation and failed validation stay distinct from a
 * successful empty search result.
 */
export const agentFailureCategorySchema = z.enum([
  "AGENT_UNAVAILABLE",
  "AGENT_TIMEOUT",
  "AGENT_RESTARTED",
  "MCP_UNAVAILABLE",
  "MCP_TIMEOUT",
  "INVALID_ARTIFACT",
  "TASK_BUDGET_EXCEEDED",
  "INPUT_EXPIRED",
  "DELEGATION_REVOKED",
  "STALE_AGENT_RESULT",
]);
export type AgentFailureCategory = z.infer<typeof agentFailureCategorySchema>;
