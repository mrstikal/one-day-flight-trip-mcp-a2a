import { z } from "zod";
import { AdapterError } from "../adapter.js";
import {
  decisionKindSchema,
  moneyMinorSchema,
  nonEmptyStringSchema,
  preservableKeySchema,
  serviceLevelSchema,
  tripPreferencesSchema,
  conversationRoleSchema,
  messageSchema,
} from "@odft/contracts";

/**
 * Compact, structured intent context (06-ai-agent-design.md section 7 /
 * 07-conversation-and-intents.md section 6).
 *
 * Authoritative current preferences/refs, at most six recent messages, and a
 * deterministic summary of older resolved requests. The full transcript is never
 * resent; preferences are never reconstructed from prose.
 */

const activityCountsSchema = z
  .object({
    museum: z.number().int().min(0).max(7).optional(),
    landmark: z.number().int().min(0).max(7).optional(),
    gallery: z.number().int().min(0).max(7).optional(),
    architecture: z.number().int().min(0).max(7).optional(),
    park: z.number().int().min(0).max(7).optional(),
    garden: z.number().int().min(0).max(7).optional(),
    waterfront: z.number().int().min(0).max(7).optional(),
    viewpoint: z.number().int().min(0).max(7).optional(),
    performance: z.number().int().min(0).max(7).optional(),
  })
  .strict();

export type ActivityCounts = z.infer<typeof activityCountsSchema>;

const selectedServiceSchema = z
  .object({
    service: preservableKeySchema,
    offerId: nonEmptyStringSchema,
    level: serviceLevelSchema.nullable().optional(),
    partyTotalMinor: moneyMinorSchema.optional(),
    /** True when a confirmed demo reservation exists for this service. */
    confirmed: z.boolean().optional(),
  })
  .strict();

const routeContextSchema = z
  .object({
    originAirportId: nonEmptyStringSchema,
    destinationCityId: nonEmptyStringSchema,
    destinationCountryKey: nonEmptyStringSchema,
    sightseeingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    travelVariant: z.enum(["one_night", "two_nights"]),
  })
  .strict();

const pendingClarificationSchema = z
  .object({
    question: nonEmptyStringSchema,
    requestedCommands: z.array(z.unknown()).max(4),
    preserve: z.array(preservableKeySchema),
    options: z.array(z.object({ id: nonEmptyStringSchema, label: nonEmptyStringSchema }).strict()).max(4),
  })
  .strict();

const recentMessageSchema = z
  .object({ role: conversationRoleSchema, content: z.string().min(1).max(2000) })
  .strict();

const resolvedRequestSchema = z
  .object({ request: z.string().min(1).max(500), outcome: z.string().min(1).max(500) })
  .strict();

export const intentContextSchema = z
  .object({
    role: z.literal("intent"),
    message: messageSchema,
    userName: z.string().trim().min(1).max(60),
    /** Server clock date, so relative date requests have an authoritative anchor. */
    today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    route: routeContextSchema,
    preferences: tripPreferencesSchema,
    pendingClarification: pendingClarificationSchema.nullable().optional(),
    selectedServices: z.array(selectedServiceSchema).max(7),
    currentActivityCounts: activityCountsSchema,
    pendingDecisionKind: decisionKindSchema.nullable(),
    budgetMinor: moneyMinorSchema.nullable(),
    recentMessages: z.array(recentMessageSchema).max(6),
    summary: z.array(resolvedRequestSchema).max(20),
    knownCityIds: z.array(nonEmptyStringSchema).max(200),
    knownAirportIds: z.array(nonEmptyStringSchema).max(200),
    knownOfferIds: z.array(nonEmptyStringSchema).max(50),
  })
  .strict();
export type IntentContext = z.infer<typeof intentContextSchema>;

/** Authoritative rows loaded server-side, before any bounding/compaction. */
export const compactContextSourceSchema = z
  .object({
    message: messageSchema,
    userName: z.string().trim().min(1).max(60),
    today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    route: routeContextSchema,
    preferences: tripPreferencesSchema,
    pendingClarification: pendingClarificationSchema.nullable().optional(),
    selectedServices: z.array(selectedServiceSchema),
    currentActivityCounts: activityCountsSchema,
    pendingDecisionKind: decisionKindSchema.nullable(),
    budgetMinor: moneyMinorSchema.nullable(),
    recentMessages: z.array(recentMessageSchema),
    summary: z.array(resolvedRequestSchema),
    knownCityIds: z.array(nonEmptyStringSchema),
    knownAirportIds: z.array(nonEmptyStringSchema),
    knownOfferIds: z.array(nonEmptyStringSchema),
    /** Server-side membership sets (never sent to the model). */
    knownActivityIds: z.array(nonEmptyStringSchema).optional(),
    knownRestaurantIds: z.array(nonEmptyStringSchema).optional(),
  })
  .strict();
export type CompactContextSource = z.infer<typeof compactContextSourceSchema>;

/** Conservative UTF-8-bound token estimate (never an optimistic character count). */
export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  const bytes = Buffer.byteLength(text, "utf8");
  return Math.ceil(bytes / 3) + 8;
}

export interface ContextBudget {
  /** Whole role input cap (default 6000 tokens). */
  readonly maxInputTokens: number;
  /** Conversation-history portion cap (default 4096 tokens). */
  readonly maxHistoryTokens: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxInputTokens: 6_000,
  maxHistoryTokens: 4_096,
};

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/**
 * Build the bounded intent context. History is truncated first (oldest messages
 * dropped), then the whole input is checked against the cap: if required context
 * still exceeds it, the caller receives a typed reduced-scope failure rather
 * than silently dropping fixed constraints.
 */
export function buildCompactContext(
  source: CompactContextSource,
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
): IntentContext {
  const sourceParsed = compactContextSourceSchema.safeParse(source);
  if (!sourceParsed.success) {
    // A malformed server-built source is a typed, terminal context failure, not a
    // raw ZodError that could be mistaken for a transient graph failure.
    throw new AdapterError(
      "AI_INPUT_OVERFLOW",
      `the compact context source is invalid: ${sourceParsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const parsed = sourceParsed.data;
  let recentMessages = [...parsed.recentMessages].slice(-6);
  let summary = [...parsed.summary].slice(-20);

  const candidate = (): IntentContext =>
    intentContextSchema.parse({
      role: "intent",
      message: parsed.message,
      userName: parsed.userName,
      today: parsed.today,
      route: parsed.route,
      preferences: parsed.preferences,
      ...(parsed.pendingClarification !== undefined
        ? { pendingClarification: parsed.pendingClarification }
        : {}),
      selectedServices: parsed.selectedServices,
      currentActivityCounts: parsed.currentActivityCounts,
      pendingDecisionKind: parsed.pendingDecisionKind,
      budgetMinor: parsed.budgetMinor,
      recentMessages,
      summary,
      knownCityIds: sortedUnique(parsed.knownCityIds),
      knownAirportIds: sortedUnique(parsed.knownAirportIds),
      knownOfferIds: sortedUnique(parsed.knownOfferIds),
    });

  let context = candidate();
  // Truncate only nonessential history first.
  while (
    estimateTokens({ context, summary }) > budget.maxHistoryTokens &&
    recentMessages.length > 0
  ) {
    recentMessages = recentMessages.slice(1);
    context = candidate();
  }
  while (estimateTokens({ context, summary }) > budget.maxHistoryTokens && summary.length > 0) {
    summary = summary.slice(1);
    context = candidate();
  }
  if (estimateTokens(context) > budget.maxInputTokens) {
    throw new ReducedScopeError(
      "the required trip context exceeds the configured AI input budget",
    );
  }
  return context;
}

/** Typed reduced-scope failure: never silently drop fixed constraints. */
export class ReducedScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReducedScopeError";
  }
}
