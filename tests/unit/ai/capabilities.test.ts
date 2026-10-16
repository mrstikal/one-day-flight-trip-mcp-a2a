import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AdapterError,
  loadCapabilityManifest,
  OPENROUTER_MODELS_URL,
  type CapabilityFetch,
  type CapabilityManifest,
} from "@odft/ai";

/**
 * Capability-manifest loading fails closed without network access and never
 * writes a new `pricingVersion` unless a fetch implementation is supplied, so an
 * automatic refresh can never invalidate the operator-stamped profile pins.
 */

const FETCHED_AT = "2026-10-15T10:00:00.000Z";

function manifest(overrides: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return {
    fetchedAt: FETCHED_AT,
    pricingVersion: FETCHED_AT,
    models: {
      "openai/gpt-demo": {
        model: "openai/gpt-demo",
        endpoints: [
          {
            providerId: "openai",
            supportsStructuredOutputs: true,
            supportsReasoning: true,
            inputPriceUsdPerMillion: "1",
            outputPriceUsdPerMillion: "2",
            requestPriceUsd: "0",
            pricingVersion: FETCHED_AT,
          },
        ],
      },
    },
    ...overrides,
  };
}

function cacheDir(): string {
  return mkdtempSync(join(tmpdir(), "odft-ai-cap-"));
}

function writeCache(dir: string, value: unknown): string {
  const path = join(dir, "profiles.json.capabilities.json");
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
}

const endpointPayload = {
  data: {
    endpoints: [
      {
        tag: "openai",
        supported_parameters: ["structured_outputs", "reasoning", "temperature"],
        pricing: { prompt: "0.0000004", completion: "0.0000008", request: "0" },
      },
    ],
  },
};

describe("capability manifest loading", () => {
  it("returns a fresh covering cache without touching the network", async () => {
    const cachePath = writeCache(cacheDir(), manifest());
    const loaded = await loadCapabilityManifest({
      cachePath,
      models: ["openai/gpt-demo"],
      now: new Date("2026-10-15T12:00:00.000Z"),
    });
    expect(loaded.pricingVersion).toBe(FETCHED_AT);
  });

  it("does not fetch a fresh cache even when a fetch implementation is supplied", async () => {
    const cachePath = writeCache(cacheDir(), manifest());
    let calls = 0;
    const loaded = await loadCapabilityManifest({
      cachePath,
      models: ["openai/gpt-demo"],
      now: new Date("2026-10-15T12:00:00.000Z"),
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, status: 200, json: async () => endpointPayload };
      },
    });
    expect(loaded.pricingVersion).toBe(FETCHED_AT);
    expect(calls).toBe(0);
  });

  it("fails closed with an actionable error when the cache is stale and refresh is not allowed", async () => {
    const cachePath = writeCache(cacheDir(), manifest());
    const error = await loadCapabilityManifest({
      cachePath,
      models: ["openai/gpt-demo"],
      now: new Date("2026-10-16T11:00:00.000Z"),
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("AI_CAPABILITY_UNKNOWN");
    expect((error as AdapterError).message).toMatch(/stale \(fetched 2026-10-15T10:00:00\.000Z\)/);
    expect((error as AdapterError).message).toMatch(/npm run ai:validate-models/);
  });

  it("fails closed with an actionable error when the cache does not cover a configured model", async () => {
    const cachePath = writeCache(cacheDir(), manifest());
    const error = await loadCapabilityManifest({
      cachePath,
      models: ["openai/gpt-demo", "openai/gpt-other"],
      now: new Date("2026-10-15T12:00:00.000Z"),
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).message).toMatch(/does not cover configured model\(s\) openai\/gpt-other/);
    expect((error as AdapterError).message).toMatch(/npm run ai:validate-models/);
  });

  it("fails closed with an actionable error when the cache is missing or unreadable", async () => {
    const dir = cacheDir();
    const missing = await loadCapabilityManifest({
      cachePath: join(dir, "absent.json"),
      models: ["openai/gpt-demo"],
    }).catch((thrown: unknown) => thrown);
    expect((missing as AdapterError).code).toBe("AI_CAPABILITY_UNKNOWN");
    expect((missing as AdapterError).message).toMatch(/no cached capability manifest/);
    expect((missing as AdapterError).message).toMatch(/npm run ai:validate-models/);

    const corruptPath = writeCache(dir, { not: "a manifest" });
    const corrupt = await loadCapabilityManifest({
      cachePath: corruptPath,
      models: ["openai/gpt-demo"],
    }).catch((thrown: unknown) => thrown);
    expect((corrupt as AdapterError).message).toMatch(/no cached capability manifest/);
  });

  it("refreshes and writes a new manifest only when a fetch implementation is supplied", async () => {
    const dir = cacheDir();
    const cachePath = writeCache(dir, manifest());
    const now = new Date("2026-10-16T12:00:00.000Z");
    const fetched: string[] = [];
    const fetchImpl: CapabilityFetch = async (url) => {
      fetched.push(url);
      return { ok: true, status: 200, json: async () => endpointPayload };
    };
    const loaded = await loadCapabilityManifest({
      cachePath,
      models: ["openai/gpt-demo"],
      now,
      fetchImpl,
    });
    expect(fetched).toEqual([`${OPENROUTER_MODELS_URL}/openai/gpt-demo/endpoints`]);
    expect(loaded.pricingVersion).toBe(now.toISOString());
    expect(loaded.models["openai/gpt-demo"]?.endpoints[0]?.inputPriceUsdPerMillion).toBe("0.4");
    expect(loaded.models["openai/gpt-demo"]?.endpoints[0]?.supportsTemperature).toBe(true);
    const rewritten = JSON.parse(readFileSync(cachePath, "utf8")) as CapabilityManifest;
    expect(rewritten.pricingVersion).toBe(now.toISOString());
  });
});
