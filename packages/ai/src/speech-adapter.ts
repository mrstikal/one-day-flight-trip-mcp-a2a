import type { VoiceUnitKind } from "@odft/contracts";

/**
 * Provider-independent speech adapter contract (VOICE_CONTROLL.md sections 7-8).
 *
 * The interface contains no OpenRouter request type, SDK, or database entity.
 * Reservations, settlement, budget checks, and persistence belong to the
 * surrounding BFF voice service, never to the adapter. Speech transport has
 * exactly one attempt: an explicit user retry creates a new request and a new
 * reservation, and the adapter itself never auto-retries a billable call.
 */

/** Safe adapter failure codes from the section-12 taxonomy (plus caller abort). */
export type SpeechErrorCode =
  | "VOICE_NOT_CONFIGURED"
  | "VOICE_CAPABILITY_UNKNOWN"
  | "VOICE_NO_SPEECH"
  | "VOICE_TRANSCRIPT_TOO_LONG"
  | "VOICE_UPSTREAM_FAILED"
  | "VOICE_TIMEOUT"
  | "VOICE_REQUEST_ABORTED";

/**
 * Typed speech failure. `retryable` describes whether a deliberate user retry
 * could help; it is never permission for an automatic billable retry.
 * `ledgerOutcome` tells the BFF voice service how to close the reservation:
 * `failed` only when the provider provably rejected the request before doing
 * (billable) work; everything uncertain stays `unknown` and keeps the
 * reservation until explicit reconciliation.
 * `VOICE_REQUEST_ABORTED` is a deliberate caller cancellation, not a provider
 * failure, and must not surface as a successful result.
 */
export class SpeechError extends Error {
  readonly code: SpeechErrorCode;
  readonly retryable: boolean;
  readonly ledgerOutcome: "failed" | "unknown";

  constructor(
    code: SpeechErrorCode,
    message: string,
    retryable = false,
    ledgerOutcome: "failed" | "unknown" = "unknown",
  ) {
    super(message);
    this.name = "SpeechError";
    this.code = code;
    this.retryable = retryable;
    this.ledgerOutcome = ledgerOutcome;
  }
}

/**
 * Safe accounting information only: latency, actual/estimated cost, optional
 * generation ID, and measured seconds/character units when authoritative.
 * Never audio, transcripts, reply text, keys, or provider payloads.
 */
export interface SpeechUsage {
  readonly latencyMs: number;
  readonly costStatus: "actual" | "estimated";
  /** Provider-reported actual cost when authoritative. */
  readonly costUsd?: string;
  /** Authoritative billing units (audio seconds or characters) when measured. */
  readonly units?: number;
  readonly unitKind: VoiceUnitKind;
  /** Documented `X-Generation-Id` when present, for server-side reconciliation. */
  readonly generationId?: string;
}

export interface SpeechTranscriptionRequest {
  readonly audio: Uint8Array;
  readonly format: "wav";
  readonly signal: AbortSignal;
}

export interface SpeechTranscriptionResult {
  readonly text: string;
  readonly usage: SpeechUsage;
}

export interface SpeechSynthesisRequest {
  readonly text: string;
  readonly signal: AbortSignal;
}

export interface SpeechSynthesisResult {
  readonly audio: Uint8Array;
  readonly contentType: "audio/mpeg" | "audio/wav";
  readonly usage: SpeechUsage;
}

export interface SpeechAdapter {
  transcribe(request: SpeechTranscriptionRequest): Promise<SpeechTranscriptionResult>;
  synthesize(request: SpeechSynthesisRequest): Promise<SpeechSynthesisResult>;
}

export type SpeechFetch = typeof globalThis.fetch;

/** Combine caller cancellation with the configured deadline (adapter-owned). */
export function combineAbortSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) {
      continue;
    }
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/**
 * Read a response body with a hard byte cap without trusting `Content-Length`.
 * The stream is cancelled as soon as the cap is exceeded, so an oversized or
 * lying upstream body can never be fully buffered.
 */
export async function readBodyWithCap(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  if (!body) {
    return { ok: true, bytes: new Uint8Array(0) };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          return { ok: false };
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/**
 * Convert a provider JSON cost number into a fixed nine-decimal USD string,
 * rounding UP so a reported charge is never understated.
 */
export function usageCostFromNumber(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  const nanos = Math.ceil(value * 1e9);
  if (!Number.isFinite(nanos) || nanos < 0) {
    return undefined;
  }
  const whole = Math.floor(nanos / 1e9);
  const fraction = String(nanos % 1e9).padStart(9, "0");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed.length > 0 ? `${String(whole)}.${trimmed}` : String(whole);
}
