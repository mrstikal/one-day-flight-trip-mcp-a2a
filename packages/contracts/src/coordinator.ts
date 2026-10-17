import { z } from "zod";
import { delegationDomainSchema, researchDomainSchema, serviceLevelSchema } from "./enums.js";
import {
  fingerprintSchema,
  instantSchema,
  nonEmptyStringSchema,
  uuidSchema,
} from "./primitives.js";

/**
 * Phase 03: typed coordinator contracts (plan §3.8, §3.10).
 *
 * Ordinary discriminated unions and an explicit dispatch switch — no generic
 * node registry, dynamic graph compiler, reducer engine or workflow DSL. The
 * run cursor persists only the minimal immutable references required to
 * determine the next step; authoritative selections/reservations/preferences
 * are always loaded from the domain tables.
 */

export const COORDINATOR_VERSION = "coordinator-v1" as const;

export const coordinatorStepSchema = z.enum([
  "initializing",
  "interpreting",
  "validating_route",
  "requesting_flights",
  "researching",
  "validating_logistics",
  "planning",
  "awaiting_user",
  "completed",
  "failed",
  "cancelled",
]);
export type CoordinatorStep = z.infer<typeof coordinatorStepSchema>;

/** Typed wait reason stored with `awaiting_user`. */
export const coordinatorWaitReasonSchema = z.enum([
  "flight_choice",
  "booking_confirmation",
  "replacement_confirmation",
  "hotel_choice",
  "program_choices",
  "itinerary_approval",
  "route_change_confirmation",
  "clarification",
  "recovery",
  "agent_input",
]);
export type CoordinatorWaitReason = z.infer<typeof coordinatorWaitReasonSchema>;

/** Decision binding of a coordinator run (engine-discriminated in `decisions.ts`). */
export const coordinatorRunBindingSchema = z
  .object({
    runId: uuidSchema,
    coordinatorVersion: z.literal(COORDINATOR_VERSION),
  })
  .strict();
export type CoordinatorRunBinding = z.infer<typeof coordinatorRunBindingSchema>;

/**
 * Minimal persisted execution data of one run. References only: affected
 * domains, expected fingerprints, delegation ids, decision/resume binding,
 * planning attempt/feedback ids and the specialist-question queue state.
 */
export const coordinatorRunDataSchema = z
  .object({
    schemaVersion: z.literal(1),
    affectedDomains: z.array(researchDomainSchema).max(6),
    expectedFingerprints: z.partialRecord(researchDomainSchema, fingerprintSchema),
    /** Outstanding delegations this run waits on (ids only). */
    delegationIds: z.array(uuidSchema).max(8).default([]),
    /** Accepted artifact references keyed by domain (ids/hashes, not payloads). */
    acceptedArtifacts: z
      .partialRecord(
        researchDomainSchema,
        z.object({ artifactId: uuidSchema, payloadHash: fingerprintSchema }).strict(),
      )
      .default({}),
    /** Persisted specialist-question queue (FIFO promotion order). */
    questionQueue: z
      .array(
        z
          .object({
            requestId: nonEmptyStringSchema,
            delegationId: uuidSchema,
            taskId: nonEmptyStringSchema,
            contextId: nonEmptyStringSchema,
            inputGeneration: z.number().int().min(1),
            requestHash: fingerprintSchema,
            expiresAt: instantSchema,
            observedAt: instantSchema,
          })
          .strict(),
      )
      .max(4)
      .default([]),
    /** True while a drain gate is in progress before publishing a decision. */
    drainPending: z.boolean().default(false),
    planningAttempt: z.number().int().min(0).max(3).default(0),
    feedbackIds: z.array(nonEmptyStringSchema).max(8).default([]),
  })
  .strict();
export type CoordinatorRunData = z.infer<typeof coordinatorRunDataSchema>;

export const coordinatorRunStatusSchema = z.enum([
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);
export type CoordinatorRunStatus = z.infer<typeof coordinatorRunStatusSchema>;

/** Durable outbound delegation lifecycle (plan §3.6/§3.7). */
export const delegationStatusSchema = z.enum([
  "pending",
  "dispatched",
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
  "revoked",
]);
export type DelegationStatus = z.infer<typeof delegationStatusSchema>;

export const outboundDeliveryStateSchema = z.enum([
  "pending",
  "delivered",
  "acknowledged",
  "failed",
]);
export type OutboundDeliveryState = z.infer<typeof outboundDeliveryStateSchema>;

/**
 * Payload of an `agent_input` pending decision: the exact delegation/task/
 * context/request binding plus finite options. `choose_option` is the only
 * public answer action.
 */
export const agentInputDecisionPayloadSchema = z
  .object({
    requestId: nonEmptyStringSchema,
    delegationId: uuidSchema,
    taskId: nonEmptyStringSchema,
    contextId: nonEmptyStringSchema,
    inputGeneration: z.number().int().min(1),
    question: z.string().trim().min(1).max(400),
    options: z
      .array(
        z
          .object({ id: nonEmptyStringSchema, label: z.string().trim().min(1).max(120) })
          .strict(),
      )
      .min(2)
      .max(4),
    requestHash: fingerprintSchema,
    expiresAt: instantSchema,
  })
  .strict();
export type AgentInputDecisionPayload = z.infer<typeof agentInputDecisionPayloadSchema>;

/**
 * Engine-discriminated binding carried by every persisted pending decision:
 * graph decisions keep their checkpoint fields; coordinator decisions bind the
 * exact run instead (and must NOT invent graph ids).
 */
export const decisionEngineBindingSchema = z.discriminatedUnion("engine", [
  z
    .object({
      engine: z.literal("langgraph"),
      threadId: nonEmptyStringSchema,
      graphVersion: nonEmptyStringSchema,
      interruptId: nonEmptyStringSchema.nullable(),
      checkpointId: nonEmptyStringSchema.nullable(),
    })
    .strict(),
  z
    .object({
      engine: z.literal("coordinator-v1"),
      runId: uuidSchema,
      coordinatorVersion: z.literal(COORDINATOR_VERSION),
    })
    .strict(),
]);
export type DecisionEngineBinding = z.infer<typeof decisionEngineBindingSchema>;

/**
 * Phase 04: the persisted scope of one delegation — the only authority an
 * MCP tool or specialist agent may act under. `domains` is the exact domain
 * allowlist, `snapshotId` the frozen snapshot it was granted for; the flags
 * gate the deterministic route-validation and itinerary tools.
 */
export const delegationScopeSchema = z
  .object({
    domains: z.array(delegationDomainSchema).max(7),
    /** Frozen snapshot this delegation authorizes (null: reference-only work). */
    snapshotId: uuidSchema.nullable().default(null),
    allowRouteValidation: z.boolean().default(false),
    allowItinerary: z.boolean().default(false),
    /** Explicit search objective of a scoped re-search (null: preserve level). */
    objective: z.enum(["preserve_level", "cheaper"]).nullable().default(null),
    /** Operation-scoped category override for the delegated query. */
    levelOverride: serviceLevelSchema.nullable().default(null),
  })
  .strict();
export type DelegationScope = z.infer<typeof delegationScopeSchema>;
