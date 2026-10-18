import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdapterError,
  flightRecommendationContextSchema,
  recommendationOutputSchema,
  type CapabilityManifest,
} from "@odft/ai";
import type { RoleProfiles } from "@odft/contracts";
import { parseServerConfig } from "@odft/persistence";
import { loadDelegatedRankingDeps } from "../../../apps/flight-agent/src/ai.js";
import type { FlightAgentConfig } from "../../../apps/flight-agent/src/config.js";

/**
 * Phase 05 wiring: the flight agent's delegated paid path must reserve exactly
 * one billable transport attempt per delegated reservation (the adapter's
 * internal retry loop is disabled) and must load profile + capability manifest
 * at startup, failing closed otherwise.
 */

const MODEL = "openai/gpt-demo";

function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "openrouter",
    model: MODEL,
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
    ...overrides,
  };
}

function writeConfig(): { dir: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "odft-flight-agent-ai-"));
  const configPath = join(dir, "ai-profiles.json");
  const profiles: RoleProfiles = {
    intent: profile(),
    recommendation: profile(),
    planner: profile(),
    reviewer: profile(),
  } as RoleProfiles;
  writeFileSync(configPath, JSON.stringify(profiles), "utf8");
  const manifest: CapabilityManifest = {
    fetchedAt: new Date().toISOString(),
    pricingVersion: "v1",
    models: {
      [MODEL]: {
        model: MODEL,
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
  writeFileSync(`${configPath}.capabilities.json`, JSON.stringify(manifest), "utf8");
  return { dir, configPath };
}

function flightContext() {
  return flightRecommendationContextSchema.parse({
    role: "recommendation",
    tradeoff: "cheapest party total against total travel time",
    target: "flights",
    baselineOfferId: null,
    candidates: [
      {
        id: "combo-a",
        partyTotalMinor: 30_000,
        perAdultMinor: 15_000,
        totalDurationMinutes: 300,
        stops: 0,
        outboundDeparture: "2026-12-01T06:00:00Z",
        outboundArrival: "2026-12-01T08:00:00Z",
        inboundDeparture: "2026-12-03T18:00:00Z",
        inboundArrival: "2026-12-03T20:00:00Z",
        supportedVariants: ["two_nights"],
      },
    ],
  });
}

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function agentConfig(aiConfigPath: string | null): FlightAgentConfig {
  return { aiMode: "openrouter", aiConfigPath } as FlightAgentConfig;
}

describe("flight agent delegated AI wiring", () => {
  it("loads the recommendation profile with a single transport attempt per reservation", async () => {
    const { dir, configPath } = writeConfig();
    dirs.push(dir);
    const deps = await loadDelegatedRankingDeps(
      agentConfig(configPath),
      parseServerConfig({
        DATABASE_URL: "postgres://user:pass@127.0.0.1:5442/odft",
        PUBLIC_BASE_URL: "http://localhost:3000",
        SESSION_HMAC_KEY: "unit-test-session-hmac-key-0123456789",
        AI_MODE: "openrouter",
        AI_CONFIG_PATH: configPath,
        OPENROUTER_API_KEY: "sk-unit-test",
      }),
    );
    expect(deps.paidAdapter).toBeDefined();
    expect(deps.paidProfile?.model).toBe(MODEL);
    // The ledger counts reservations: the adapter must not retry internally.
    expect(deps.paidProfile?.maxAttempts).toBe(1);
  });

  it("performs exactly one billable transport attempt per reservation", async () => {
    const { dir, configPath } = writeConfig();
    dirs.push(dir);
    const deps = await loadDelegatedRankingDeps(
      agentConfig(configPath),
      parseServerConfig({
        DATABASE_URL: "postgres://user:pass@127.0.0.1:5442/odft",
        PUBLIC_BASE_URL: "http://localhost:3000",
        SESSION_HMAC_KEY: "unit-test-session-hmac-key-0123456789",
        AI_MODE: "openrouter",
        AI_CONFIG_PATH: configPath,
        OPENROUTER_API_KEY: "sk-unit-test",
      }),
    );
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 503, message: "unavailable" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    // The source profile allows two attempts; the delegated path must send once.
    const failure = await deps.paidAdapter
      ?.generateObject({
        role: "recommendation",
        promptVersion: "recommendation-v2",
        operationId: "task-1",
        effectScope: "recommendation:1",
        systemPrompt: "rank the flights",
        context: flightContext(),
        outputSchema: recommendationOutputSchema,
        signal: new AbortController().signal,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(AdapterError);
    expect(failure).toMatchObject({ code: "AI_TRANSPORT_FAILED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns no paid deps in fixture mode", async () => {
    const deps = await loadDelegatedRankingDeps(
      { aiMode: "fixture", aiConfigPath: null } as FlightAgentConfig,
      parseServerConfig({
        DATABASE_URL: "postgres://user:pass@127.0.0.1:5442/odft",
        PUBLIC_BASE_URL: "http://localhost:3000",
        SESSION_HMAC_KEY: "unit-test-session-hmac-key-0123456789",
      }),
    );
    expect(deps.paidAdapter).toBeUndefined();
    expect(deps.paidProfile).toBeUndefined();
  });

  it("fails closed when the profile config is missing", async () => {
    await expect(
      loadDelegatedRankingDeps(
        agentConfig("/nonexistent/ai-profiles.json"),
        parseServerConfig({
          DATABASE_URL: "postgres://user:pass@127.0.0.1:5442/odft",
          PUBLIC_BASE_URL: "http://localhost:3000",
          SESSION_HMAC_KEY: "unit-test-session-hmac-key-0123456789",
          AI_MODE: "openrouter",
          OPENROUTER_API_KEY: "sk-unit-test",
        }),
      ),
    ).rejects.toThrow(/AI_CONFIG_PATH|not found/i);
  });
});
