import type { PublicLlmCall } from "@odft/contracts";

/**
 * Safe LLM telemetry projection (06-ai-agent-design.md section 8 /
 * 10-security-reliability.md section 8).
 *
 * Allowed: role/model, prompt version label, token counts, latency, cost status,
 * validation status, attempts. Forbidden without exception: prompts, raw model
 * output, reasoning/chain-of-thought, provider payloads, cookies, or keys.
 */

export const TELEMETRY_ALLOWED_KEYS = [
  "id",
  "role",
  "model",
  "promptVersion",
  "mode",
  "inputTokens",
  "outputTokens",
  "latencyMs",
  "costStatus",
  "costUsd",
  "attempts",
  "validationStatus",
] as const;

export const FORBIDDEN_TELEMETRY_KEYS = [
  "prompt",
  "prompts",
  "systemPrompt",
  "message",
  "messages",
  "rawResponse",
  "response",
  "reasoning",
  "reasoningDetails",
  "reasoning_details",
  "chainOfThought",
  "providerPayload",
  "request",
  "headers",
  "cookie",
  "apiKey",
  "authorization",
  "sql",
  "stack",
] as const;

export interface LlmCallTelemetryRow {
  readonly id: string;
  readonly role: PublicLlmCall["role"];
  readonly model: string;
  readonly promptVersion: string;
  readonly mode: PublicLlmCall["mode"];
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number | null;
  readonly costStatus: PublicLlmCall["costStatus"];
  readonly costUsd: string;
  readonly attempts: number;
  readonly validationStatus: PublicLlmCall["validationStatus"];
}

/** Whitelist projection: only allowlisted keys can leave the server. */
export function sanitizeTelemetry(record: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of TELEMETRY_ALLOWED_KEYS) {
    if (record[key] !== undefined) {
      safe[key] = record[key];
    }
  }
  return safe;
}

/** Assert a telemetry record contains no forbidden fields (used by tests). */
export function assertTelemetrySafe(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if ((FORBIDDEN_TELEMETRY_KEYS as readonly string[]).includes(key)) {
      throw new Error(`forbidden telemetry field: ${key}`);
    }
  }
}

export function toPublicLlmCall(row: LlmCallTelemetryRow): PublicLlmCall {
  const safe = sanitizeTelemetry(row as unknown as Record<string, unknown>);
  assertTelemetrySafe(safe);
  return {
    id: row.id,
    role: row.role,
    model: row.model,
    promptVersion: row.promptVersion,
    mode: row.mode,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    latencyMs: row.latencyMs,
    costStatus: row.costStatus,
    costUsd: row.costUsd,
    attempts: row.attempts,
    validationStatus: row.validationStatus,
  };
}
