import { z } from "zod";
import { domainCommandSchema } from "./commands.js";
import { preservableKeySchema } from "./enums.js";
import { nonEmptyStringSchema, uuidSchema } from "./primitives.js";

/**
 * AI role profiles, conversation projection, and call-governance contracts
 * (06-ai-agent-design.md sections 2-3, 08, 07-conversation-and-intents.md 6).
 *
 * The adapter interface itself lives in `@odft/ai`; these are the shared strict
 * schemas the worker, persistence, and BFF validate against.
 */

export const aiRoleSchema = z.enum(["intent", "recommendation", "planner", "reviewer"]);
export type AIRole = z.infer<typeof aiRoleSchema>;

export const reasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

/** Fixed-precision USD decimal string (never travel EUR money). */
export const usdDecimalSchema = z.string().regex(/^\d+(\.\d{1,9})?$/, "must be a USD decimal string");

export const roleProfileSchema = z
  .object({
    provider: z.literal("openrouter"),
    model: nonEmptyStringSchema,
    reasoningEffort: reasoningEffortSchema.optional(),
    temperature: z.number().min(0).max(2).optional(),
    // The abort deadline must stay below the worker's operation lease (60s default).
    timeoutMs: z.number().int().min(1_000).max(45_000),
    maxInputTokens: z.number().int().min(1).max(200_000),
    maxOutputTokens: z.number().int().min(1).max(200_000),
    maxAttempts: z.number().int().min(1).max(2),
    maxCallCostUsd: usdDecimalSchema,
    inputPriceUsdPerMillion: usdDecimalSchema,
    outputPriceUsdPerMillion: usdDecimalSchema,
    requestPriceUsd: usdDecimalSchema,
    pricingVersion: nonEmptyStringSchema,
    allowedEndpointProviderIds: z.array(nonEmptyStringSchema).min(1),
  })
  .strict();
export type RoleProfile = z.infer<typeof roleProfileSchema>;

export const roleProfilesSchema = z
  .object({
    intent: roleProfileSchema,
    recommendation: roleProfileSchema,
    planner: roleProfileSchema,
    reviewer: roleProfileSchema,
  })
  .strict();
export type RoleProfiles = z.infer<typeof roleProfilesSchema>;

export const aiModeSchema = z.enum(["fixture", "openrouter"]);
export type AiModeValue = z.infer<typeof aiModeSchema>;

export const costStatusSchema = z.enum(["actual", "estimated", "unknown_reserved"]);
export type CostStatus = z.infer<typeof costStatusSchema>;

export const llmCallStatusSchema = z.enum([
  "reserved",
  "succeeded",
  "failed",
  "unknown_reserved",
  "reconciled",
]);
export type LlmCallStatus = z.infer<typeof llmCallStatusSchema>;

/** Safe public telemetry row for the inspector (never prompts/reasoning). */
export const publicLlmCallSchema = z
  .object({
    id: uuidSchema,
    role: aiRoleSchema,
    model: nonEmptyStringSchema,
    promptVersion: nonEmptyStringSchema,
    mode: aiModeSchema,
    inputTokens: z.number().int().min(0).nullable(),
    outputTokens: z.number().int().min(0).nullable(),
    latencyMs: z.number().int().min(0).nullable(),
    costStatus: costStatusSchema,
    costUsd: usdDecimalSchema,
    attempts: z.number().int().min(0),
    validationStatus: z.enum(["valid", "invalid", "pending"]),
  })
  .strict();
export type PublicLlmCall = z.infer<typeof publicLlmCallSchema>;

/* ---- Conversation ------------------------------------------------------------ */

export const conversationRoleSchema = z.enum(["user", "assistant", "system"]);
export type ConversationRole = z.infer<typeof conversationRoleSchema>;

/** Public view of a clarification choice (labels only; commands stay server-side). */
export const publicClarificationOptionSchema = z
  .object({ id: nonEmptyStringSchema, label: nonEmptyStringSchema })
  .strict();
export type PublicClarificationOption = z.infer<typeof publicClarificationOptionSchema>;

export const publicInterpretationSchema = z
  .object({
    kind: z.enum(["commands", "clarification", "unsupported"]),
    interpretation: nonEmptyStringSchema.optional(),
    question: nonEmptyStringSchema.optional(),
    preserve: z.array(preservableKeySchema).optional(),
    options: z.array(publicClarificationOptionSchema).optional(),
    affected: z.array(preservableKeySchema).optional(),
  })
  .strict();
export type PublicInterpretation = z.infer<typeof publicInterpretationSchema>;

/**
 * The pending clarification card: question plus labelled opaque options.
 * Not `.strict()`: the server-side payload also carries `requestedCommands` and
 * `preserve`, which are stripped from the public projection.
 */
export const publicClarificationSchema = z.object({
  question: nonEmptyStringSchema,
  options: z.array(publicClarificationOptionSchema).min(1),
});
export type PublicClarification = z.infer<typeof publicClarificationSchema>;

export const publicConversationMessageSchema = z
  .object({
    id: uuidSchema,
    sequence: z.number().int().min(1),
    role: conversationRoleSchema,
    content: z.string().min(1).max(2000),
    interpretation: publicInterpretationSchema.nullable(),
    /**
     * Operation link for voice eligibility. Legacy messages have `null`; it is
     * never inferred from list position or timestamps.
     */
    operationId: uuidSchema.nullable(),
    createdAt: z.string().min(1),
  })
  .strict();
export type PublicConversationMessage = z.infer<typeof publicConversationMessageSchema>;

/* ---- Clarification contract (server-side, full) ------------------------------ */

export const clarificationOptionSchema = z
  .object({
    id: nonEmptyStringSchema,
    label: nonEmptyStringSchema,
    commands: z.array(domainCommandSchema).max(4),
  })
  .strict();
export type ClarificationOption = z.infer<typeof clarificationOptionSchema>;

/** Persisted interpretation for a clarification (drives the assistant card). */
export const clarificationStateSchema = z
  .object({
    question: nonEmptyStringSchema,
    requestedCommands: z.array(domainCommandSchema).max(4),
    preserve: z.array(preservableKeySchema),
    options: z.array(clarificationOptionSchema).min(2).max(4),
  })
  .strict();
export type ClarificationState = z.infer<typeof clarificationStateSchema>;

/** The compact chat payload carried in a workflow operation for interpretation. */
export const chatCommandPayloadSchema = z
  .object({
    kind: z.literal("chat"),
    message: nonEmptyStringSchema.max(2000),
  })
  .strict();
export type ChatCommandPayload = z.infer<typeof chatCommandPayloadSchema>;
