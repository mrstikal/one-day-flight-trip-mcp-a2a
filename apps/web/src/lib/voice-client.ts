import {
  publicVoiceCapabilitiesSchema,
  voiceTranscriptionResponseSchema,
  type PublicVoiceCapabilities,
  type VoiceTranscriptionResponse,
} from "@odft/contracts";
import { ApiError, apiGet, parseApiError } from "./api-client";
import { withCsrfSession } from "./session-client";

/**
 * Browser voice transport (VOICE_CONTROLL.md sections 7 and 11).
 *
 * Same-origin binary transport with the shared session/CSRF handling: raw WAV
 * out (never multipart), bounded JSON transcript back, and raw audio bytes for
 * synthesis — the successful TTS response is NEVER passed through JSON parsing.
 * A lost session is retried once with the SAME request id, so the server-side
 * idempotency key guarantees at most one billed provider call per request.
 */

export const VOICE_SYNTHESIS_CONTENT_TYPES = ["audio/mpeg", "audio/wav"] as const;
export type VoiceSynthesisContentType = (typeof VOICE_SYNTHESIS_CONTENT_TYPES)[number];

export interface SynthesizedReply {
  readonly audio: ArrayBuffer;
  readonly contentType: VoiceSynthesisContentType;
}

function invalidResponse(what: string): ApiError {
  return new ApiError({
    code: "INTERNAL_ERROR",
    message: `the ${what} response was not valid`,
    status: 200,
    retryable: false,
  });
}

/** GET the server voice availability/limits for the owned trip. */
export async function fetchVoiceCapabilities(tripId: string): Promise<PublicVoiceCapabilities> {
  const body = await apiGet<unknown>(`/api/trips/${tripId}/voice/capabilities`);
  const parsed = publicVoiceCapabilitiesSchema.safeParse(body);
  if (!parsed.success) {
    throw invalidResponse("voice capabilities");
  }
  return parsed.data;
}

/** POST one finished canonical WAV recording and return the transcript DTO. */
export async function submitTranscription(input: {
  readonly tripId: string;
  readonly requestId: string;
  readonly audio: Uint8Array;
  readonly signal?: AbortSignal;
}): Promise<VoiceTranscriptionResponse> {
  return withCsrfSession(async (csrfToken) => {
    const response = await fetch(`/api/trips/${input.tripId}/voice/transcribe`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "audio/wav",
        "x-voice-request-id": input.requestId,
        "x-csrf-token": csrfToken,
      },
      // `.slice()` yields a plain ArrayBuffer-backed view for BodyInit.
      body: input.audio.slice(),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!response.ok) {
      throw await parseApiError(response);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw invalidResponse("transcription");
    }
    const parsed = voiceTranscriptionResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw invalidResponse("transcription");
    }
    return parsed.data;
  });
}

/** POST a settled assistant message id and read the raw reply audio bytes. */
export async function fetchSynthesizedReply(input: {
  readonly tripId: string;
  readonly requestId: string;
  readonly messageId: string;
  readonly signal?: AbortSignal;
}): Promise<SynthesizedReply> {
  return withCsrfSession(async (csrfToken) => {
    const response = await fetch(`/api/trips/${input.tripId}/voice/synthesize`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        accept: "audio/mpeg, audio/wav",
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
      },
      body: JSON.stringify({ requestId: input.requestId, messageId: input.messageId }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!response.ok) {
      throw await parseApiError(response);
    }
    const contentType = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "audio/mpeg" && contentType !== "audio/wav") {
      throw invalidResponse("speech synthesis");
    }
    // Raw audio: never JSON-parse a successful synthesis response.
    const audio = await response.arrayBuffer();
    if (audio.byteLength === 0) {
      throw invalidResponse("speech synthesis");
    }
    return { audio, contentType };
  });
}
