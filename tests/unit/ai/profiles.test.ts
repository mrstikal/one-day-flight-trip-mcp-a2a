import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RoleProfile, RoleProfiles } from "@odft/contracts";
import {
  AdapterError,
  AiConfigError,
  assertModelCapable,
  assertProfileWithinCeiling,
  loadRoleProfiles,
  normalizeEndpointEntry,
  ROLE_DEFAULT_LIMITS,
  stampPricingVersion,
  type CapabilityManifest,
} from "@odft/ai";

/** T-UT-AI-02: model/profile capability and pricing failures fail closed. */

function profile(overrides: Partial<RoleProfile> = {}): RoleProfile {
  return {
    provider: "openrouter",
    model: "openai/gpt-demo",
    reasoningEffort: "low",
    temperature: 0,
    timeoutMs: 20_000,
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

function manifest(overrides: Partial<RoleProfile> = {}): CapabilityManifest {
  const entry = profile(overrides);
  return {
    fetchedAt: new Date().toISOString(),
    pricingVersion: "v1",
    models: {
      [entry.model]: {
        model: entry.model,
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

describe("model capability and pricing (T-UT-AI-02)", () => {
  it("accepts a capable, correctly priced profile", () => {
    expect(() => assertModelCapable(profile(), manifest())).not.toThrow();
  });

  it("refuses an unknown model", () => {
    expect(() => assertModelCapable(profile({ model: "ghost/model" }), manifest())).toThrow(
      AdapterError,
    );
  });

  it("refuses an endpoint outside the allowed provider list", () => {
    expect(() =>
      assertModelCapable(profile({ allowedEndpointProviderIds: ["anthropic"] }), manifest()),
    ).toThrow(/no endpoint from the allowed providers/);
  });

  it("refuses an endpoint without verified structured-output support", () => {
    const base = manifest();
    const entry = base.models["openai/gpt-demo"];
    if (entry?.endpoints[0]) {
      entry.endpoints[0].supportsStructuredOutputs = false;
    }
    expect(() => assertModelCapable(profile(), base)).toThrow(/structured outputs/);
  });

  it("refuses a configured temperature no verified endpoint publishes", () => {
    const base = manifest();
    const entry = base.models["openai/gpt-demo"];
    if (entry?.endpoints[0]) {
      entry.endpoints[0].supportsTemperature = false;
    }
    expect(() => assertModelCapable(profile(), base)).toThrow(
      /does not publish a temperature parameter/,
    );
    // The same manifest accepts a profile that does not pin a temperature.
    expect(() => assertModelCapable(profile({ temperature: undefined }), base)).not.toThrow();
  });

  it("refuses stale pricing versions and underpriced profiles", () => {
    const stale = manifest();
    const entry = stale.models["openai/gpt-demo"];
    if (entry?.endpoints[0]) {
      entry.endpoints[0].pricingVersion = "v2";
    }
    expect(() => assertModelCapable(profile(), stale)).toThrow(/pricing version/);

    expect(() =>
      assertModelCapable(profile({ inputPriceUsdPerMillion: "0.5" }), manifest()),
    ).toThrow(/configure at least 1/);
  });

  it("covers provider variants of an allowed base slug (P2-10)", () => {
    const variantManifest: CapabilityManifest = {
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
            {
              // Routing may pick this variant of the allowed base slug, so its
              // rates must be included in the verified worst case.
              providerId: "openai/turbo",
              supportsStructuredOutputs: true,
              supportsReasoning: true,
              supportsTemperature: true,
              inputPriceUsdPerMillion: "3",
              outputPriceUsdPerMillion: "4",
              requestPriceUsd: "0",
              pricingVersion: "v1",
            },
          ],
        },
      },
    };
    const check = assertModelCapable(
      profile({
        allowedEndpointProviderIds: ["openai"],
        inputPriceUsdPerMillion: "3",
        outputPriceUsdPerMillion: "4",
      }),
      variantManifest,
    );
    expect(check.endpoints.map((endpoint) => endpoint.providerId)).toEqual(["openai", "openai/turbo"]);
    expect(check.worstInputPriceUsdPerMillion).toBe("3");
    expect(check.worstOutputPriceUsdPerMillion).toBe("4");
    // A profile that only covers the base rate is refused (would under-reserve).
    expect(() =>
      assertModelCapable(profile({ allowedEndpointProviderIds: ["openai"] }), variantManifest),
    ).toThrow(/configure at least 3/);
  });

  it("names the available provider slugs when the allowlist does not match", () => {
    expect(() =>
      assertModelCapable(profile({ allowedEndpointProviderIds: ["nonexistent"] }), manifest()),
    ).toThrow(/available: openai/);
  });

  it("refuses a profile whose worst-case call exceeds its ceiling", () => {
    expect(() =>
      assertProfileWithinCeiling(
        profile({ maxCallCostUsd: "0.000001", outputPriceUsdPerMillion: "1000" }),
      ),
    ).toThrow(/exceeds its ceiling/);
  });

  it("normalizes per-endpoint capability with the real provider slug and additive worst case", () => {
    const entry = normalizeEndpointEntry(
      "meta-llama/llama-demo",
      {
        data: {
          id: "meta-llama/llama-demo",
          endpoints: [
            {
              name: "DeepInfra | llama",
              provider_name: "DeepInfra",
              tag: "deepinfra",
              pricing: {
                prompt: "0.000001",
                completion: "0.000002",
                request: "0",
                input_cache_read: "0.0000005",
                input_cache_write: "0.0000015",
                internal_reasoning: "0.0000005",
                web_search: "0",
              },
              supported_parameters: ["response_format", "reasoning"],
            },
            {
              name: "No pricing",
              provider_name: "Nobody",
              supported_parameters: ["response_format"],
            },
          ],
        },
      },
      "v1",
    );
    expect(entry?.endpoints).toHaveLength(1);
    const endpoint = entry?.endpoints[0];
    // Provider slug is the endpoint tag, never the model author prefix.
    expect(endpoint?.providerId).toBe("deepinfra");
    // prompt 1 + max(cache read 0.5, cache write 1.5) = 2.5 USD/M; completion 2 + reasoning 0.5 = 2.5.
    expect(endpoint?.inputPriceUsdPerMillion).toBe("2.5");
    expect(endpoint?.outputPriceUsdPerMillion).toBe("2.5");
    expect(endpoint?.supportsStructuredOutputs).toBe(true);
    expect(endpoint?.pricingVersion).toBe("v1");
  });

  it("takes the maximum across conditional pricing overrides and bills web_search per request", () => {
    const entry = normalizeEndpointEntry(
      "google/gemini-demo:online",
      {
        data: {
          endpoints: [
            {
              name: "Google | gemini",
              tag: "google-vertex",
              pricing: {
                prompt: "0.000001",
                completion: "0.000002",
                request: "0",
                web_search: "0.014",
                overrides: [
                  { min_prompt_tokens: 128000, prompt: "0.000005", completion: "0.00002" },
                ],
              },
              supported_parameters: ["structured_outputs"],
            },
          ],
        },
      },
      "v2",
    );
    const endpoint = entry?.endpoints[0];
    // Override maxima win: 5 USD/M input, 20 USD/M output.
    expect(endpoint?.inputPriceUsdPerMillion).toBe("5");
    expect(endpoint?.outputPriceUsdPerMillion).toBe("20");
    // web_search is per search, not per token: it joins the per-request component.
    expect(endpoint?.requestPriceUsd).toBe("0.014");
  });

  it("fails closed when a present pricing component is malformed", () => {
    expect(
      normalizeEndpointEntry(
        "openai/gpt-demo",
        {
          data: {
            endpoints: [
              {
                tag: "openai",
                pricing: { prompt: "0.000001", completion: "0.000002", request: "not-a-number" },
                supported_parameters: ["structured_outputs"],
              },
            ],
          },
        },
        "v1",
      ),
    ).toBeUndefined();
  });

  it("omits a model whose endpoints carry no usable pricing", () => {
    expect(
      normalizeEndpointEntry("openai/gpt-demo", { data: { endpoints: [] } }, "v1"),
    ).toBeUndefined();
  });
});

describe("pricing version stamping", () => {
  it("stamps the manifest version into every role and reports the change", () => {
    const profiles: RoleProfiles = {
      intent: profile(),
      recommendation: profile(),
      planner: profile(),
      reviewer: profile(),
    };
    const first = stampPricingVersion(profiles, "2026-10-11T00:00:00.000Z");
    expect(first.changed).toBe(true);
    expect(first.profiles.intent.pricingVersion).toBe("2026-10-11T00:00:00.000Z");
    expect(first.profiles.reviewer.pricingVersion).toBe("2026-10-11T00:00:00.000Z");
    // Stamping is idempotent: a second pass with the same version changes nothing.
    const second = stampPricingVersion(first.profiles, "2026-10-11T00:00:00.000Z");
    expect(second.changed).toBe(false);
    expect(second.profiles).toEqual(first.profiles);
  });

  it("accepts the committed example profile file", () => {
    const loaded = loadRoleProfiles({
      mode: "openrouter",
      configPath: new URL("../../../ai-profiles.example.json", import.meta.url).pathname,
    });
    expect(loaded.profiles?.planner.maxOutputTokens).toBe(6_144);
    expect(loaded.profiles?.planner.reasoningEffort).toBe("low");
    expect(loaded.profiles?.intent.allowedEndpointProviderIds).toEqual(["openai"]);
  });
});

describe("role profile loading", () => {
  it("needs no profiles in fixture mode", () => {
    expect(loadRoleProfiles({ mode: "fixture" })).toEqual({ mode: "fixture" });
  });

  it("fails with an actionable error when the config path is missing", () => {
    expect(() => loadRoleProfiles({ mode: "openrouter" })).toThrow(AiConfigError);
  });

  it("loads and validates a complete profile file", () => {
    const dir = mkdtempSync(join(tmpdir(), "odft-ai-"));
    const path = join(dir, "profiles.json");
    const profiles: RoleProfiles = {
      intent: profile(),
      recommendation: profile(),
      planner: profile({ timeoutMs: 30_000, maxOutputTokens: 2_048, maxCallCostUsd: "0.20" }),
      reviewer: profile(),
    };
    writeFileSync(path, JSON.stringify(profiles), "utf8");
    const loaded = loadRoleProfiles({ mode: "openrouter", configPath: path });
    expect(loaded.profiles?.intent.model).toBe("openai/gpt-demo");
  });

  it("rejects profiles that exceed the per-role attempt bound", () => {
    const dir = mkdtempSync(join(tmpdir(), "odft-ai-"));
    const path = join(dir, "profiles.json");
    const profiles = {
      intent: { ...profile(), maxAttempts: 3 },
      recommendation: profile(),
      planner: profile(),
      reviewer: profile(),
    };
    writeFileSync(path, JSON.stringify(profiles), "utf8");
    expect(() => loadRoleProfiles({ mode: "openrouter", configPath: path })).toThrow(AiConfigError);
    expect(ROLE_DEFAULT_LIMITS.intent.maxAttempts).toBe(2);
  });
});
