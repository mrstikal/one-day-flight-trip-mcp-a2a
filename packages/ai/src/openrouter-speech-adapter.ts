import { z } from "zod";
import {
  SpeechError,
  combineAbortSignals,
  readBodyWithCap,
  usageCostFromNumber,
  type SpeechAdapter,
  type SpeechFetch,
  type SpeechSynthesisRequest,
  type SpeechSynthesisResult,
  type SpeechTranscriptionRequest,
  type SpeechTranscriptionResult,
  type SpeechUsage,
} from "./speech-adapter.js";

/**
 * OpenRouter speech transport (VOICE_CONTROLL.md section 8).
 *
 * Exact documented endpoints and request shapes: JSON base64 audio for STT
 * (`/api/v1/audio/transcriptions` with the dedicated key), JSON for TTS
 * (`/api/v1/audio/speech` with the shared key), raw audio back — never parsed as
 * JSON. One attempt per request, no provider SDK, no undocumented routing
 * fields, no direct-provider URLs.
 */

export const OPENROUTER_TRANSCRIPTIONS_URL = "https://openrouter.ai/api/v1/audio/transcriptions";
export const OPENROUTER_SPEECH_URL = "https://openrouter.ai/api/v1/audio/speech";

/** Defensive cap for the small STT JSON payload (transcript cap is 2,000 chars). */
export const MAX_STT_RESPONSE_BYTES = 65_536;

const transcriptionPayloadSchema = z
  .object({
    text: z.string(),
    usage: z
      .object({
        seconds: z.number().finite().nonnegative().optional(),
        cost: z.number().finite().nonnegative().optional(),
        total_tokens: z.number().optional(),
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .strict();

export interface OpenRouterSpeechAdapterOptions {
  /** Dedicated Groq-restricted key; MUST differ from the shared TTS key. */
  readonly sttApiKey: string;
  /** Shared reasoning/TTS key; never used for STT. */
  readonly ttsApiKey: string;
  readonly sttModel: string;
  readonly ttsModel: string;
  readonly ttsVoice: string;
  readonly sttTimeoutMs: number;
  readonly ttsTimeoutMs: number;
  /** Enforced before any successful TTS response is returned (8 MiB default). */
  readonly maxResponseAudioBytes: number;
  /** The profile's transcript cap (≤ 2,000 characters). */
  readonly maxTranscriptCharacters: number;
  readonly fetchImpl?: SpeechFetch;
}

function classifyHttpFailure(status: number): SpeechError {
  if (status === 401 || status === 402 || status === 403) {
    return new SpeechError(
      "VOICE_NOT_CONFIGURED",
      `the speech provider rejected the configured key or credits (HTTP ${String(status)})`,
      false,
      "failed",
    );
  }
  if (status === 429) {
    // Rate limited before any processing: provably not billed.
    return new SpeechError(
      "VOICE_UPSTREAM_FAILED",
      `the speech provider rate limited the request (HTTP 429)`,
      true,
      "failed",
    );
  }
  if (status >= 500) {
    // The provider may have billed the call before failing: keep the reservation.
    return new SpeechError(
      "VOICE_UPSTREAM_FAILED",
      `the speech provider returned status ${String(status)}`,
      true,
      "unknown",
    );
  }
  return new SpeechError(
    "VOICE_UPSTREAM_FAILED",
    `the speech provider rejected the request (HTTP ${String(status)})`,
    false,
    "failed",
  );
}

function generationIdOf(response: Response): string | undefined {
  const value = response.headers.get("x-generation-id");
  return value && value.length > 0 ? value : undefined;
}

/**
 * Classify a body-read/parse failure by which signal fired, so an abort during
 * the response read is never reported as an empty transcript or a success.
 */
function classifyBodyFailure(
  error: unknown,
  callerSignal: AbortSignal,
  timeoutSignal: AbortSignal,
): SpeechError {
  if (error instanceof SpeechError) {
    return error;
  }
  if (callerSignal.aborted) {
    return new SpeechError("VOICE_REQUEST_ABORTED", "the speech request was cancelled", false);
  }
  if (timeoutSignal.aborted) {
    return new SpeechError("VOICE_TIMEOUT", "the speech request timed out", true);
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new SpeechError("VOICE_REQUEST_ABORTED", "the speech request was cancelled", false);
  }
  return new SpeechError(
    "VOICE_UPSTREAM_FAILED",
    error instanceof Error ? error.message : "unknown speech response failure",
    true,
  );
}

export class OpenRouterSpeechAdapter implements SpeechAdapter {
  private readonly options: OpenRouterSpeechAdapterOptions;

  constructor(options: OpenRouterSpeechAdapterOptions) {
    if (!options.sttApiKey || !options.ttsApiKey) {
      throw new SpeechError("VOICE_NOT_CONFIGURED", "both speech keys must be configured");
    }
    if (options.sttApiKey === options.ttsApiKey) {
      throw new SpeechError(
        "VOICE_NOT_CONFIGURED",
        "the dedicated STT key must differ from the shared TTS/reasoning key",
      );
    }
    this.options = options;
  }

  /** One attempt: fetch + body read inside the deadline, classified by signal. */
  private async transport(params: {
    url: string;
    apiKey: string;
    body: Record<string, unknown>;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<{
    response: Response;
    latencyMs: number;
    timeout: AbortController;
    timer: ReturnType<typeof setTimeout>;
  }> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error("speech timeout")), params.timeoutMs);
    const started = Date.now();
    try {
      const response = await fetchImpl(params.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${params.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(params.body),
        signal: combineAbortSignals([params.signal, timeout.signal]),
      });
      return { response, latencyMs: Date.now() - started, timeout, timer };
    } catch (error) {
      clearTimeout(timer);
      if (params.signal.aborted) {
        throw new SpeechError("VOICE_REQUEST_ABORTED", "the speech request was cancelled", false);
      }
      if (timeout.signal.aborted) {
        throw new SpeechError("VOICE_TIMEOUT", "the speech request timed out", true);
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new SpeechError("VOICE_REQUEST_ABORTED", "the speech request was cancelled", false);
      }
      throw new SpeechError(
        "VOICE_UPSTREAM_FAILED",
        error instanceof Error ? error.message : "unknown speech transport failure",
        true,
      );
    }
  }

  async transcribe(request: SpeechTranscriptionRequest): Promise<SpeechTranscriptionResult> {
    const startedAt = Date.now();
    const { response, timeout, timer } = await this.transport({
      url: OPENROUTER_TRANSCRIPTIONS_URL,
      apiKey: this.options.sttApiKey,
      timeoutMs: this.options.sttTimeoutMs,
      signal: request.signal,
      body: {
        model: this.options.sttModel,
        input_audio: {
          data: Buffer.from(request.audio).toString("base64"),
          format: "wav",
        },
        response_format: "json",
      },
    });
    try {
      const generationId = generationIdOf(response);
      if (!response.ok) {
        throw classifyHttpFailure(response.status);
      }
      const body = await readBodyWithCap(response.body, MAX_STT_RESPONSE_BYTES);
      if (!body.ok) {
        throw new SpeechError(
          "VOICE_UPSTREAM_FAILED",
          "the transcription response exceeded the safe size cap",
          false,
        );
      }
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(body.bytes));
      } catch {
        throw new SpeechError(
          "VOICE_UPSTREAM_FAILED",
          "the transcription response was not valid JSON",
          false,
        );
      }
      const parsed = transcriptionPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        throw new SpeechError(
          "VOICE_UPSTREAM_FAILED",
          "the transcription response failed validation",
          false,
        );
      }
      const text = parsed.data.text.trim();
      if (text.length === 0) {
        throw new SpeechError("VOICE_NO_SPEECH", "no speech was detected in the recording", false);
      }
      if (text.length > this.options.maxTranscriptCharacters) {
        throw new SpeechError(
          "VOICE_TRANSCRIPT_TOO_LONG",
          `the transcript exceeds the ${String(this.options.maxTranscriptCharacters)}-character limit`,
          false,
        );
      }
      const seconds = parsed.data.usage?.seconds;
      const cost = usageCostFromNumber(parsed.data.usage?.cost);
      const usage: SpeechUsage = {
        latencyMs: Date.now() - startedAt,
        costStatus: cost !== undefined ? "actual" : "estimated",
        ...(cost !== undefined ? { costUsd: cost } : {}),
        ...(seconds !== undefined ? { units: seconds } : {}),
        unitKind: "audio_seconds",
        ...(generationId !== undefined ? { generationId } : {}),
      };
      return { text, usage };
    } catch (error) {
      throw classifyBodyFailure(error, request.signal, timeout.signal);
    } finally {
      clearTimeout(timer);
      timeout.abort(new Error("speech response settled"));
    }
  }

  async synthesize(request: SpeechSynthesisRequest): Promise<SpeechSynthesisResult> {
    const startedAt = Date.now();
    const { response, timeout, timer } = await this.transport({
      url: OPENROUTER_SPEECH_URL,
      apiKey: this.options.ttsApiKey,
      timeoutMs: this.options.ttsTimeoutMs,
      signal: request.signal,
      body: {
        model: this.options.ttsModel,
        input: request.text,
        voice: this.options.ttsVoice,
        response_format: "mp3",
      },
    });
    try {
      const generationId = generationIdOf(response);
      if (!response.ok) {
        throw classifyHttpFailure(response.status);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("audio/mpeg")) {
        throw new SpeechError(
          "VOICE_UPSTREAM_FAILED",
          `the speech response has an unexpected content type "${contentType}"`,
          false,
        );
      }
      const body = await readBodyWithCap(response.body, this.options.maxResponseAudioBytes);
      if (!body.ok) {
        throw new SpeechError(
          "VOICE_UPSTREAM_FAILED",
          "the speech response exceeded the audio size cap",
          false,
        );
      }
      if (body.bytes.byteLength === 0) {
        throw new SpeechError(
          "VOICE_UPSTREAM_FAILED",
          "the speech response contained no audio",
          false,
        );
      }
      const usage: SpeechUsage = {
        latencyMs: Date.now() - startedAt,
        costStatus: "estimated",
        units: request.text.length,
        unitKind: "characters",
        ...(generationId !== undefined ? { generationId } : {}),
      };
      return { audio: body.bytes, contentType: "audio/mpeg", usage };
    } catch (error) {
      throw classifyBodyFailure(error, request.signal, timeout.signal);
    } finally {
      clearTimeout(timer);
      timeout.abort(new Error("speech response settled"));
    }
  }
}
