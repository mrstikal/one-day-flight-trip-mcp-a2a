import { z } from "zod";
import { decisionKindSchema, operationStatusSchema, scenarioDomainSchema } from "./enums.js";
import { graphDefinitionSchema } from "./graph-definition.js";
import { instantSchema, nonEmptyStringSchema, uuidSchema } from "./primitives.js";
import { publicVoiceCallSchema } from "./voice.js";

/**
 * Safe execution-inspector projection (08-frontend-ux.md section 10, Phase 11).
 *
 * The inspector renders ONLY these fields. Prompts, chain-of-thought or raw
 * reasoning, provider payloads, SQL, stack traces, cookies, secrets, and raw
 * headers are never persisted in the first place (see `projectSafeEvent`), so
 * they cannot be revealed here.
 */

export const inspectorNodeStatusSchema = z.enum([
  "pending",
  "active",
  "completed",
  "interrupted",
  "failed",
]);
export type InspectorNodeStatus = z.infer<typeof inspectorNodeStatusSchema>;

export const publicInspectorNodeSchema = z
  .object({
    name: z.string().min(1).max(80),
    status: inspectorNodeStatusSchema,
    /** Bounded occurrence count of real node events for this node. */
    occurrences: z.number().int().min(0).max(10_000),
    lastAt: instantSchema.nullable(),
  })
  .strict();
export type PublicInspectorNode = z.infer<typeof publicInspectorNodeSchema>;

export const publicInspectorOperationSchema = z
  .object({
    operationId: uuidSchema,
    kind: z.enum(["command", "creation", "decision"]),
    status: operationStatusSchema,
    attempts: z.number().int().min(0),
    acceptedRevision: z.number().int().min(0),
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .strict();
export type PublicInspectorOperation = z.infer<typeof publicInspectorOperationSchema>;

export const publicInspectorCheckpointSchema = z
  .object({
    decisionId: uuidSchema,
    kind: decisionKindSchema,
    status: z.enum(["pending", "resolved", "cancelled"]),
    createdRevision: z.number().int().min(0),
    checkpointId: z.string().min(1).max(200).nullable(),
    interruptId: z.string().min(1).max(200).nullable(),
    createdAt: instantSchema,
  })
  .strict();
export type PublicInspectorCheckpoint = z.infer<typeof publicInspectorCheckpointSchema>;

export const publicInspectorLlmCallSchema = z
  .object({
    role: z.enum(["intent", "recommendation", "planner", "reviewer"]),
    model: nonEmptyStringSchema.max(200),
    promptVersion: nonEmptyStringSchema.max(80),
    mode: z.enum(["fixture", "openrouter"]),
    status: nonEmptyStringSchema.max(60),
    validationStatus: nonEmptyStringSchema.max(60).nullable(),
    attempts: z.number().int().min(0),
    reservedTokens: z.number().int().min(0),
    actualTokens: z.number().int().min(0).nullable(),
    /** Decimal USD strings (never lossy floats). */
    reservedCostUsd: z.string().regex(/^\d+(\.\d+)?$/),
    actualCostUsd: z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .nullable(),
    createdAt: instantSchema,
  })
  .strict();
export type PublicInspectorLlmCall = z.infer<typeof publicInspectorLlmCallSchema>;

export const publicInspectorFaultSchema = z
  .object({
    domain: z.union([scenarioDomainSchema, z.literal("itinerary")]),
    mode: nonEmptyStringSchema.max(80),
    /** Injected faults are always labeled exactly this way. */
    label: z.literal("Simulated failure"),
    note: nonEmptyStringSchema.max(300).nullable(),
    at: instantSchema,
  })
  .strict();
export type PublicInspectorFault = z.infer<typeof publicInspectorFaultSchema>;

export const publicInspectorEventSchema = z
  .object({
    /** Monotonic bigint id as a decimal string (never a lossy number). */
    id: z.string().regex(/^\d+$/),
    type: nonEmptyStringSchema.max(80),
    node: nonEmptyStringSchema.max(80).nullable(),
    /** Safe one-line summary; never a payload dump. */
    summary: nonEmptyStringSchema.max(200).nullable(),
    at: instantSchema,
  })
  .strict();
export type PublicInspectorEvent = z.infer<typeof publicInspectorEventSchema>;

export const publicInspectorSchema = z
  .object({
    /** Current persisted scenario mode (`normal` when no overlay is armed). */
    scenarioMode: nonEmptyStringSchema.max(80),
    graph: graphDefinitionSchema.nullable(),
    nodes: z.array(publicInspectorNodeSchema).max(64),
    operations: z.array(publicInspectorOperationSchema).max(200),
    checkpoints: z.array(publicInspectorCheckpointSchema).max(200),
    llmCalls: z.array(publicInspectorLlmCallSchema).max(200),
    /** Sum of every DISPLAYED call's settled-or-reserved cost (`actual ?? reserved`). */
    llmCostTotalUsd: z.string().regex(/^\d+(\.\d+)?$/),
    /** Voice usage stays a separate, USD-only section — never merged into LLM or travel totals. */
    voiceCalls: z.array(publicVoiceCallSchema).max(200),
    faults: z.array(publicInspectorFaultSchema).max(50),
    events: z.array(publicInspectorEventSchema).max(200),
  })
  .strict();
export type PublicInspector = z.infer<typeof publicInspectorSchema>;
