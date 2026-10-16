import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { voiceProfilesFileSchema, type VoiceProfilesFile } from "@odft/contracts";
import {
  assertDocumentedSpeechDefaults,
  assertSpeechCapable,
  assertSpeechManifestFresh,
  billedAudioSeconds,
  billedCharacters,
  ceilExactToInteger,
  compareExactDecimals,
  costNanos,
  formatUsd,
  loadSpeechCapabilityManifest,
  maxExactDecimal,
  normalizeSpeechCapability,
  parseExactDecimal,
  refreshSpeechCapabilityManifest,
  reserveSttCostNanos,
  reserveTtsCostNanos,
  revalidateSpeechTariffs,
  SpeechError,
  speechCapabilityManifestSchema,
  type SpeechCapabilityFetch,
  type SpeechCapabilityManifest,
  type SpeechTariff,
} from "@odft/ai";

/**
 * T-UT-VOICE-02/03 (VOICE_CONTROLL.md section 15): unit-aware speech
 * capabilities that never require structured JSON output, fail closed on
 * wrong model/modality/provider/pricing, parse more-than-nine-decimal tariffs
 * exactly, honor documented minimums and fees, and round upward to USD nanos.
 */

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const EXAMPLE_PATH = `${repoRoot}voice-profiles.example.json`;
const WHISPER = "openai/whisper-large-v3-turbo";
const ELEVEN = "elevenlabs/eleven-v4-turbo";
const PRICING_VERSION = "2026-10-14T12:00:00.000Z";
const FETCH_NOW = new Date("2026-10-14T12:05:00.000Z");

function whisperPayload(): unknown {
  return {
    data: {
      id: WHISPER,
      architecture: { modality: "audio->transcription" },
      endpoints: [
        {
          tag: "deepinfra/us",
          provider_name: "DeepInfra",
          pricing: { prompt: "0.00000333", completion: "0", discount: 0 },
        },
        {
          tag: "groq",
          provider_name: "Groq",
          pricing: { prompt: "0.0000111111111111", completion: "0", discount: 0 },
        },
      ],
    },
  };
}

function elevenPayload(): unknown {
  return {
    data: {
      id: ELEVEN,
      architecture: { modality: "text->speech" },
      endpoints: [
        {
          tag: "elevenlabs",
          provider_name: "ElevenLabs",
          pricing: { prompt: "0.00002", completion: "0", discount: 0.5 },
        },
      ],
    },
  };
}

function payloadWithSttPricing(pricing: Record<string, unknown>): unknown {
  return {
    data: {
      id: WHISPER,
      architecture: { modality: "audio->transcription" },
      endpoints: [{ tag: "groq", provider_name: "Groq", pricing }],
    },
  };
}

function normalizeStt(payload: unknown) {
  return normalizeSpeechCapability({
    kind: "stt",
    model: WHISPER,
    endpointProviderId: "groq",
    payload,
  });
}

function normalizeTts(payload: unknown) {
  return normalizeSpeechCapability({ kind: "tts", model: ELEVEN, payload });
}

function buildManifest(): SpeechCapabilityManifest {
  const stt = normalizeStt(whisperPayload());
  const tts = normalizeTts(elevenPayload());
  if (!stt || !tts) {
    throw new Error("fixture catalog must normalize");
  }
  return speechCapabilityManifestSchema.parse({
    fetchedAt: "2026-10-14T12:00:00.000Z",
    pricingVersion: PRICING_VERSION,
    stt,
    tts,
  });
}

function exampleProfiles(pricingVersion: string = PRICING_VERSION): VoiceProfilesFile {
  const raw = JSON.parse(readFileSync(EXAMPLE_PATH, "utf8")) as Record<string, unknown>;
  return voiceProfilesFileSchema.parse({ ...raw, pricingVersion });
}

const fetchStub: SpeechCapabilityFetch = async (url) => {
  if (url.includes(WHISPER)) {
    return { ok: true, status: 200, json: async () => whisperPayload() };
  }
  return { ok: true, status: 200, json: async () => elevenPayload() };
};

function withTempCache<T>(fn: (cachePath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "voice-capabilities-"));
  try {
    return fn(join(dir, "voice-profiles.json.capabilities.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("exact decimal arithmetic", () => {
  it("parses more-than-nine-decimal tariffs as exact rationals", () => {
    const exact = parseExactDecimal("0.0000111111111111", "rate");
    expect(exact.numerator).toBe(111_111_111_111n);
    expect(exact.denominator).toBe(10_000_000_000_000_000n);
    expect(() => parseExactDecimal("1e-5", "rate")).toThrow(SpeechError);
    expect(() => parseExactDecimal("-1", "rate")).toThrow(SpeechError);
  });

  it("compares and picks worst-case variants exactly", () => {
    expect(compareExactDecimals("0.5", "0.50")).toBe(0);
    expect(compareExactDecimals("0.00001", "0.00002")).toBe(-1);
    expect(maxExactDecimal("0.00001", "0.00002")).toBe("0.00002");
  });

  it("rounds the final reservation upward to USD nanos", () => {
    expect(costNanos("0.0000000004", 1)).toBe(1n);
    expect(costNanos("0.0000000001", 3)).toBe(1n);
    expect(formatUsd(costNanos("0.0000000001", 3))).toBe("0.000000001");
    expect(formatUsd(costNanos("0.00002", 2000))).toBe("0.04");
  });

  it("ceils fractional minimums conservatively", () => {
    expect(ceilExactToInteger("10", "minimum")).toBe(10);
    expect(ceilExactToInteger("10.0000000001", "minimum")).toBe(11);
  });
});

describe("billed units", () => {
  it("bills whole audio seconds, at least one", () => {
    expect(billedAudioSeconds(16_000)).toBe(1);
    expect(billedAudioSeconds(16_001)).toBe(2);
    expect(billedAudioSeconds(1)).toBe(1);
  });

  it("uses UTF-16 length so astral characters are never underestimated", () => {
    expect(billedCharacters("ab")).toBe(2);
    expect(billedCharacters("é")).toBe(1);
    expect(billedCharacters("🙂")).toBe(2);
  });
});

describe("reservations", () => {
  const sttTariff: SpeechTariff = {
    unit: "audio_seconds",
    ratePerUnit: "0.0000111111111111",
    minimumUnits: "10",
    requestFeeUsd: "0",
  };

  it("applies the documented minimum STT duration", () => {
    // 3 recorded seconds bill as the 10-second minimum.
    expect(reserveSttCostNanos(sttTariff, 16_000 * 3)).toBe(111_112n);
    expect(formatUsd(reserveSttCostNanos(sttTariff, 16_000 * 3))).toBe("0.000111112");
  });

  it("bills the full 60 seconds at the worst rate", () => {
    expect(formatUsd(reserveSttCostNanos(sttTariff, 16_000 * 60))).toBe("0.000666667");
  });

  it("adds request fees exactly", () => {
    const withFee: SpeechTariff = { ...sttTariff, requestFeeUsd: "0.0001" };
    expect(reserveSttCostNanos(withFee, 16_000 * 3)).toBe(111_112n + 100_000n);
  });

  it("bills TTS per character including astral characters", () => {
    const ttsTariff: SpeechTariff = {
      unit: "characters",
      ratePerUnit: "0.00002",
      minimumUnits: "0",
      requestFeeUsd: "0",
    };
    expect(reserveTtsCostNanos(ttsTariff, "x".repeat(25))).toBe(500_000n);
    expect(reserveTtsCostNanos(ttsTariff, "🙂")).toBe(40_000n);
    const withMinimum: SpeechTariff = { ...ttsTariff, minimumUnits: "5" };
    expect(reserveTtsCostNanos(withMinimum, "ab")).toBe(100_000n);
  });
});

describe("speech capability normalization", () => {
  it("accepts the documented STT model on exactly the groq endpoint", () => {
    const entry = normalizeStt(whisperPayload());
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      kind: "stt",
      model: WHISPER,
      endpointProviderId: "groq",
      providerName: "Groq",
      modality: "audio->transcription",
      unit: "audio_seconds",
      ratePerUnitUsd: "0.0000111111111111",
      minimumUnits: "10",
      minimumUnitsSource: "documented-provider-evidence",
      requestFeeUsd: "0",
    });
  });

  it("accepts the documented TTS model with its single endpoint and never applies the discount", () => {
    const entry = normalizeTts(elevenPayload());
    expect(entry).toMatchObject({
      kind: "tts",
      model: ELEVEN,
      endpointProviderId: "elevenlabs",
      unit: "characters",
      ratePerUnitUsd: "0.00002",
      publishedDiscount: "0.5",
      minimumUnits: "0",
      minimumUnitsSource: "none-published",
    });
  });

  it("fails closed on wrong model, modality, or endpoint", () => {
    expect(normalizeStt(elevenPayload())).toBeUndefined();
    const wrongModel = {
      data: {
        id: "openai/whisper-other",
        architecture: { modality: "audio->transcription" },
        endpoints: [{ tag: "groq", pricing: { prompt: "0.00001", completion: "0" } }],
      },
    };
    expect(normalizeStt(wrongModel)).toBeUndefined();
    const wrongModality = {
      data: {
        id: WHISPER,
        architecture: { modality: "text->speech" },
        endpoints: [{ tag: "groq", pricing: { prompt: "0.00001", completion: "0" } }],
      },
    };
    expect(normalizeStt(wrongModality)).toBeUndefined();
    const missingTag = {
      data: {
        id: WHISPER,
        architecture: { modality: "audio->transcription" },
        endpoints: [{ tag: "deepinfra/us", pricing: { prompt: "0.00001", completion: "0" } }],
      },
    };
    expect(normalizeStt(missingTag)).toBeUndefined();
  });

  it("fails closed on malformed or unknown pricing components", () => {
    expect(
      normalizeStt(payloadWithSttPricing({ prompt: "1e-5", completion: "0" })),
    ).toBeUndefined();
    expect(
      normalizeStt(payloadWithSttPricing({ prompt: 0.00001, completion: "0" })),
    ).toBeUndefined();
    expect(
      normalizeStt(payloadWithSttPricing({ prompt: "0.00001", completion: "0.001" })),
    ).toBeUndefined();
    expect(
      normalizeStt(payloadWithSttPricing({ prompt: "0.00001", completion: "0", latency: "1" })),
    ).toBeUndefined();
    expect(normalizeStt(payloadWithSttPricing({ completion: "0" }))).toBeUndefined();
  });

  it("takes the worst conditional variant and rejects malformed overrides", () => {
    const withOverrides = normalizeStt(
      payloadWithSttPricing({
        prompt: "0.00001",
        completion: "0",
        overrides: [{ prompt: "0.00003" }],
      }),
    );
    expect(withOverrides?.ratePerUnitUsd).toBe("0.00003");
    expect(
      normalizeStt(
        payloadWithSttPricing({ prompt: "0.00001", completion: "0", overrides: [{ prompt: 5 }] }),
      ),
    ).toBeUndefined();
    expect(
      normalizeStt(
        payloadWithSttPricing({
          prompt: "0.00001",
          completion: "0",
          overrides: [{ prompt: "0.00003", completion: "0.5" }],
        }),
      ),
    ).toBeUndefined();
  });

  it("marks an undocumented minimum provider as unknown", () => {
    const entry = normalizeSpeechCapability({
      kind: "stt",
      model: WHISPER,
      endpointProviderId: "deepinfra/us",
      payload: whisperPayload(),
    });
    expect(entry?.minimumUnitsSource).toBe("unknown");
  });

  it("fails closed on an ambiguous TTS endpoint list", () => {
    const twoEndpoints = {
      data: {
        id: ELEVEN,
        architecture: { modality: "text->speech" },
        endpoints: [
          { tag: "elevenlabs", pricing: { prompt: "0.00002", completion: "0" } },
          { tag: "other", pricing: { prompt: "0.01", completion: "0" } },
        ],
      },
    };
    expect(normalizeTts(twoEndpoints)).toBeUndefined();
  });
});

describe("assertSpeechCapable", () => {
  it("accepts the example profile against the normalized snapshot", () => {
    const manifest = buildManifest();
    const profiles = exampleProfiles();
    const stt = assertSpeechCapable({ profiles, kind: "stt", manifest });
    const tts = assertSpeechCapable({ profiles, kind: "tts", manifest });
    expect(stt.worstCallCostUsd).toBe("0.000666667");
    expect(tts.worstCallCostUsd).toBe("0.04");
    expect(stt.tariff).toEqual({
      unit: "audio_seconds",
      ratePerUnit: "0.0000111111111111",
      minimumUnits: "10",
      requestFeeUsd: "0",
    });
  });

  it("fails closed on model, endpoint, version, unit, minimum, and ceiling mismatches", () => {
    const manifest = buildManifest();
    const base = exampleProfiles();
    const withModel: VoiceProfilesFile = { ...base, stt: { ...base.stt, model: "openai/other" } };
    expect(() => assertSpeechCapable({ profiles: withModel, kind: "stt", manifest })).toThrow(
      SpeechError,
    );

    const withEndpoint: VoiceProfilesFile = {
      ...base,
      stt: { ...base.stt, endpointProviderId: "deepinfra/us" },
    };
    expect(() => assertSpeechCapable({ profiles: withEndpoint, kind: "stt", manifest })).toThrow(
      SpeechError,
    );

    expect(() =>
      assertSpeechCapable({
        profiles: exampleProfiles("2020-01-01T00:00:00.000Z"),
        kind: "stt",
        manifest,
      }),
    ).toThrow(/voice:validate-models/);

    const deepinfra = normalizeSpeechCapability({
      kind: "stt",
      model: WHISPER,
      endpointProviderId: "deepinfra/us",
      payload: whisperPayload(),
    });
    if (!deepinfra) {
      throw new Error("deepinfra fixture must normalize");
    }
    const unknownMinimum: SpeechCapabilityManifest = { ...manifest, stt: deepinfra };
    const deepinfraProfile: VoiceProfilesFile = {
      ...base,
      stt: { ...base.stt, endpointProviderId: "deepinfra/us" },
    };
    expect(() =>
      assertSpeechCapable({ profiles: deepinfraProfile, kind: "stt", manifest: unknownMinimum }),
    ).toThrow(/undocumented/);

    const unitTamper: SpeechCapabilityManifest = {
      ...manifest,
      tts: { ...manifest.tts, unit: "audio_seconds" },
    };
    expect(() =>
      assertSpeechCapable({ profiles: exampleProfiles(), kind: "tts", manifest: unitTamper }),
    ).toThrow(SpeechError);

    const lowCeiling: VoiceProfilesFile = {
      ...base,
      stt: { ...base.stt, maxCallCostUsd: "0.0001" },
    };
    expect(() => assertSpeechCapable({ profiles: lowCeiling, kind: "stt", manifest })).toThrow(
      /exceeds the profile ceiling/,
    );
  });
});

describe("documented speech defaults", () => {
  it("accepts the example profile and rejects silent model or endpoint substitutions", () => {
    const base = exampleProfiles();
    expect(() => assertDocumentedSpeechDefaults(base)).not.toThrow();
    expect(() =>
      assertDocumentedSpeechDefaults({ ...base, stt: { ...base.stt, model: "openai/other" } }),
    ).toThrow(/product decision/);
    expect(() =>
      assertDocumentedSpeechDefaults({ ...base, tts: { ...base.tts, model: "other/tts" } }),
    ).toThrow(/product decision/);
    expect(() =>
      assertDocumentedSpeechDefaults({
        ...base,
        stt: { ...base.stt, endpointProviderId: "deepinfra/us" },
      }),
    ).toThrow(/product decision/);
  });
});

describe("manifest freshness and loading", () => {
  const manifest = buildManifest();

  it("accepts a fresh manifest and refuses a stale one", () => {
    expect(() =>
      assertSpeechManifestFresh(manifest, new Date("2026-10-14T23:00:00.000Z")),
    ).not.toThrow();
    expect(() => assertSpeechManifestFresh(manifest, new Date("2026-10-16T12:00:00.000Z"))).toThrow(
      /older than 24 hours/,
    );
  });

  it("loads only a valid fresh snapshot from disk and never refreshes silently", () => {
    withTempCache((cachePath) => {
      expect(() => loadSpeechCapabilityManifest({ cachePath })).toThrow(SpeechError);
      writeFileSync(cachePath, JSON.stringify(manifest), "utf8");
      const loaded = loadSpeechCapabilityManifest({
        cachePath,
        now: new Date("2026-10-14T13:00:00.000Z"),
      });
      expect(loaded.pricingVersion).toBe(PRICING_VERSION);
      expect(() =>
        loadSpeechCapabilityManifest({ cachePath, now: new Date("2026-10-16T12:00:00.000Z") }),
      ).toThrow(/older than 24 hours/);
      writeFileSync(cachePath, "{}", "utf8");
      expect(() => loadSpeechCapabilityManifest({ cachePath })).toThrow(/voice:validate-models/);
    });
  });

  it("refuses a snapshot produced by a different normalization version", () => {
    const legacy: SpeechCapabilityManifest = {
      ...manifest,
      stt: { ...manifest.stt, normalizationVersion: "voice-normalization-v0" },
    };
    expect(() =>
      assertSpeechCapable({ profiles: exampleProfiles(), kind: "stt", manifest: legacy }),
    ).toThrow(/normalization/);
    withTempCache((cachePath) => {
      writeFileSync(cachePath, JSON.stringify(legacy), "utf8");
      expect(() =>
        loadSpeechCapabilityManifest({ cachePath, now: new Date("2026-10-14T13:00:00.000Z") }),
      ).toThrow(/normalization/);
    });
  });
});

describe("refresh and per-call tariff recheck", () => {
  it("writes a snapshot fetched from the public endpoint metadata", async () => {
    await withTempCacheAsync(async (cachePath) => {
      const profiles = exampleProfiles("unverified");
      const manifest = await refreshSpeechCapabilityManifest({
        cachePath,
        fetchImpl: fetchStub,
        profiles,
        now: FETCH_NOW,
      });
      expect(manifest.pricingVersion).toBe(FETCH_NOW.toISOString());
      expect(manifest.stt.ratePerUnitUsd).toBe("0.0000111111111111");
      const loaded = loadSpeechCapabilityManifest({ cachePath, now: FETCH_NOW });
      expect(loaded.stt.model).toBe(WHISPER);
    });
  });

  it("fails closed with diagnostics when a model is not verifiable", async () => {
    await withTempCacheAsync(async (cachePath) => {
      const broken: SpeechCapabilityFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: { id: "other", architecture: { modality: "text->speech" } } }),
      });
      await expect(
        refreshSpeechCapabilityManifest({
          cachePath,
          fetchImpl: broken,
          profiles: exampleProfiles("unverified"),
          now: FETCH_NOW,
        }),
      ).rejects.toThrow(/voice model validation failed/);
    });
  });

  it("passes when the published tariff is unchanged and refuses when it differs", async () => {
    const manifest = buildManifest();
    await expect(
      revalidateSpeechTariffs({ manifest, fetchImpl: fetchStub }),
    ).resolves.toBeUndefined();

    const changed: SpeechCapabilityFetch = async (url) => {
      if (url.includes(WHISPER)) {
        return {
          ok: true,
          status: 200,
          json: async () => payloadWithSttPricing({ prompt: "0.5", completion: "0" }),
        };
      }
      return { ok: true, status: 200, json: async () => elevenPayload() };
    };
    await expect(revalidateSpeechTariffs({ manifest, fetchImpl: changed })).rejects.toThrow(
      /tariff changed|changed or became unverifiable/,
    );

    const failing: SpeechCapabilityFetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    await expect(revalidateSpeechTariffs({ manifest, fetchImpl: failing })).rejects.toThrow(
      /HTTP 500/,
    );
  });

  it("refuses a newly published second TTS endpoint during the per-call recheck", async () => {
    const manifest = buildManifest();
    const twoEndpointTts: SpeechCapabilityFetch = async (url) => {
      if (url.includes(WHISPER)) {
        return { ok: true, status: 200, json: async () => whisperPayload() };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            id: ELEVEN,
            architecture: { modality: "text->speech" },
            endpoints: [
              { tag: "elevenlabs", pricing: { prompt: "0.00002", completion: "0", discount: 0.5 } },
              { tag: "other", pricing: { prompt: "0.01", completion: "0" } },
            ],
          },
        }),
      };
    };
    await expect(revalidateSpeechTariffs({ manifest, fetchImpl: twoEndpointTts })).rejects.toThrow(
      /single endpoint/,
    );
  });
});

async function withTempCacheAsync<T>(fn: (cachePath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "voice-capabilities-"));
  try {
    return await fn(join(dir, "voice-profiles.json.capabilities.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
