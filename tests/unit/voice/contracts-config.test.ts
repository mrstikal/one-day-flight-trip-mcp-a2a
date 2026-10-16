import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  errorCodeSchema,
  publicConversationMessageSchema,
  publicInspectorSchema,
  publicVoiceCallSchema,
  publicVoiceCapabilitiesSchema,
  voiceProfilesFileSchema,
  voiceSynthesisRequestSchema,
  voiceTranscriptionResponseSchema,
} from "@odft/contracts";
import { parseServerConfig, resolveVoiceRuntimeConfig, type ServerConfig } from "@odft/persistence";

/**
 * T-UT-VOICE-01 (VOICE_CONTROLL.md section 15): exact profile defaults, strict
 * unknown-key rejection, bounded limits, separate credentials, and
 * disabled/fixture/live voice configuration. Also pins the public operation
 * link added in V01.
 */

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const EXAMPLE_PATH = `${repoRoot}voice-profiles.example.json`;

const BASE_ENV = {
  DATABASE_URL: "postgres://user:pass@127.0.0.1:5432/odft",
  PUBLIC_BASE_URL: "http://localhost:3000",
  SESSION_HMAC_KEY: "a".repeat(48),
};

const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";

function exampleProfiles(): unknown {
  return JSON.parse(readFileSync(EXAMPLE_PATH, "utf8"));
}

function parsedExample() {
  const result = voiceProfilesFileSchema.safeParse(exampleProfiles());
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error("example profile must parse");
  }
  return result.data;
}

function serverConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    databaseUrl: "postgres://user:pass@127.0.0.1:5432/odft",
    publicBaseUrl: "http://localhost:3000",
    sessionHmacKey: "a".repeat(48),
    aiMode: "openrouter",
    openrouterApiKey: "sk-shared",
    aiConfigPath: undefined,
    maxPlanningAttempts: 3,
    maxProviderAttempts: 2,
    maxLlmCallsPerTrip: 40,
    maxLlmCostUsdPerTrip: 1,
    demoControlsEnabled: false,
    wikidataDiscovery: false,
    mapTileUrl: undefined,
    workerConcurrency: 2,
    trustProxy: false,
    voiceEnabled: true,
    voiceConfigPath: "voice-profiles.json",
    openrouterSttApiKey: "sk-stt-dedicated",
    ...overrides,
  };
}

describe("voice profile file schema", () => {
  it("the example file matches the exact documented defaults", () => {
    const profiles = parsedExample();
    expect(profiles.schemaVersion).toBe(1);
    expect(profiles.pricingVersion).toBe("unverified");
    expect(profiles.stt).toEqual({
      provider: "openrouter",
      model: "openai/whisper-large-v3-turbo",
      endpointProviderId: "groq",
      timeoutMs: 20000,
      maxCallCostUsd: "0.02",
    });
    expect(profiles.tts).toEqual({
      provider: "openrouter",
      model: "elevenlabs/eleven-v4-turbo",
      voice: "george",
      responseFormat: "mp3",
      timeoutMs: 20000,
      maxCallCostUsd: "0.05",
    });
    expect(profiles.limits).toEqual({
      maxRecordingSeconds: 60,
      maxRequestAudioBytes: 2_097_152,
      maxResponseAudioBytes: 8_388_608,
      maxTranscriptCharacters: 2000,
      maxReplyCharacters: 2000,
      maxCallsPerTrip: 60,
      maxCostUsdPerTrip: "1.00",
    });
  });

  it("rejects unknown keys at every level", () => {
    const base = parsedExample();
    const mutations: unknown[] = [
      { ...base, apiKey: "sk-nope" },
      { ...base, stt: { ...base.stt, modelFallbacks: ["other"] } },
      { ...base, tts: { ...base.tts, apiKey: "sk-nope" } },
      { ...base, limits: { ...base.limits, maxCallsPerDay: 500 } },
    ];
    for (const mutation of mutations) {
      const result = voiceProfilesFileSchema.safeParse(mutation);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
      }
    }
  });

  it("pins the gateway, the mp3 response format, and the documented defaults", () => {
    const base = parsedExample();
    expect(
      voiceProfilesFileSchema.safeParse({ ...base, stt: { ...base.stt, provider: "groq" } })
        .success,
    ).toBe(false);
    expect(
      voiceProfilesFileSchema.safeParse({ ...base, tts: { ...base.tts, responseFormat: "pcm" } })
        .success,
    ).toBe(false);
    expect(
      voiceProfilesFileSchema.safeParse({ ...base, stt: { ...base.stt, maxCallCostUsd: "0" } })
        .success,
    ).toBe(false);
    expect(
      voiceProfilesFileSchema.safeParse({ ...base, stt: { ...base.stt, timeoutMs: 999 } }).success,
    ).toBe(false);
    expect(
      voiceProfilesFileSchema.safeParse({ ...base, stt: { ...base.stt, timeoutMs: 45001 } })
        .success,
    ).toBe(false);
  });

  it("bounds every limit so an operator file can never raise them", () => {
    const base = parsedExample();
    const cases: Array<[keyof typeof base.limits, number | string]> = [
      ["maxRecordingSeconds", 61],
      ["maxRecordingSeconds", 30.5],
      ["maxRequestAudioBytes", 2_097_153],
      ["maxResponseAudioBytes", 8_388_609],
      ["maxTranscriptCharacters", 2_001],
      ["maxReplyCharacters", 2_001],
      ["maxCallsPerTrip", 61],
      ["maxCostUsdPerTrip", "0"],
    ];
    for (const [field, value] of cases) {
      const result = voiceProfilesFileSchema.safeParse({
        ...base,
        limits: { ...base.limits, [field]: value },
      });
      expect(result.success, `limits.${field}=${String(value)} must be rejected`).toBe(false);
    }
  });
});

describe("public voice API schemas", () => {
  it("capabilities are strict and carry no credentials", () => {
    const capabilities = {
      enabled: true,
      mode: "fixture",
      maxRecordingSeconds: 60,
      maxRequestAudioBytes: 2_097_152,
      maxTranscriptCharacters: 2000,
      inputMimeType: "audio/wav",
    };
    expect(publicVoiceCapabilitiesSchema.safeParse(capabilities).success).toBe(true);
    expect(
      publicVoiceCapabilitiesSchema.safeParse({ ...capabilities, apiKey: "sk-nope" }).success,
    ).toBe(false);
    expect(publicVoiceCapabilitiesSchema.safeParse({ ...capabilities, mode: "live" }).success).toBe(
      false,
    );
    expect(
      publicVoiceCapabilitiesSchema.safeParse({ ...capabilities, inputMimeType: "audio/mpeg" })
        .success,
    ).toBe(false);
  });

  it("transcription responses are strict and never empty", () => {
    const response = { requestId: MESSAGE_ID, text: "show me a museum", mode: "openrouter" };
    expect(voiceTranscriptionResponseSchema.safeParse(response).success).toBe(true);
    expect(voiceTranscriptionResponseSchema.safeParse({ ...response, text: "" }).success).toBe(
      false,
    );
    expect(
      voiceTranscriptionResponseSchema.safeParse({ ...response, text: "x".repeat(2_001) }).success,
    ).toBe(false);
    expect(
      voiceTranscriptionResponseSchema.safeParse({ ...response, costUsd: "0.01" }).success,
    ).toBe(false);
  });

  it("synthesis requests cannot carry client text or a client voice", () => {
    expect(
      voiceSynthesisRequestSchema.safeParse({ requestId: MESSAGE_ID, messageId: MESSAGE_ID })
        .success,
    ).toBe(true);
    expect(
      voiceSynthesisRequestSchema.safeParse({
        requestId: MESSAGE_ID,
        messageId: MESSAGE_ID,
        text: "read this aloud",
      }).success,
    ).toBe(false);
    expect(
      voiceSynthesisRequestSchema.safeParse({
        requestId: MESSAGE_ID,
        messageId: MESSAGE_ID,
        voice: "adam",
      }).success,
    ).toBe(false);
  });

  it("voice-call telemetry is safe and typed", () => {
    const row = {
      kind: "stt",
      model: "openai/whisper-large-v3-turbo",
      restrictedProviderId: "groq",
      servingProviderId: "groq",
      unitKind: "audio_seconds",
      inputUnits: 9.2,
      latencyMs: 620,
      status: "succeeded",
      costStatus: "actual",
      reservedCostUsd: "0.02",
      actualCostUsd: "0.000508",
      errorCode: null,
      createdAt: "2026-10-14T12:00:00Z",
    };
    expect(publicVoiceCallSchema.safeParse(row).success).toBe(true);
    expect(publicVoiceCallSchema.safeParse({ ...row, text: "secret transcript" }).success).toBe(
      false,
    );
    expect(publicVoiceCallSchema.safeParse({ ...row, errorCode: "MADE_UP" }).success).toBe(false);
    expect(publicVoiceCallSchema.safeParse({ ...row, reservedCostUsd: "1e-3" }).success).toBe(
      false,
    );
    expect(publicVoiceCallSchema.safeParse({ ...row, generationId: "gen-1" }).success).toBe(false);
  });

  it("embeds the voice rows in the strict inspector contract", () => {
    const inspector = {
      scenarioMode: "normal",
      graph: null,
      nodes: [],
      operations: [],
      checkpoints: [],
      llmCalls: [],
      llmCostTotalUsd: "0",
      faults: [],
      events: [],
    };
    expect(publicInspectorSchema.safeParse(inspector).success).toBe(false);
    const voiceCall = {
      kind: "tts",
      model: "elevenlabs/eleven-v4-turbo",
      restrictedProviderId: null,
      servingProviderId: "elevenlabs",
      unitKind: "characters",
      inputUnits: 120,
      latencyMs: 900,
      status: "reconciled",
      costStatus: "actual",
      reservedCostUsd: "0.05",
      actualCostUsd: "0.0024",
      errorCode: null,
      createdAt: "2026-10-14T12:00:00Z",
    };
    expect(publicInspectorSchema.safeParse({ ...inspector, voiceCalls: [voiceCall] }).success).toBe(
      true,
    );
    expect(
      publicInspectorSchema.safeParse({ ...inspector, voiceCalls: [{ ...voiceCall, tokens: 5 }] })
        .success,
    ).toBe(false);
  });
});

describe("public conversation message operation link", () => {
  const message = {
    id: MESSAGE_ID,
    sequence: 1,
    role: "assistant",
    content: "Considered a museum visit.",
    interpretation: null,
    operationId: null,
    createdAt: "2026-10-14T12:00:00Z",
  };

  it("accepts a legacy null link and a real operation link", () => {
    expect(publicConversationMessageSchema.safeParse(message).success).toBe(true);
    expect(
      publicConversationMessageSchema.safeParse({ ...message, operationId: OPERATION_ID }).success,
    ).toBe(true);
  });

  it("requires the operationId field and never accepts an unknown key", () => {
    const { operationId: _omitted, ...withoutOperationId } = message;
    expect(publicConversationMessageSchema.safeParse(withoutOperationId).success).toBe(false);
    expect(
      publicConversationMessageSchema.safeParse({ ...message, operation: OPERATION_ID }).success,
    ).toBe(false);
  });

  it("keeps the voice error codes part of the shared taxonomy", () => {
    for (const code of [
      "VOICE_DISABLED",
      "VOICE_NOT_CONFIGURED",
      "VOICE_CAPABILITY_UNKNOWN",
      "VOICE_INPUT_TOO_LARGE",
      "VOICE_UNSUPPORTED_AUDIO",
      "VOICE_NO_SPEECH",
      "VOICE_TRANSCRIPT_TOO_LONG",
      "VOICE_MESSAGE_NOT_READY",
      "VOICE_REQUEST_IN_PROGRESS",
      "VOICE_RESULT_EXPIRED",
      "VOICE_BUDGET_EXCEEDED",
      "VOICE_UPSTREAM_FAILED",
      "VOICE_TIMEOUT",
    ]) {
      expect(errorCodeSchema.safeParse(code).success, code).toBe(true);
    }
  });
});

describe("voice server configuration", () => {
  it("defaults to disabled with no voice values", () => {
    const config = parseServerConfig({ ...BASE_ENV });
    expect(config.voiceEnabled).toBe(false);
    expect(config.voiceConfigPath).toBeUndefined();
    expect(config.openrouterSttApiKey).toBeUndefined();
  });

  it("parses enabled voice values and never blocks unrelated routes", () => {
    const config = parseServerConfig({
      ...BASE_ENV,
      VOICE_ENABLED: "yes",
      VOICE_CONFIG_PATH: "voice-profiles.json",
      OPENROUTER_STT_API_KEY: "sk-stt",
    });
    expect(config.voiceEnabled).toBe(true);
    expect(config.voiceConfigPath).toBe("voice-profiles.json");
    expect(config.openrouterSttApiKey).toBe("sk-stt");
    // Enabling voice without credentials or a profile must not fail parsing.
    expect(() => parseServerConfig({ ...BASE_ENV, VOICE_ENABLED: "true" })).not.toThrow();
  });

  it("treats an empty voice override as unset rather than a global failure", () => {
    const config = parseServerConfig({
      ...BASE_ENV,
      VOICE_ENABLED: "",
      VOICE_CONFIG_PATH: "",
      OPENROUTER_STT_API_KEY: "",
    });
    expect(config.voiceEnabled).toBe(false);
    expect(config.voiceConfigPath).toBeUndefined();
    expect(config.openrouterSttApiKey).toBeUndefined();
  });

  it("is disabled unless explicitly enabled, even with every value present", () => {
    expect(resolveVoiceRuntimeConfig(serverConfig({ voiceEnabled: false }))).toEqual({
      status: "disabled",
    });
  });

  it("fixture mode is fully offline and needs no credential or profile", () => {
    expect(
      resolveVoiceRuntimeConfig(
        serverConfig({
          aiMode: "fixture",
          voiceConfigPath: undefined,
          openrouterSttApiKey: undefined,
        }),
      ),
    ).toEqual({ status: "fixture" });
  });

  it("live mode without the profile path is incomplete", () => {
    const resolved = resolveVoiceRuntimeConfig(serverConfig({ voiceConfigPath: undefined }));
    expect(resolved.status).toBe("incomplete");
    if (resolved.status === "incomplete") {
      expect(resolved.issues.join(" ")).toContain("VOICE_CONFIG_PATH");
    }
  });

  it("never substitutes the shared reasoning key for the dedicated STT key", () => {
    const resolved = resolveVoiceRuntimeConfig(
      serverConfig({ openrouterSttApiKey: undefined, openrouterApiKey: "sk-shared" }),
    );
    expect(resolved.status).toBe("incomplete");
    if (resolved.status === "incomplete") {
      expect(resolved.issues.join(" ")).toContain("OPENROUTER_STT_API_KEY");
      expect(resolved.issues.join(" ")).toContain("not a substitute");
    }
  });

  it("is live only with both the profile path and the dedicated key", () => {
    expect(resolveVoiceRuntimeConfig(serverConfig())).toEqual({
      status: "live",
      configPath: "voice-profiles.json",
      sttApiKey: "sk-stt-dedicated",
    });
  });
});
