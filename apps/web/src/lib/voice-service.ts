import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  uuidSchema,
  voiceSynthesisRequestSchema,
  VOICE_DEFAULT_LIMITS,
  type ErrorCode,
  type PublicVoiceCapabilities,
  type VoiceLimits,
  type VoiceProfilesFile,
} from "@odft/contracts";
import {
  assertSpeechCapable,
  assertSpeechManifestFresh,
  FixtureSpeechAdapter,
  formatUsd,
  loadSpeechCapabilityManifest,
  loadVoiceProfiles,
  OpenRouterSpeechAdapter,
  parseUsd,
  reserveSttCostNanos,
  reserveTtsCostNanos,
  resolveVoiceConfigPath,
  revalidateSpeechTariffs,
  speechCapabilitiesPath,
  SpeechError,
  VoiceConfigError,
  compareUsd,
  type SpeechAdapter,
  type SpeechCapabilityCheck,
  type SpeechCapabilityFetch,
  type SpeechCapabilityManifest,
  type SpeechFetch,
} from "@odft/ai";
import {
  getConversationMessage,
  getTrip,
  loadOperationById,
  markVoiceCallFailed,
  markVoiceCallUnknown,
  reserveVoiceCall,
  resolveVoiceRuntimeConfig,
  settleVoiceCallSuccess,
  type AiMode,
  type ServerConfig,
} from "@odft/persistence";
import { inspectCanonicalWav } from "@/lib/voice-audio";
import { readBytesResult, readJsonResult } from "@/lib/request";

/**
 * Server-only voice service (VOICE_CONTROLL.md sections 7, 8 and 9).
 *
 * Owns the whole route semantics except the HTTP guard: runtime resolution
 * (disabled / credential-free fixture / validated live), strict request
 * validation, bounded reading, WAV inspection, atomic reservation BEFORE any
 * transport, one provider attempt, settlement, and explicit safe failures.
 * Adapters and fetch are injected so HTTP-level tests run without egress.
 * Fixture mode constructs no live transport and writes no billable rows.
 */

export interface VoiceServiceFailure {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export type VoiceServiceOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: VoiceServiceFailure };

export interface VoiceRuntimeState {
  readonly status: "disabled" | "fixture" | "live";
  readonly mode: AiMode;
  readonly limits: VoiceLimits;
  readonly profiles?: VoiceProfilesFile;
  readonly manifest?: SpeechCapabilityManifest;
  readonly stt?: SpeechCapabilityCheck;
  readonly tts?: SpeechCapabilityCheck;
  /** Resolved live profile path; also the capability-cache location. */
  readonly resolvedConfigPath?: string;
  readonly sttApiKey?: string;
}

export interface VoiceSynthesisAudio {
  readonly audio: Uint8Array;
  readonly contentType: "audio/mpeg" | "audio/wav";
}

export interface VoiceService {
  runtime(): VoiceServiceOutcome<VoiceRuntimeState>;
  transcribe(input: {
    readonly request: Request;
    readonly tripId: string;
    readonly sessionId: string;
  }): Promise<VoiceServiceOutcome<{ requestId: string; text: string; mode: AiMode }>>;
  synthesize(input: {
    readonly request: Request;
    readonly tripId: string;
    readonly sessionId: string;
  }): Promise<VoiceServiceOutcome<VoiceSynthesisAudio>>;
}

/** Settled operation statuses for synthesis (VOICE_CONTROLL.md section 2). */
const SETTLED_SYNTHESIS_STATUSES = new Set(["succeeded", "waiting", "failed"]);

function failure(code: ErrorCode, message: string, retryable = false): VoiceServiceOutcome<never> {
  return { ok: false, error: { code, message, retryable } };
}

function failureFromSpeech(error: SpeechError): VoiceServiceOutcome<never> {
  if (error.code === "VOICE_REQUEST_ABORTED") {
    return failure(
      "VOICE_UPSTREAM_FAILED",
      "the voice request was cancelled before the provider finished",
      true,
    );
  }
  return failure(error.code, error.message, error.retryable);
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Immutable request identity: kind, model, and an input digest. */
function requestFingerprint(kind: "stt" | "tts", model: string, digest: string): string {
  return sha256Hex(`${kind}\u0000${model}\u0000${digest}`);
}

export interface VoiceServiceDeps {
  readonly pool: Pool;
  readonly config: ServerConfig;
  /** Injected transport (tests); live mode otherwise builds OpenRouter transport. */
  readonly adapter?: SpeechAdapter;
  /** Injected fetch for live transport and the per-call tariff recheck. */
  readonly fetchImpl?: SpeechFetch;
  readonly now?: () => Date;
}

export function createVoiceService(deps: VoiceServiceDeps): VoiceService {
  const { pool, config } = deps;
  const now = (): Date => deps.now?.() ?? new Date();
  let runtimeCache: VoiceServiceOutcome<VoiceRuntimeState> | undefined;

  function resolveRuntime(): VoiceServiceOutcome<VoiceRuntimeState> {
    const resolved = resolveVoiceRuntimeConfig(config);
    if (resolved.status === "disabled") {
      return {
        ok: true,
        value: { status: "disabled", mode: config.aiMode, limits: VOICE_DEFAULT_LIMITS },
      };
    }
    if (resolved.status === "incomplete") {
      return failure(
        "VOICE_NOT_CONFIGURED",
        `voice is enabled but not configured: ${resolved.issues.join("; ")}`,
      );
    }
    if (resolved.status === "fixture") {
      // Fixture mode needs no credentials and no profile; an explicitly
      // configured profile must still be valid (explicit safe error, never a
      // silent fallback).
      if (!config.voiceConfigPath) {
        return {
          ok: true,
          value: { status: "fixture", mode: "fixture", limits: VOICE_DEFAULT_LIMITS },
        };
      }
      try {
        const profiles = loadVoiceProfiles(config.voiceConfigPath);
        return {
          ok: true,
          value: {
            status: "fixture",
            mode: "fixture",
            limits: profiles.limits,
            profiles,
          },
        };
      } catch (error) {
        if (error instanceof VoiceConfigError) {
          // Never echo filesystem paths to the client.
          return failure(
            "VOICE_NOT_CONFIGURED",
            "the voice profile is missing or invalid; run `npm run voice:validate-models` on the server",
          );
        }
        throw error;
      }
    }
    if (!config.openrouterApiKey) {
      return failure("VOICE_NOT_CONFIGURED", "the shared OpenRouter key is missing for TTS");
    }
    if (resolved.sttApiKey === config.openrouterApiKey) {
      // The dedicated Groq-restricted key must never equal the shared key; this
      // is an explicit safe failure, not an adapter-constructor crash.
      return failure(
        "VOICE_NOT_CONFIGURED",
        "the dedicated STT key must differ from the shared TTS/reasoning key",
      );
    }
    try {
      const resolvedConfigPath = resolveVoiceConfigPath(resolved.configPath);
      const profiles = loadVoiceProfiles(resolvedConfigPath);
      const manifest = loadSpeechCapabilityManifest({
        cachePath: speechCapabilitiesPath(resolvedConfigPath),
        now: now(),
      });
      const stt = assertSpeechCapable({ profiles, kind: "stt", manifest });
      const tts = assertSpeechCapable({ profiles, kind: "tts", manifest });
      return {
        ok: true,
        value: {
          status: "live",
          mode: "openrouter",
          limits: profiles.limits,
          profiles,
          manifest,
          stt,
          tts,
          resolvedConfigPath,
          sttApiKey: resolved.sttApiKey,
        },
      };
    } catch (error) {
      if (error instanceof VoiceConfigError) {
        // Never echo filesystem paths to the client.
        return failure(
          "VOICE_NOT_CONFIGURED",
          "the voice profile is missing or invalid; run `npm run voice:validate-models` on the server",
        );
      }
      if (error instanceof SpeechError) {
        return failureFromSpeech(error);
      }
      throw error;
    }
  }

  function runtime(): VoiceServiceOutcome<VoiceRuntimeState> {
    runtimeCache ??= resolveRuntime();
    return runtimeCache;
  }

  function adapterFor(state: VoiceRuntimeState): SpeechAdapter {
    if (deps.adapter) {
      return deps.adapter;
    }
    if (
      state.status !== "live" ||
      !state.profiles ||
      !state.sttApiKey ||
      !state.resolvedConfigPath
    ) {
      return new FixtureSpeechAdapter();
    }
    return new OpenRouterSpeechAdapter({
      sttApiKey: state.sttApiKey,
      ttsApiKey: config.openrouterApiKey as string,
      sttModel: state.profiles.stt.model,
      ttsModel: state.profiles.tts.model,
      ttsVoice: state.profiles.tts.voice,
      sttTimeoutMs: state.profiles.stt.timeoutMs,
      ttsTimeoutMs: state.profiles.tts.timeoutMs,
      maxResponseAudioBytes: state.limits.maxResponseAudioBytes,
      maxTranscriptCharacters: state.limits.maxTranscriptCharacters,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  }

  async function liveRecheck(
    state: VoiceRuntimeState,
    signal: AbortSignal,
  ): Promise<VoiceServiceOutcome<true>> {
    if (state.status !== "live" || !state.manifest) {
      return { ok: true, value: true };
    }
    const base =
      deps.fetchImpl ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
    // Bounded governance call: the caller's cancellation plus a short deadline,
    // so a stuck catalog fetch cannot leave the reserved row hanging.
    const deadline = AbortSignal.timeout(5_000);
    const fetchImpl: SpeechCapabilityFetch = (url, init) =>
      base(url, {
        ...(init?.headers ? { headers: init.headers } : {}),
        signal: AbortSignal.any([signal, deadline]),
      });
    try {
      // Section 5: the pinned manifest must stay fresh (24 h) for EVERY live
      // call - a long-running process must not keep transporting on an
      // expired snapshot even when the published prices happen to match.
      assertSpeechManifestFresh(state.manifest, now());
      // Recheck the published endpoint/tariffs before every live call; any
      // drift refuses transport until an explicit re-validation.
      await revalidateSpeechTariffs({ manifest: state.manifest, fetchImpl });
      return { ok: true, value: true };
    } catch (error) {
      if (error instanceof SpeechError) {
        return failureFromSpeech(error);
      }
      throw error;
    }
  }

  async function closeReservation(callId: string, error: SpeechError): Promise<void> {
    if (error.ledgerOutcome === "failed") {
      await markVoiceCallFailed(pool, callId, { errorCode: error.code });
    } else {
      await markVoiceCallUnknown(pool, callId, { errorCode: error.code });
    }
  }

  async function ownedTrip(tripId: string, sessionId: string): Promise<VoiceServiceOutcome<true>> {
    if (!uuidSchema.safeParse(tripId).success) {
      return failure("NOT_FOUND", "trip not found");
    }
    const trip = await getTrip(pool, tripId);
    if (!trip || trip.sessionId !== sessionId) {
      return failure("NOT_FOUND", "trip not found");
    }
    return { ok: true, value: true };
  }

  async function transcribe(input: {
    readonly request: Request;
    readonly tripId: string;
    readonly sessionId: string;
  }): Promise<VoiceServiceOutcome<{ requestId: string; text: string; mode: AiMode }>> {
    const state = runtime();
    if (!state.ok) {
      return state;
    }
    if (state.value.status === "disabled") {
      return failure("VOICE_DISABLED", "voice control is disabled");
    }
    const owned = await ownedTrip(input.tripId, input.sessionId);
    if (!owned.ok) {
      return owned;
    }
    const requestId = input.request.headers.get("x-voice-request-id") ?? "";
    if (!uuidSchema.safeParse(requestId).success) {
      return failure("VALIDATION_FAILED", "missing or invalid X-Voice-Request-Id header");
    }
    const contentType = (input.request.headers.get("content-type") ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "audio/wav") {
      return failure("VOICE_UNSUPPORTED_AUDIO", "the recording must be sent as audio/wav");
    }
    const body = await readBytesResult(input.request, state.value.limits.maxRequestAudioBytes);
    if (!body.ok) {
      return body.reason === "too_large"
        ? failure("VOICE_INPUT_TOO_LARGE", "the recording exceeds the upload limit")
        : failure("VOICE_UNSUPPORTED_AUDIO", "the recording body is missing");
    }
    const inspection = inspectCanonicalWav(body.bytes);
    if (!inspection.ok) {
      return failure(
        "VOICE_UNSUPPORTED_AUDIO",
        `the recording is not a canonical 16 kHz mono PCM WAV (${inspection.rejection})`,
      );
    }
    if (inspection.info.durationSeconds > state.value.limits.maxRecordingSeconds) {
      // FR-VOICE-10: byte/duration limits precede any billable transport.
      return failure(
        "VOICE_INPUT_TOO_LARGE",
        `the recording exceeds the ${String(state.value.limits.maxRecordingSeconds)}-second limit`,
      );
    }

    const adapter = adapterFor(state.value);
    if (state.value.status === "fixture") {
      try {
        const result = await adapter.transcribe({
          audio: body.bytes,
          format: "wav",
          signal: input.request.signal,
        });
        const text = result.text.trim();
        if (text.length === 0) {
          return failure("VOICE_NO_SPEECH", "no speech was detected in the recording");
        }
        if (text.length > state.value.limits.maxTranscriptCharacters) {
          return failure(
            "VOICE_TRANSCRIPT_TOO_LONG",
            `the transcript exceeds the ${String(state.value.limits.maxTranscriptCharacters)}-character limit`,
          );
        }
        return { ok: true, value: { requestId, text, mode: "fixture" } };
      } catch (error) {
        if (error instanceof SpeechError) {
          return failureFromSpeech(error);
        }
        throw error;
      }
    }

    const check = state.value.stt;
    const profiles = state.value.profiles;
    if (!check || !profiles) {
      return failure("VOICE_NOT_CONFIGURED", "live speech-to-text is not configured");
    }
    const tariff = check.tariff;
    const reservedCostUsd = formatUsd(reserveSttCostNanos(tariff, inspection.info.sampleCount));
    if (compareUsd(parseUsd(reservedCostUsd), parseUsd(profiles.stt.maxCallCostUsd)) > 0) {
      return failure(
        "VOICE_BUDGET_EXCEEDED",
        "the worst-case cost of this recording exceeds the per-call ceiling",
      );
    }
    const reserve = await reserveVoiceCall(pool, {
      tripId: input.tripId,
      requestId,
      requestFingerprint: requestFingerprint("stt", profiles.stt.model, sha256Hex(body.bytes)),
      kind: "stt",
      model: profiles.stt.model,
      providerRestriction: profiles.stt.endpointProviderId,
      pricingVersion: profiles.pricingVersion,
      normalizationVersion: check.entry.normalizationVersion,
      unitKind: "audio_seconds",
      inputUnits: inspection.info.durationSeconds,
      reservedCostUsd,
      maxCallCostUsd: profiles.stt.maxCallCostUsd,
      maxCallsPerTrip: state.value.limits.maxCallsPerTrip,
      maxCostUsdPerTrip: state.value.limits.maxCostUsdPerTrip,
    });
    if (!reserve.ok) {
      return failure(reserve.code, reserve.message);
    }
    const recheck = await liveRecheck(state.value, input.request.signal);
    if (!recheck.ok) {
      // No transport was attempted, so the call is provably unbilled.
      await markVoiceCallFailed(pool, reserve.callId, { errorCode: recheck.error.code });
      return recheck;
    }
    try {
      const result = await adapter.transcribe({
        audio: body.bytes,
        format: "wav",
        signal: input.request.signal,
      });
      const costUsd = result.usage.costUsd ?? reservedCostUsd;
      await settleVoiceCallSuccess(pool, reserve.callId, {
        costStatus: result.usage.costUsd !== undefined ? "actual" : "estimated",
        costUsd,
        latencyMs: result.usage.latencyMs,
        ...(result.usage.units !== undefined
          ? { inputUnits: result.usage.units, unitKind: result.usage.unitKind }
          : {}),
        ...(result.usage.generationId !== undefined
          ? { generationId: result.usage.generationId }
          : {}),
      });
      return { ok: true, value: { requestId, text: result.text.trim(), mode: "openrouter" } };
    } catch (error) {
      if (error instanceof SpeechError) {
        await closeReservation(reserve.callId, error);
        return failureFromSpeech(error);
      }
      throw error;
    }
  }

  async function synthesize(input: {
    readonly request: Request;
    readonly tripId: string;
    readonly sessionId: string;
  }): Promise<VoiceServiceOutcome<VoiceSynthesisAudio>> {
    const state = runtime();
    if (!state.ok) {
      return state;
    }
    if (state.value.status === "disabled") {
      return failure("VOICE_DISABLED", "voice control is disabled");
    }
    const body = await readJsonResult(input.request);
    if (!body.ok) {
      return body.reason === "too_large"
        ? failure("VOICE_INPUT_TOO_LARGE", "request body too large")
        : failure("VALIDATION_FAILED", "invalid JSON body");
    }
    const parsed = voiceSynthesisRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return failure("VALIDATION_FAILED", "invalid synthesis request");
    }
    const owned = await ownedTrip(input.tripId, input.sessionId);
    if (!owned.ok) {
      return owned;
    }
    const message = await getConversationMessage(pool, input.tripId, parsed.data.messageId);
    if (!message) {
      // A wrong-trip message id is indistinguishable from a missing one.
      return failure("NOT_FOUND", "message not found");
    }
    if (message.role !== "assistant" || !message.operationId) {
      return failure("VOICE_MESSAGE_NOT_READY", "the message is not a settled assistant reply");
    }
    const operation = await loadOperationById(pool, message.operationId);
    if (!operation || operation.tripId !== input.tripId) {
      return failure("VOICE_MESSAGE_NOT_READY", "the linked operation is not settled");
    }
    if (!SETTLED_SYNTHESIS_STATUSES.has(operation.status)) {
      return failure("VOICE_MESSAGE_NOT_READY", "the linked operation is still running");
    }
    const text = message.content.trim();
    if (text.length === 0) {
      return failure("VOICE_MESSAGE_NOT_READY", "the message has no speakable content");
    }
    if (text.length > state.value.limits.maxReplyCharacters) {
      return failure("VOICE_MESSAGE_NOT_READY", "the message exceeds the reply length limit");
    }

    const adapter = adapterFor(state.value);
    if (state.value.status === "fixture") {
      try {
        const result = await adapter.synthesize({ text, signal: input.request.signal });
        return { ok: true, value: { audio: result.audio, contentType: "audio/wav" } };
      } catch (error) {
        if (error instanceof SpeechError) {
          return failureFromSpeech(error);
        }
        throw error;
      }
    }

    const check = state.value.tts;
    const profiles = state.value.profiles;
    if (!check || !profiles) {
      return failure("VOICE_NOT_CONFIGURED", "live speech synthesis is not configured");
    }
    const reservedCostUsd = formatUsd(reserveTtsCostNanos(check.tariff, text));
    if (compareUsd(parseUsd(reservedCostUsd), parseUsd(profiles.tts.maxCallCostUsd)) > 0) {
      return failure(
        "VOICE_BUDGET_EXCEEDED",
        "the worst-case cost of this reply exceeds the per-call ceiling",
      );
    }
    const reserve = await reserveVoiceCall(pool, {
      tripId: input.tripId,
      requestId: parsed.data.requestId,
      requestFingerprint: requestFingerprint(
        "tts",
        profiles.tts.model,
        sha256Hex(`${parsed.data.messageId}\u0000${text}`),
      ),
      kind: "tts",
      model: profiles.tts.model,
      providerRestriction: check.entry.endpointProviderId,
      pricingVersion: profiles.pricingVersion,
      normalizationVersion: check.entry.normalizationVersion,
      operationId: message.operationId,
      messageId: message.id,
      unitKind: "characters",
      inputUnits: text.length,
      reservedCostUsd,
      maxCallCostUsd: profiles.tts.maxCallCostUsd,
      maxCallsPerTrip: state.value.limits.maxCallsPerTrip,
      maxCostUsdPerTrip: state.value.limits.maxCostUsdPerTrip,
    });
    if (!reserve.ok) {
      return failure(reserve.code, reserve.message);
    }
    const recheck = await liveRecheck(state.value, input.request.signal);
    if (!recheck.ok) {
      // No transport was attempted, so the call is provably unbilled.
      await markVoiceCallFailed(pool, reserve.callId, { errorCode: recheck.error.code });
      return recheck;
    }
    try {
      const result = await adapter.synthesize({ text, signal: input.request.signal });
      await settleVoiceCallSuccess(pool, reserve.callId, {
        costStatus: result.usage.costUsd !== undefined ? "actual" : "estimated",
        costUsd: result.usage.costUsd ?? reservedCostUsd,
        latencyMs: result.usage.latencyMs,
        inputUnits: text.length,
        unitKind: "characters",
        ...(result.usage.generationId !== undefined
          ? { generationId: result.usage.generationId }
          : {}),
      });
      return { ok: true, value: { audio: result.audio, contentType: result.contentType } };
    } catch (error) {
      if (error instanceof SpeechError) {
        await closeReservation(reserve.callId, error);
        return failureFromSpeech(error);
      }
      throw error;
    }
  }

  return { runtime, transcribe, synthesize };
}

export function capabilitiesFromRuntime(state: VoiceRuntimeState): PublicVoiceCapabilities {
  return {
    enabled: state.status !== "disabled",
    mode: state.mode,
    maxRecordingSeconds: state.limits.maxRecordingSeconds,
    maxRequestAudioBytes: state.limits.maxRequestAudioBytes,
    maxTranscriptCharacters: state.limits.maxTranscriptCharacters,
    inputMimeType: "audio/wav",
  };
}

const globalForVoiceService = globalThis as unknown as { __odftVoiceService?: VoiceService };

/**
 * Process-cached voice service (HMR-safe, mirroring `getServerDeps`): the
 * runtime snapshot — profile, capability manifest, and live checks — is
 * resolved once per process, so the operator flow is exactly "validate, then
 * restart the web process". Tests inject their own `createVoiceService`.
 */
export function getVoiceService(deps: VoiceServiceDeps): VoiceService {
  globalForVoiceService.__odftVoiceService ??= createVoiceService(deps);
  return globalForVoiceService.__odftVoiceService;
}
