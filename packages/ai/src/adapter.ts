import type { z } from "zod";
import type { AIRole } from "@odft/contracts";
import { ROLE_CONTEXT_SCHEMAS } from "./roles/registry.js";
import type { IntentContext } from "./context/compact-context.js";
import type {
  PlannerContext,
  RecommendationContext,
  ReviewerContext,
} from "./context/role-contexts.js";

/**
 * Provider-independent adapter contract (06-ai-agent-design.md section 2).
 *
 * The interface contains no OpenRouter message type, SDK, or database entity.
 * Call reservations, safe telemetry, validated-response caching, and the effect
 * scope are owned by the surrounding invocation service, never by a role.
 */

export interface RoleContextMap {
  intent: IntentContext;
  recommendation: RecommendationContext;
  planner: PlannerContext;
  reviewer: ReviewerContext;
}

export interface StructuredRequest<T> {
  role: AIRole;
  promptVersion: string;
  operationId: string;
  effectScope: string;
  systemPrompt: string;
  context: RoleContextMap[AIRole];
  outputSchema: z.ZodType<T>;
  signal: AbortSignal;
}

export interface StructuredResponse<T> {
  value: T;
  callId: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  costUsd?: string;
  latencyMs: number;
  attempts: number;
  mode: "fixture" | "openrouter";
}

export interface LLMAdapter {
  generateObject<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>>;
}

/** Safe per-attempt usage persisted by the call governor (never prompt text). */
export interface AdapterUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningOutputTokens?: number;
  /** Provider-reported cost when authoritative; otherwise the conservative estimate. */
  readonly costUsd?: string;
  readonly costStatus: "actual" | "estimated" | "unknown_reserved";
  readonly latencyMs: number;
  readonly finishReason?: string;
  readonly attempts: number;
  readonly validationStatus: "valid" | "invalid";
  /** Typed failure code for an invalid/failed attempt (safe, never provider text). */
  readonly errorCode?: string;
}

/**
 * Durable call governance owned by the surrounding service. The adapter calls
 * `reserve` before every transport attempt (retries included) and `settle` (or
 * `markUnknown`) afterwards. Fixture mode uses no governor.
 */
export interface CallGovernor {
  reserve(attempt: number): Promise<{ readonly callId: string }>;
  settle(callId: string, usage: AdapterUsage): Promise<void>;
  markUnknown(callId: string, reason: string, latencyMs: number): Promise<void>;
}

export type AdapterErrorCode =
  | "AI_NOT_CONFIGURED"
  | "AI_CAPABILITY_UNKNOWN"
  | "AI_BUDGET_EXCEEDED"
  | "AI_PRICING_UNKNOWN"
  | "AI_AUTH_FAILED"
  | "AI_UNSUPPORTED"
  | "AI_INPUT_OVERFLOW"
  | "AI_TRANSPORT_FAILED"
  | "AI_SCHEMA_INVALID"
  | "AI_TIMEOUT"
  | "AI_ABORTED";

/** Typed adapter failure; `retryable` is the only retry signal a caller may use. */
export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly retryable: boolean;

  constructor(code: AdapterErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** Roles/context pairing is validated by parsing with the role's own strict schema. */
export function assertRoleContext(role: AIRole, context: unknown): void {
  const schema = ROLE_CONTEXT_SCHEMAS[role];
  const parsed = schema.safeParse(context);
  if (!parsed.success) {
    throw new AdapterError(
      "AI_UNSUPPORTED",
      `role context does not match the ${role} schema: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
}
