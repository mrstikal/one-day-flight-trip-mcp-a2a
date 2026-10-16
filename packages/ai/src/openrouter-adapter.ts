import { z } from "zod";
import type { RoleProfile, RoleProfiles } from "@odft/contracts";
import {
  AdapterError,
  assertRoleContext,
  type AdapterUsage,
  type CallGovernor,
  type LLMAdapter,
  type StructuredRequest,
  type StructuredResponse,
} from "./adapter.js";
import { assertModelCapable, type CapabilityManifest } from "./capabilities.js";
import { estimateTokens } from "./context/compact-context.js";
import { formatUsd, parseUsd, worstCaseCostUsd } from "./costs.js";

/**
 * OpenRouter transport (06-ai-agent-design.md section 4).
 *
 * Non-streaming strict structured responses, `provider.require_parameters`,
 * verified endpoint allowlist with fallback disabled, `reasoning.exclude` when
 * supported, and at most one repair/retry (two total attempts). No model
 * fallback: capability/pricing is validated before the first billable call.
 */

export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

export type FetchLike = typeof globalThis.fetch;

export interface OpenRouterAdapterOptions {
  readonly apiKey: string;
  readonly manifest: CapabilityManifest;
  readonly profiles: RoleProfiles;
  /** Optional durable governor; each attempt is reserved before transport. */
  readonly governor?: CallGovernor;
  readonly fetchImpl?: FetchLike;
  readonly endpoint?: string;
  readonly now?: () => Date;
}

interface ChatResponse {
  choices?: {
    message?: { content?: string | null; reasoning?: unknown; reasoning_details?: unknown };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number | string;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { code?: number | string; message?: string; metadata?: { transient?: boolean } };
}

/**
 * Optional, non-nullable transport fields per discriminated-union branch.
 *
 * OpenAI `strict: true` requires every property in `required`; an optional field
 * is therefore sent as a required nullable field and MUST be stripped back to
 * `undefined` before Zod validation (otherwise a canonical command would carry a
 * `null` that its `.optional()` member rejects, while genuinely nullable fields
 * such as `set_service_override.level` must keep their `null`).
 */
export const OPTIONAL_TRANSPORT_FIELDS: Readonly<Record<string, ReadonlyMap<string, ReadonlySet<string>>>> = {
  intent: new Map([
    [
      "set_route",
      new Set(["originAirportId", "destinationCityId", "sightseeingDate", "travelVariant"]),
    ],
    ["find_alternatives", new Set(["level"])],
  ]),
  recommendation: new Map(),
  planner: new Map(),
  reviewer: new Map(),
};

function isNullableNode(node: unknown): boolean {
  if (!node || typeof node !== "object") {
    return false;
  }
  const record = node as Record<string, unknown>;
  if (Array.isArray(record.type) && record.type.includes("null")) {
    return true;
  }
  const branches = Array.isArray(record.anyOf)
    ? record.anyOf
    : Array.isArray(record.oneOf)
      ? record.oneOf
      : [];
  return branches.some(
    (branch) =>
      branch !== null &&
      typeof branch === "object" &&
      (branch as Record<string, unknown>).type === "null",
  );
}

function makeNullable(node: unknown): unknown {
  return isNullableNode(node) ? node : { anyOf: [node, { type: "null" }] };
}

function branchDiscriminator(node: Record<string, unknown>): string | undefined {
  const properties = node.properties as Record<string, unknown> | undefined;
  const typeNode = properties?.type as Record<string, unknown> | undefined;
  if (typeNode && typeof typeNode.const === "string") {
    return typeNode.const;
  }
  if (typeNode && Array.isArray(typeNode.enum) && typeNode.enum.length === 1) {
    return typeof typeNode.enum[0] === "string" ? typeNode.enum[0] : undefined;
  }
  return undefined;
}

/**
 * Rewrite a JSON schema for strict structured outputs:
 * - every object gets `additionalProperties: false` and `required = all keys`;
 * - originally optional properties become nullable (`anyOf: [T, null]`);
 * - `oneOf` becomes `anyOf` (strict-mode friendly; branches stay disjoint by their
 *   `type` const).
 *
 * `collected` records per discriminator branch which properties were optional and
 * not already nullable, so the caller can strip their transport `null` back to
 * `undefined` after parsing.
 */
function strictifySchema(
  node: unknown,
  collected?: Map<string, Set<string>>,
): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => strictifySchema(item, collected));
  }
  if (!node || typeof node !== "object") {
    return node;
  }
  const record = node as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = strictifySchema(value, collected);
  }
  if (Array.isArray(result.oneOf) && result.anyOf === undefined) {
    result.anyOf = result.oneOf;
    delete result.oneOf;
  }
  if (result.type === "object" && result.properties && typeof result.properties === "object") {
    const properties = result.properties as Record<string, unknown>;
    const originallyRequired = new Set(
      Array.isArray(result.required) ? result.required.filter((k): k is string => typeof k === "string") : [],
    );
    const discriminator = branchDiscriminator(record);
    const strictProperties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (originallyRequired.has(key)) {
        strictProperties[key] = value;
        continue;
      }
      strictProperties[key] = makeNullable(value);
      if (collected && !isNullableNode(value) && discriminator) {
        const set = collected.get(discriminator) ?? new Set<string>();
        set.add(key);
        collected.set(discriminator, set);
      }
    }
    result.properties = strictProperties;
    result.required = Object.keys(strictProperties);
    if (result.additionalProperties === undefined) {
      result.additionalProperties = false;
    }
  }
  return result;
}

export interface TransportSchema {
  /** The strict JSON schema sent to the provider. */
  readonly schema: unknown;
  /** Per disciminator branch, the optional fields sent as nullable. */
  readonly optionalFields: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Wrap the role schema in an object root with a required `result` property. */
export function buildTransportSchema(outputSchema: z.ZodType<unknown>): TransportSchema {
  const optionalFields = new Map<string, Set<string>>();
  const jsonSchema = strictifySchema(z.toJSONSchema(outputSchema), optionalFields);
  return {
    schema: {
      type: "object",
      properties: { result: jsonSchema },
      required: ["result"],
      additionalProperties: false,
    },
    optionalFields,
  };
}

/**
 * Strip transport `null` values that stand for "absent optional field" back to
 * `undefined`. Genuinely nullable contract fields (e.g. `set_service_override.level`,
 * `set_activity_requirement.minimumCount`) keep their `null`.
 */
export function stripOptionalTransportNulls(
  value: unknown,
  optionalFields: ReadonlyMap<string, ReadonlySet<string>>,
): unknown {
  const visitCommands = (commands: unknown): void => {
    if (!Array.isArray(commands)) {
      return;
    }
    for (const command of commands) {
      if (!command || typeof command !== "object") {
        continue;
      }
      const record = command as Record<string, unknown>;
      const keys = typeof record.type === "string" ? optionalFields.get(record.type) : undefined;
      if (!keys) {
        continue;
      }
      for (const key of keys) {
        if (record[key] === null) {
          delete record[key];
        }
      }
    }
  };
  if (value && typeof value === "object") {
    const result = value as Record<string, unknown>;
    visitCommands(result.commands);
    visitCommands(result.requestedCommands);
    if (Array.isArray(result.options)) {
      for (const option of result.options) {
        if (option && typeof option === "object") {
          visitCommands((option as Record<string, unknown>).commands);
        }
      }
    }
  }
  return value;
}

function mergeOptionalFields(
  fromSchema: ReadonlyMap<string, ReadonlySet<string>>,
  fromRole: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const merged = new Map<string, Set<string>>();
  for (const source of [fromRole, fromSchema]) {
    for (const [branch, keys] of source) {
      const target = merged.get(branch) ?? new Set<string>();
      for (const key of keys) {
        target.add(key);
      }
      merged.set(branch, target);
    }
  }
  return merged;
}

function combineSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) {
      continue;
    }
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function classifyHttpFailure(status: number, body: ChatResponse): AdapterError {
  if (status === 401 || status === 403) {
    return new AdapterError("AI_AUTH_FAILED", "provider rejected the credentials", false);
  }
  if (status === 402) {
    const transient = body.error?.metadata?.transient === true;
    return new AdapterError(
      "AI_BUDGET_EXCEEDED",
      "provider budget/credit limit reached",
      transient,
    );
  }
  if (status === 400 || status === 404 || status === 422) {
    return new AdapterError("AI_UNSUPPORTED", "provider rejected the request parameters or schema", false);
  }
  if (status === 429 || status >= 500) {
    return new AdapterError("AI_TRANSPORT_FAILED", `provider returned status ${status}`, true);
  }
  return new AdapterError("AI_TRANSPORT_FAILED", `provider returned status ${status}`, false);
}

function estimatedCostUsd(profile: RoleProfile, usage: ChatResponse["usage"]): string {
  const inputTokens = usage?.prompt_tokens ?? profile.maxInputTokens;
  const outputTokens = usage?.completion_tokens ?? profile.maxOutputTokens;
  return formatUsd(
    worstCaseCostUsd(profile, { inputTokens, outputTokens }),
  );
}

export class OpenRouterAdapter implements LLMAdapter {
  private readonly options: OpenRouterAdapterOptions;

  constructor(options: OpenRouterAdapterOptions) {
    this.options = options;
  }

  /**
   * One transport attempt. The profile deadline covers the FULL response: the body
   * is read inside the timeout window (fetch resolves at headers, so clearing the
   * timer there would let a stalled body hold the operation and the trip lock).
   */
  private async transport(
    body: Record<string, unknown>,
    signal: AbortSignal,
    profile: RoleProfile,
  ): Promise<{ status: number; ok: boolean; text: string; latencyMs: number }> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error("ai timeout")), profile.timeoutMs);
    const started = performance.now();
    try {
      const response = await fetchImpl(this.options.endpoint ?? OPENROUTER_CHAT_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: combineSignals([signal, timeout.signal]),
      });
      const text = await response.text();
      return {
        status: response.status,
        ok: response.ok,
        text,
        latencyMs: Math.max(0, Math.round(performance.now() - started)),
      };
    } catch (error) {
      // Classify by which signal fired, not by the error name: an abort reason may
      // surface as a plain Error (e.g. the driver's shutdown abort).
      if (signal.aborted) {
        throw new AdapterError("AI_ABORTED", "the AI request was aborted", false);
      }
      if (timeout.signal.aborted) {
        throw new AdapterError("AI_TIMEOUT", "the AI request timed out", true);
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new AdapterError("AI_ABORTED", "the AI request was aborted", false);
      }
      throw new AdapterError(
        "AI_TRANSPORT_FAILED",
        error instanceof Error ? error.message : "unknown transport failure",
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async generateObject<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    const profile = this.options.profiles[request.role];
    assertRoleContext(request.role, request.context);
    // Fail closed BEFORE any billable call: unknown capability/pricing is refused.
    assertModelCapable(profile, this.options.manifest);

    const transport = buildTransportSchema(request.outputSchema);
    const optionalFields = mergeOptionalFields(
      transport.optionalFields,
      OPTIONAL_TRANSPORT_FIELDS[request.role] ?? new Map(),
    );
    const userContent = JSON.stringify(request.context);
    const maxAttempts = Math.min(profile.maxAttempts, 2);
    const systemTokens = estimateTokens(request.systemPrompt);
    let repairNote: string | undefined;
    let lastError: AdapterError | undefined;
    let attempts = 0;
    let totalLatency = 0;
    let costStatus: AdapterUsage["costStatus"] = "estimated";
    let costUsd: string | undefined;
    // Exactly one settle per reserved attempt, even when a failure path re-throws.
    const settledCalls = new Set<string>();
    const settleOnce = async (callId: string, usage: AdapterUsage): Promise<void> => {
      if (!this.options.governor || settledCalls.has(callId)) {
        return;
      }
      settledCalls.add(callId);
      await this.options.governor.settle(callId, usage);
    };
    const markUnknownOnce = async (
      callId: string,
      reason: string,
      latencyMs: number,
    ): Promise<void> => {
      if (!this.options.governor || settledCalls.has(callId)) {
        return;
      }
      settledCalls.add(callId);
      await this.options.governor.markUnknown(callId, reason, latencyMs);
    };

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt;
      // An abort between attempts must not create a phantom reservation.
      if (request.signal.aborted) {
        throw new AdapterError("AI_ABORTED", "the AI request was aborted", false);
      }
      const attemptContent = repairNote ? `${userContent}\n\nSchema errors: ${repairNote}` : userContent;
      // The reservation must cover what is actually sent: system prompt, context,
      // and any repair note must fit the profile's input cap (fail closed).
      const attemptTokens = systemTokens + estimateTokens(attemptContent);
      if (attemptTokens > profile.maxInputTokens) {
        throw new AdapterError(
          "AI_INPUT_OVERFLOW",
          `the role input (${attemptTokens} tokens) exceeds the profile cap (${profile.maxInputTokens})`,
          false,
        );
      }
      const reservation = await this.options.governor?.reserve(attempt);
      const body = {
        model: profile.model,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: attemptContent },
        ],
        max_tokens: profile.maxOutputTokens,
        ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
        ...(profile.reasoningEffort
          ? { reasoning: { effort: profile.reasoningEffort, exclude: true } }
          : {}),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: `${request.role}_${request.promptVersion.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
            strict: true,
            schema: transport.schema,
          },
        },
        provider: {
          require_parameters: true,
          only: profile.allowedEndpointProviderIds,
          allow_fallbacks: false,
          max_price: {
            prompt: profile.inputPriceUsdPerMillion,
            completion: profile.outputPriceUsdPerMillion,
            request: profile.requestPriceUsd,
          },
        },
      };

      const transportStarted = performance.now();
      let transportCompleted = false;
      try {
        const { ok, status, text, latencyMs } = await this.transport(body, request.signal, profile);
        transportCompleted = true;
        totalLatency += latencyMs;
        let parsedBody: ChatResponse = {};
        try {
          parsedBody = text ? (JSON.parse(text) as ChatResponse) : {};
        } catch {
          parsedBody = {};
        }
        if (!ok) {
          const failure = classifyHttpFailure(status, parsedBody);
          if (reservation) {
            if (failure.retryable) {
              await markUnknownOnce(reservation.callId, failure.code, latencyMs);
            } else {
              await settleOnce(reservation.callId, {
                latencyMs,
                costStatus: "actual",
                costUsd: "0",
                attempts: attempt,
                validationStatus: "invalid",
                errorCode: failure.code,
              });
            }
          }
          if (!failure.retryable || attempt >= maxAttempts) {
            throw failure;
          }
          lastError = failure;
          continue;
        }

        const choice = parsedBody.choices?.[0];
        const finishReason = choice?.finish_reason;
        const content = choice?.message?.content;
        // Reasoning fields are discarded regardless of what the provider returns.
        if (finishReason === "length") {
          const failure = new AdapterError(
            "AI_TRANSPORT_FAILED",
            "the completion hit the output cap with no usable content; raise the role maxOutputTokens (reasoning tokens count toward it)",
            false,
          );
          if (reservation) {
            await settleOnce(reservation.callId, {
              inputTokens: parsedBody.usage?.prompt_tokens,
              outputTokens: parsedBody.usage?.completion_tokens,
              latencyMs,
              costStatus: usageCost(parsedBody.usage) ? "actual" : "estimated",
              costUsd: usageCost(parsedBody.usage) ?? estimatedCostUsd(profile, parsedBody.usage),
              ...(finishReason ? { finishReason } : {}),
              attempts: attempt,
              validationStatus: "invalid",
              errorCode: failure.code,
            });
          }
          throw failure;
        }
        if (typeof content !== "string" || content.trim() === "") {
          const failure = new AdapterError(
            "AI_TRANSPORT_FAILED",
            "the provider returned no structured content",
            true,
          );
          if (reservation) {
            await markUnknownOnce(reservation.callId, failure.code, latencyMs);
          }
          if (attempt >= maxAttempts) {
            throw failure;
          }
          lastError = failure;
          continue;
        }

        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(content);
        } catch {
          const failure = new AdapterError("AI_SCHEMA_INVALID", "the response was not valid JSON", false);
          if (reservation) {
            await settleOnce(reservation.callId, {
              inputTokens: parsedBody.usage?.prompt_tokens,
              outputTokens: parsedBody.usage?.completion_tokens,
              latencyMs,
              costStatus: usageCost(parsedBody.usage) ? "actual" : "estimated",
              costUsd: usageCost(parsedBody.usage) ?? estimatedCostUsd(profile, parsedBody.usage),
              ...(finishReason ? { finishReason } : {}),
              attempts: attempt,
              validationStatus: "invalid",
            });
          }
          repairNote = "the previous response was not valid JSON";
          lastError = failure;
          continue;
        }

        const inner = stripOptionalTransportNulls(
          (parsedJson as { result?: unknown }).result,
          optionalFields,
        );
        const validated = request.outputSchema.safeParse(inner);
        if (!validated.success) {
          const message = validated.error.issues
            .slice(0, 5)
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ");
          if (reservation) {
            await settleOnce(reservation.callId, {
              inputTokens: parsedBody.usage?.prompt_tokens,
              outputTokens: parsedBody.usage?.completion_tokens,
              latencyMs,
              costStatus: usageCost(parsedBody.usage) ? "actual" : "estimated",
              costUsd: usageCost(parsedBody.usage) ?? estimatedCostUsd(profile, parsedBody.usage),
              ...(finishReason ? { finishReason } : {}),
              attempts: attempt,
              validationStatus: "invalid",
            });
          }
          repairNote = message;
          lastError = new AdapterError("AI_SCHEMA_INVALID", `structured output failed validation: ${message}`, true);
          continue;
        }

        const providerCost = usageCost(parsedBody.usage);
        costUsd = providerCost ?? estimatedCostUsd(profile, parsedBody.usage);
        costStatus = providerCost ? "actual" : "estimated";
        if (reservation) {
          await settleOnce(reservation.callId, {
            inputTokens: parsedBody.usage?.prompt_tokens,
            outputTokens: parsedBody.usage?.completion_tokens,
            cachedInputTokens: parsedBody.usage?.prompt_tokens_details?.cached_tokens,
            reasoningOutputTokens: parsedBody.usage?.completion_tokens_details?.reasoning_tokens,
            latencyMs,
            costStatus,
            costUsd,
            ...(finishReason ? { finishReason } : {}),
            attempts: attempt,
            validationStatus: "valid",
          });
        }
        return {
          value: validated.data,
          callId: reservation?.callId ?? `openrouter-${attempt}`,
          model: profile.model,
          ...(parsedBody.usage?.prompt_tokens !== undefined
            ? { inputTokens: parsedBody.usage.prompt_tokens }
            : {}),
          ...(parsedBody.usage?.completion_tokens !== undefined
            ? { outputTokens: parsedBody.usage.completion_tokens }
            : {}),
          ...(parsedBody.usage?.prompt_tokens_details?.cached_tokens !== undefined
            ? { cachedInputTokens: parsedBody.usage.prompt_tokens_details.cached_tokens }
            : {}),
          ...(parsedBody.usage?.completion_tokens_details?.reasoning_tokens !== undefined
            ? { reasoningOutputTokens: parsedBody.usage.completion_tokens_details.reasoning_tokens }
            : {}),
          costUsd,
          latencyMs: totalLatency,
          attempts,
          mode: "openrouter",
        };
      } catch (error) {
        if (error instanceof AdapterError) {
          const failedLatencyMs = Math.max(0, Math.round(performance.now() - transportStarted));
          if (!transportCompleted) {
            totalLatency += failedLatencyMs;
          }
          // Transport-level timeouts/network failures were never settled inline.
          if (
            reservation &&
            (error.code === "AI_TIMEOUT" ||
              error.code === "AI_TRANSPORT_FAILED" ||
              error.code === "AI_ABORTED")
          ) {
            await markUnknownOnce(reservation.callId, error.code, failedLatencyMs);
          }
          if (!error.retryable || attempt >= maxAttempts) {
            throw error;
          }
          lastError = error;
          continue;
        }
        throw new AdapterError(
          "AI_TRANSPORT_FAILED",
          error instanceof Error ? error.message : "unknown transport failure",
          false,
        );
      }
    }

    throw (
      lastError ??
      new AdapterError("AI_TRANSPORT_FAILED", "the AI request exhausted its attempts", false)
    );
  }
}

function usageCost(usage: ChatResponse["usage"]): string | undefined {
  const value = usage?.cost;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return formatUsd(BigInt(Math.ceil(value * 1e9)));
  }
  if (typeof value === "string") {
    try {
      return formatUsd(parseUsd(value));
    } catch {
      return undefined;
    }
  }
  return undefined;
}
