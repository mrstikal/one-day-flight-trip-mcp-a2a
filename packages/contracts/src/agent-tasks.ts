import { z } from "zod";
import { agentSkillIdSchema } from "./agent-artifacts.js";
import { researchDomainSchema, serviceLevelSchema, travelVariantSchema } from "./enums.js";
import {
  fingerprintSchema,
  instantSchema,
  nonEmptyStringSchema,
  uuidSchema,
} from "./primitives.js";
import { tripPreferencesSchema } from "./preferences.js";

/**
 * Phase 03: task request binding and continuation contracts (plan §3.5, §3.9).
 *
 * A task request binds the exact business inputs a specialist may act on. It
 * carries no conversation history, session identifiers/secrets, coordinator
 * fencing tokens or database credentials; names are omitted unless needed for
 * a user-facing explanation.
 */

export const AGENT_TASK_SCHEMA_VERSION = 1 as const;

/** Cumulative limits of one canonical task (including continuations). */
export const agentTaskLimitsSchema = z
  .object({
    /** Active execution budget; human waiting is excluded. */
    activeTimeMs: z.number().int().min(1),
    mcpInvocations: z.number().int().min(0),
    llmTransportAttempts: z.number().int().min(0),
    maxTaskCostUsd: z.number().min(0),
  })
  .strict();
export type AgentTaskLimits = z.infer<typeof agentTaskLimitsSchema>;

/** Explicit frozen-snapshot binding every task must carry. */
export const agentTaskSnapshotBindingSchema = z
  .object({
    snapshotId: uuidSchema,
    scenarioKey: nonEmptyStringSchema,
    /** Stage A route approval fingerprint. */
    routeApprovalFingerprint: fingerprintSchema,
    /** Stage B schedule approval fingerprint. */
    scheduleApprovalFingerprint: fingerprintSchema,
    /** Required domain content hashes/versions of the frozen snapshot. */
    domainFingerprints: z.partialRecord(researchDomainSchema, fingerprintSchema),
  })
  .strict();
export type AgentTaskSnapshotBinding = z.infer<typeof agentTaskSnapshotBindingSchema>;

export const agentTaskRequestSchema = z
  .object({
    schemaVersion: z.literal(AGENT_TASK_SCHEMA_VERSION),
    skillId: agentSkillIdSchema,
    tripId: uuidSchema,
    operationId: uuidSchema,
    acceptedRevision: z.number().int().min(0),
    delegationId: uuidSchema,
    /** Distinct correlation id; never used for business fingerprints. */
    traceId: nonEmptyStringSchema,
    snapshot: agentTaskSnapshotBindingSchema,
    inputFingerprint: fingerprintSchema,
    /** Exact domain scopes this task is allowed to research. */
    requestedDomains: z.array(researchDomainSchema).min(1).max(6),
    travelVariant: travelVariantSchema,
    adults: z.number().int().min(1).max(6),
    sightseeingDate: z.string().min(1),
    effectiveLevel: serviceLevelSchema,
    /** Selected/confirmed offer constraints the task must respect. */
    selectedOfferIds: z.array(nonEmptyStringSchema).max(32),
    confirmedOfferIds: z.array(nonEmptyStringSchema).max(32),
    preservationConstraints: z.array(nonEmptyStringSchema).max(32),
    searchObjective: z.enum(["preserve_level", "cheaper"]),
    /** Compact candidate/query context (existing ids and facts only). */
    queryContext: z.record(z.string(), z.unknown()),
    /** Absolute deadline for the whole canonical task. */
    deadlineAt: instantSchema,
    limits: agentTaskLimitsSchema,
    preferences: tripPreferencesSchema,
    /** Present only on continuations of an input-required task. */
    continuation: z
      .object({
        inputGeneration: z.number().int().min(1),
        answerRequestId: nonEmptyStringSchema,
        selectedOptionId: nonEmptyStringSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type AgentTaskRequest = z.infer<typeof agentTaskRequestSchema>;

/**
 * Continuation binding: same task/context, new authority/input generation at
 * the unchanged trip revision. A continuation never resets cumulative limits.
 */
export const agentContinuationSchema = z
  .object({
    taskId: nonEmptyStringSchema,
    contextId: nonEmptyStringSchema,
    inputGeneration: z.number().int().min(2),
    answerRequestId: nonEmptyStringSchema,
    selectedOptionId: nonEmptyStringSchema,
    acceptedRevision: z.number().int().min(0),
    delegationId: uuidSchema,
  })
  .strict();
export type AgentContinuation = z.infer<typeof agentContinuationSchema>;

/** SDK-independent safe task status snapshot (mirrors SDK states by meaning). */
export const agentTaskSafeStateSchema = z.enum([
  "submitted",
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
]);
export type AgentTaskSafeState = z.infer<typeof agentTaskSafeStateSchema>;
