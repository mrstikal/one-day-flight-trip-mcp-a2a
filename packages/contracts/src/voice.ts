import { z } from "zod";
import { aiModeSchema, costStatusSchema, usdDecimalSchema } from "./ai.js";
import { errorCodeSchema } from "./errors.js";
import { instantSchema, nonEmptyStringSchema, uuidSchema } from "./primitives.js";

/**
 * Voice-control contracts (VOICE_CONTROLL.md sections 6, 7 and 9).
 *
 * The operator speech profile is a separate strict file (never the four-role
 * `ai-profiles.json`); limits are strict product bounds, so an operator file can
 * narrow them but never raise them. Public schemas are strict and carry no
 * audio, transcript, reply text, key identity, or provider payload.
 */

export const voiceKindSchema = z.enum(["stt", "tts"]);
export type VoiceKind = z.infer<typeof voiceKindSchema>;

/** Only documented OpenRouter speech endpoints are supported. */
export const voiceGatewaySchema = z.literal("openrouter");
export type VoiceGateway = z.infer<typeof voiceGatewaySchema>;

/** Positive fixed-precision USD decimal string (never travel EUR money). */
const positiveUsdSchema = usdDecimalSchema.refine(
  (value) => !/^0+(\.0+)?$/.test(value),
  "must be greater than zero",
);

/**
 * STT profile: `endpointProviderId` is the gateway endpoint tag that the
 * dedicated key's guardrail must restrict routing to; a model ID alone never
 * pins a provider.
 */
export const voiceSttProfileSchema = z
  .object({
    provider: voiceGatewaySchema,
    model: nonEmptyStringSchema,
    endpointProviderId: nonEmptyStringSchema,
    timeoutMs: z.number().int().min(1_000).max(45_000),
    maxCallCostUsd: positiveUsdSchema,
  })
  .strict();
export type VoiceSttProfile = z.infer<typeof voiceSttProfileSchema>;

export const voiceTtsProfileSchema = z
  .object({
    provider: voiceGatewaySchema,
    model: nonEmptyStringSchema,
    voice: nonEmptyStringSchema,
    responseFormat: z.literal("mp3"),
    timeoutMs: z.number().int().min(1_000).max(45_000),
    maxCallCostUsd: positiveUsdSchema,
  })
  .strict();
export type VoiceTtsProfile = z.infer<typeof voiceTtsProfileSchema>;

/** Strict, bounded product limits; voice spending is separate from LLM caps. */
export const voiceLimitsSchema = z
  .object({
    maxRecordingSeconds: z.number().int().min(1).max(60),
    maxRequestAudioBytes: z.number().int().min(1).max(2_097_152),
    maxResponseAudioBytes: z.number().int().min(1).max(8_388_608),
    maxTranscriptCharacters: z.number().int().min(1).max(2_000),
    maxReplyCharacters: z.number().int().min(1).max(2_000),
    maxCallsPerTrip: z.number().int().min(1).max(60),
    maxCostUsdPerTrip: positiveUsdSchema,
  })
  .strict();
export type VoiceLimits = z.infer<typeof voiceLimitsSchema>;

/**
 * Documented default limits (VOICE_CONTROLL.md sections 6 and 10). Used only
 * when voice is disabled or runs in credential-free fixture mode without an
 * operator profile; live mode always uses the validated profile file.
 */
export const VOICE_DEFAULT_LIMITS: VoiceLimits = voiceLimitsSchema.parse({
  maxRecordingSeconds: 60,
  maxRequestAudioBytes: 2_097_152,
  maxResponseAudioBytes: 8_388_608,
  maxTranscriptCharacters: 2_000,
  maxReplyCharacters: 2_000,
  maxCallsPerTrip: 60,
  maxCostUsdPerTrip: "1.00",
});

/** The whole `voice-profiles.json` operator file (strict, exact shape). */
export const voiceProfilesFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    pricingVersion: nonEmptyStringSchema,
    stt: voiceSttProfileSchema,
    tts: voiceTtsProfileSchema,
    limits: voiceLimitsSchema,
  })
  .strict();
export type VoiceProfilesFile = z.infer<typeof voiceProfilesFileSchema>;

/** Public host-advertised voice capabilities (no credentials, no model IDs). */
export const publicVoiceCapabilitiesSchema = z
  .object({
    enabled: z.boolean(),
    mode: aiModeSchema,
    maxRecordingSeconds: z.number().int().min(1).max(60),
    maxRequestAudioBytes: z.number().int().min(1).max(2_097_152),
    maxTranscriptCharacters: z.number().int().min(1).max(2_000),
    inputMimeType: z.literal("audio/wav"),
  })
  .strict();
export type PublicVoiceCapabilities = z.infer<typeof publicVoiceCapabilitiesSchema>;

/** Successful transcription result; the transcript already respects the cap. */
export const voiceTranscriptionResponseSchema = z
  .object({
    requestId: uuidSchema,
    text: z.string().min(1).max(2_000),
    mode: aiModeSchema,
  })
  .strict();
export type VoiceTranscriptionResponse = z.infer<typeof voiceTranscriptionResponseSchema>;

/**
 * TTS request: the client can only link an existing assistant message, never
 * provide text or a voice of its own.
 */
export const voiceSynthesisRequestSchema = z
  .object({
    requestId: uuidSchema,
    messageId: uuidSchema,
  })
  .strict();
export type VoiceSynthesisRequest = z.infer<typeof voiceSynthesisRequestSchema>;

export const voiceCallStatusSchema = z.enum([
  "reserved",
  "succeeded",
  "failed",
  "unknown_reserved",
  "reconciled",
]);
export type VoiceCallStatus = z.infer<typeof voiceCallStatusSchema>;

export const voiceUnitKindSchema = z.enum(["audio_seconds", "characters"]);
export type VoiceUnitKind = z.infer<typeof voiceUnitKindSchema>;

/**
 * Safe voice-call telemetry row for the inspector (VOICE_CONTROLL.md section 9):
 * kind, model, verified provider metadata, units, latency, call status, and
 * reserved/actual USD. Never audio, transcripts, reply text, key identities,
 * generation IDs, or provider payloads. Units are never rendered as tokens.
 */
export const publicVoiceCallSchema = z
  .object({
    kind: voiceKindSchema,
    model: nonEmptyStringSchema.max(200),
    /** Configured restriction target when known (e.g. the Groq-only tag). */
    restrictedProviderId: nonEmptyStringSchema.max(80).nullable(),
    /** Verified serving provider once observed (never guessed). */
    servingProviderId: nonEmptyStringSchema.max(80).nullable(),
    unitKind: voiceUnitKindSchema.nullable(),
    inputUnits: z.number().min(0).nullable(),
    latencyMs: z.number().int().min(0).nullable(),
    status: voiceCallStatusSchema,
    costStatus: costStatusSchema.nullable(),
    reservedCostUsd: usdDecimalSchema,
    actualCostUsd: usdDecimalSchema.nullable(),
    errorCode: errorCodeSchema.nullable(),
    createdAt: instantSchema,
  })
  .strict();
export type PublicVoiceCall = z.infer<typeof publicVoiceCallSchema>;
