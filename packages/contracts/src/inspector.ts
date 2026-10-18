import { z } from "zod";
import { decisionKindSchema, operationStatusSchema, scenarioDomainSchema } from "./enums.js";
import { graphDefinitionSchema } from "./graph-definition.js";
import { instantSchema, nonEmptyStringSchema, uuidSchema } from "./primitives.js";
import { publicProtocolObservationSchema } from "./protocol-observations.js";
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

/**
 * Phase 09 communication-inspector sections (ODTF_PLAN.md §3.15/§3.16).
 *
 * Every section renders ONLY persisted safe rows — the visual follows actual
 * communications, never a static graph topology. A2A/MCP/Application edges
 * carry distinct labels (see `edge`) with a legend in the UI. No SDK task
 * objects, prompts, tokens, raw payloads, secrets, or personal data appear.
 */

export const inspectorEdgeSchema = z.enum(["a2a", "mcp", "application"]);
export type InspectorEdge = z.infer<typeof inspectorEdgeSchema>;

/** One safe A2A communication row (delegation/task lifecycle evidence). */
export const publicInspectorCommunicationSchema = z
  .object({
    edge: z.literal("a2a"),
    /** Persisted agent identity (e.g. `flight-agent`); never an endpoint URL. */
    agentIdentity: nonEmptyStringSchema.max(120),
    skillId: nonEmptyStringSchema.max(120).nullable(),
    delegationId: uuidSchema.nullable(),
    /** Safe SDK-independent task state (`submitted`/`working`/…); never the SDK enum. */
    taskState: nonEmptyStringSchema.max(40).nullable(),
    /** Delegation lifecycle status (persisted `agent_delegations.status`). */
    delegationStatus: nonEmptyStringSchema.max(40).nullable(),
    /** Safe failure category when the row reports a failure; never a stack. */
    failureCategory: nonEmptyStringSchema.max(120).nullable(),
    durationMs: z.number().int().min(0).max(3_600_000).nullable(),
    /** Delegation attempt (retries visible per §3.15). */
    attempt: z.number().int().min(1).nullable(),
    /** Remote-cancel outcome for this delegation (`pending`/`acknowledged`/`failed`). */
    cancellationState: z.enum(["pending", "acknowledged", "failed"]).nullable(),
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .strict();
export type PublicInspectorCommunication = z.infer<typeof publicInspectorCommunicationSchema>;

/** One safe MCP communication row (discovery/invocation evidence). */
export const publicInspectorMcpCallSchema = z
  .object({
    edge: z.literal("mcp"),
    /** Safe tool/resource/invocation identity (never arguments or results). */
    name: nonEmptyStringSchema.max(200),
    kind: z.enum(["tool_call", "resource_read", "connect", "discovery"]),
    status: z.enum(["ok", "error"]),
    /** Safe failure category when the row reports a failure; never a stack. */
    failureCategory: nonEmptyStringSchema.max(120).nullable(),
    durationMs: z.number().int().min(0).max(3_600_000).nullable(),
    occurredAt: instantSchema,
  })
  .strict();
export type PublicInspectorMcpCall = z.infer<typeof publicInspectorMcpCallSchema>;

/** One safe application-protocol timeline event (bridged observations). */
export const publicInspectorTimelineEventSchema = z
  .object({
    edge: z.enum(["a2a", "mcp", "application"]),
    /** Persisted observation kind (e.g. `task_completed`, `mcp_tool_call`). */
    kind: nonEmptyStringSchema.max(80),
    /** Persisted observation source identity; never a credential or URL. */
    source: nonEmptyStringSchema.max(120),
    operationId: uuidSchema.nullable(),
    /** Safe one-line summary; never a payload dump. */
    summary: nonEmptyStringSchema.max(200).nullable(),
    at: instantSchema,
  })
  .strict();
export type PublicInspectorTimelineEvent = z.infer<typeof publicInspectorTimelineEventSchema>;

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
    /**
     * Phase 03/09: safe A2A/MCP observations of real interactions. Empty until
     * the coordinator/protocol phases persist observations for a trip.
     */
    protocolObservations: z.array(publicProtocolObservationSchema).max(200).default([]),
    /**
     * Phase 09 communication map (ODTF_PLAN.md §3.15): one safe row per
     * delegation/task lifecycle evidence. Empty until delegations exist.
     */
    communications: z.array(publicInspectorCommunicationSchema).max(200).default([]),
    /**
     * Phase 09 MCP section: one safe row per discovery/invocation evidence.
     * Derived from persisted `mcp_*` observations; never arguments/results.
     */
    mcpCalls: z.array(publicInspectorMcpCallSchema).max(200).default([]),
    /**
     * Phase 09 application-protocol timeline: bridged observations in
     * chronological source order (A2A/MCP/Application edges with a legend).
     */
    timeline: z.array(publicInspectorTimelineEventSchema).max(200).default([]),
  })
  .strict();
export type PublicInspector = z.infer<typeof publicInspectorSchema>;
