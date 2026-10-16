import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEFAULT_TRIP_PREFERENCES, type RoleProfiles } from "@odft/contracts";
import {
  AdapterError,
  intentContextSchema,
  OpenRouterAdapter,
  type AdapterUsage,
  type CapabilityManifest,
  type IntentContext,
} from "@odft/ai";

/**
 * T-UT-AI-02 (transport): strict structured requests, verified endpoint
 * allowlist with fallback disabled, reasoning exclusion, at most one
 * repair/retry, and fail-closed capability checks before any billable call.
 */

const outputSchema = z.object({ value: z.string().min(1) }).strict();

function profiles(): RoleProfiles {
  const profile = {
    provider: "openrouter" as const,
    model: "openai/gpt-demo",
    reasoningEffort: "low" as const,
    temperature: 0,
    timeoutMs: 5_000,
    maxInputTokens: 6_000,
    maxOutputTokens: 1_024,
    maxAttempts: 2,
    maxCallCostUsd: "0.05",
    inputPriceUsdPerMillion: "1",
    outputPriceUsdPerMillion: "2",
    requestPriceUsd: "0",
    pricingVersion: "v1",
    allowedEndpointProviderIds: ["openai"],
  };
  return { intent: profile, recommendation: profile, planner: profile, reviewer: profile };
}

function manifest(): CapabilityManifest {
  return {
    fetchedAt: new Date().toISOString(),
    pricingVersion: "v1",
    models: {
      "openai/gpt-demo": {
        model: "openai/gpt-demo",
        endpoints: [
          {
            providerId: "openai",
            supportsStructuredOutputs: true,
            supportsReasoning: true,
            supportsTemperature: true,
            inputPriceUsdPerMillion: "1",
            outputPriceUsdPerMillion: "2",
            requestPriceUsd: "0",
            pricingVersion: "v1",
          },
        ],
      },
    },
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function completion(content: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    choices: [
      {
        message: { content: typeof content === "string" ? content : JSON.stringify(content) },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0005 },
    ...extra,
  };
}

function intentContext(): IntentContext {
  return intentContextSchema.parse({
    role: "intent",
    today: "2026-10-11",
    route: {
      originAirportId: "ourairports:1",
      destinationCityId: "geonames:3169070",
      destinationCountryKey: "IT",
      sightseeingDate: "2026-12-01",
      travelVariant: "two_nights",
    },
    message: "Make the day less exhausting",
    userName: "Ada",
    preferences: DEFAULT_TRIP_PREFERENCES,
    selectedServices: [],
    currentActivityCounts: {},
    pendingDecisionKind: null,
    budgetMinor: null,
    recentMessages: [],
    summary: [],
    knownCityIds: [],
    knownAirportIds: [],
    knownOfferIds: [],
  });
}

function request() {
  return {
    role: "intent" as const,
    promptVersion: "intent-v1",
    operationId: "00000000-0000-0000-0000-000000000001",
    effectScope: "intent",
    systemPrompt: "system prompt",
    context: intentContext(),
    outputSchema,
    signal: new AbortController().signal,
  };
}

function governor() {
  const reservations: string[] = [];
  const settled: { callId: string; usage: AdapterUsage }[] = [];
  const unknown: string[] = [];
  const unknownTimings: { callId: string; reason: string; latencyMs: number }[] = [];
  let next = 0;
  return {
    reservations,
    settled,
    unknown,
    unknownTimings,
    governor: {
      reserve: async () => {
        next += 1;
        const callId = `call-${next}`;
        reservations.push(callId);
        return { callId };
      },
      settle: async (callId: string, usage: AdapterUsage) => {
        settled.push({ callId, usage });
      },
      markUnknown: async (callId: string, reason: string, latencyMs: number) => {
        unknown.push(callId);
        unknownTimings.push({ callId, reason, latencyMs });
      },
    },
  };
}

describe("OpenRouter adapter transport", () => {
  it("sends a strict structured request with the verified endpoint allowlist", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      response(completion({ result: { value: "ok" } })),
    );
    const adapter = new OpenRouterAdapter({
      apiKey: "secret",
      manifest: manifest(),
      profiles: profiles(),
      fetchImpl: fetchImpl as never,
    });
    const result = await adapter.generateObject(request());
    expect(result.value).toEqual({ value: "ok" });
    expect(result.mode).toBe("openrouter");
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.model).toBe("openai/gpt-demo");
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { strict: true },
    });
    expect(body.provider).toMatchObject({
      require_parameters: true,
      only: ["openai"],
      allow_fallbacks: false,
    });
    expect(body.reasoning).toEqual({ effort: "low", exclude: true });
  });

  it("refuses unknown capability before any transport (no billable call)", async () => {
    const fetchImpl = vi.fn(async () => response(completion({ result: { value: "ok" } })));
    const adapter = new OpenRouterAdapter({
      apiKey: "secret",
      manifest: { ...manifest(), models: {} },
      profiles: profiles(),
      fetchImpl: fetchImpl as never,
    });
    await expect(
      adapter.generateObject(request()),
    ).rejects.toBeInstanceOf(AdapterError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("repairs one schema-invalid response within two total attempts", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(completion({ result: { wrong: true } })))
      .mockResolvedValueOnce(response(completion({ result: { value: "fixed" } })));
    const g = governor();
    const adapter = new OpenRouterAdapter({
      apiKey: "secret",
      manifest: manifest(),
      profiles: profiles(),
      governor: g.governor,
      fetchImpl: fetchImpl as never,
    });
    const result = await adapter.generateObject(request());
    expect(result.value).toEqual({ value: "fixed" });
    expect(result.attempts).toBe(2);
    expect(g.reservations).toEqual(["call-1", "call-2"]);
    expect(g.settled.map((entry) => entry.usage.validationStatus)).toEqual(["invalid", "valid"]);
  });

  it("retries once on 429 and settles each attempt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response({ error: { message: "rate limited" } }, 429))
      .mockResolvedValueOnce(response(completion({ result: { value: "ok" } })));
    const g = governor();
    const adapter = new OpenRouterAdapter({
      apiKey: "secret",
      manifest: manifest(),
      profiles: profiles(),
      governor: g.governor,
      fetchImpl: fetchImpl as never,
    });
    const result = await adapter.generateObject(request());
    expect(result.attempts).toBe(2);
    expect(g.unknown).toEqual(["call-1"]);
    expect(g.reservations).toHaveLength(2);
  });

  it("fails fast on an auth error without a retry", async () => {
    const fetchImpl = vi.fn(async () => response({ error: { message: "bad key" } }, 401));
    const adapter = new OpenRouterAdapter({
      apiKey: "secret",
      manifest: manifest(),
      profiles: profiles(),
      fetchImpl: fetchImpl as never,
    });
    await expect(adapter.generateObject(request())).rejects.toMatchObject({
      code: "AI_AUTH_FAILED",
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("records a full-response timeout and includes it in retry latency without releasing its charge", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const g = governor();
      let calls = 0;
      const fetchImpl: typeof fetch = async (_url, init) => {
        calls += 1;
        if (calls === 1) {
          return new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener("abort", () =>
                  controller.error(new Error("stalled body")),
                );
              },
            }),
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
        return response(completion({ result: { value: "ok" } }));
      };
      const adapter = new OpenRouterAdapter({
        apiKey: "secret",
        manifest: manifest(),
        profiles: profiles(),
        governor: g.governor,
        fetchImpl,
      });
      const pending = adapter.generateObject(request());
      await vi.advanceTimersByTimeAsync(5_120);
      const result = await pending;
      expect(result.latencyMs).toBe(5_120);
      expect(g.unknownTimings).toEqual([
        { callId: "call-1", reason: "AI_TIMEOUT", latencyMs: 5_000 },
      ]);
      expect(g.settled).toHaveLength(1);
      expect(g.settled[0]?.usage).toMatchObject({ validationStatus: "valid", latencyMs: 120 });
      expect(g.reservations).toEqual(["call-1", "call-2"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records elapsed time for a network failure and a worker shutdown abort", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      for (const aborted of [false, true]) {
        const controller = new AbortController();
        const g = governor();
        const configured = profiles();
        configured.intent.maxAttempts = 1;
        const adapter = new OpenRouterAdapter({
          apiKey: "secret",
          manifest: manifest(),
          profiles: configured,
          governor: g.governor,
          fetchImpl: async () => {
            await new Promise((resolve) => setTimeout(resolve, 250));
            if (aborted) controller.abort(new Error("shutdown"));
            throw new Error("network disconnected");
          },
        });
        const pending = expect(
          adapter.generateObject({ ...request(), signal: controller.signal }),
        ).rejects.toMatchObject({ code: aborted ? "AI_ABORTED" : "AI_TRANSPORT_FAILED" });
        await vi.advanceTimersByTimeAsync(250);
        await pending;
        expect(g.unknownTimings[0]).toMatchObject({
          latencyMs: 250,
          reason: aborted ? "AI_ABORTED" : "AI_TRANSPORT_FAILED",
        });
        expect(g.settled).toEqual([]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies a shutdown abort as AI_ABORTED even when the error is not an AbortError (P2-13)", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort(new Error("worker shutdown"));
      // Node fetch may reject with the abort reason, not a named AbortError.
      throw new Error("worker shutdown");
    });
    const adapter = new OpenRouterAdapter({
      apiKey: "secret",
      manifest: manifest(),
      profiles: profiles(),
      fetchImpl: fetchImpl as never,
    });
    await expect(
      adapter.generateObject({ ...request(), signal: controller.signal }),
    ).rejects.toMatchObject({ code: "AI_ABORTED", retryable: false });
  });

  it("discards reasoning fields from the response", async () => {
    const fetchImpl = vi.fn(async () =>
      response(
        completion(
          { result: { value: "ok" } },
          {
            choices: [
              {
                message: {
                  content: JSON.stringify({ result: { value: "ok" } }),
                  reasoning: "hidden chain of thought",
                  reasoning_details: [{ text: "secret" }],
                },
                finish_reason: "stop",
              },
            ],
          },
        ),
      ),
    );
    const adapter = new OpenRouterAdapter({
      apiKey: "secret",
      manifest: manifest(),
      profiles: profiles(),
      fetchImpl: fetchImpl as never,
    });
    const result = await adapter.generateObject(request());
    expect(JSON.stringify(result)).not.toContain("chain of thought");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
