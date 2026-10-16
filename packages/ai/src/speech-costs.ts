import { formatUsd } from "./costs.js";
import { SpeechError } from "./speech-adapter.js";
import type { VoiceKind } from "@odft/contracts";

/**
 * Exact speech billing arithmetic (VOICE_CONTROLL.md sections 5 and 9).
 *
 * Published speech tariffs are raw decimal strings that may carry more than the
 * nine fractional digits `parseUsd` accepts (the observed Groq rate has
 * sixteen). They are parsed as exact integer numerator/denominator values; only
 * the final reservation is rounded UP to USD nanos and persisted at
 * `numeric(18,9)`. Never float, never `parseUsd`, never a silent zero.
 */

const NANOS_PER_USD = 1_000_000_000n;

/** Canonical recording sample rate; a WAV second is 16,000 mono PCM samples. */
export const SPEECH_AUDIO_SAMPLE_RATE = 16_000;

export interface ExactDecimal {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/** The tariff view speech costs need; rates are undiscounted upper bounds. */
export interface SpeechTariff {
  readonly unit: "audio_seconds" | "characters";
  /** Raw USD per unit (more than nine fractional digits allowed). */
  readonly ratePerUnit: string;
  /** Minimum billed units as a raw decimal string ("0" when none documented). */
  readonly minimumUnits: string;
  /** Per-request fee in USD as a raw decimal string ("0" when none published). */
  readonly requestFeeUsd: string;
}

export const SPEECH_UNIT_BY_KIND: Readonly<Record<VoiceKind, SpeechTariff["unit"]>> = {
  stt: "audio_seconds",
  tts: "characters",
};

/** Parse a raw nonnegative decimal string with arbitrary fractional length. */
export function parseExactDecimal(value: string, label: string): ExactDecimal {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new SpeechError("VOICE_CAPABILITY_UNKNOWN", `invalid ${label}: "${value}"`);
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole) * denominator + BigInt(fraction || "0");
  return { numerator, denominator };
}

function ceilDiv(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

/** Compare two raw decimals exactly (-1, 0, 1). */
export function compareExactDecimals(a: string, b: string): number {
  const left = parseExactDecimal(a, "decimal");
  const right = parseExactDecimal(b, "decimal");
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
}

/** Return the larger of two raw decimals, preserving the winning raw string. */
export function maxExactDecimal(a: string, b: string): string {
  return compareExactDecimals(a, b) >= 0 ? a : b;
}

/** Ceil a raw decimal to a nonnegative integer unit count. */
export function ceilExactToInteger(value: string, label: string): number {
  const exact = parseExactDecimal(value, label);
  const units = ceilDiv(exact.numerator, exact.denominator);
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SpeechError("VOICE_CAPABILITY_UNKNOWN", `${label} is unreasonably large: "${value}"`);
  }
  return Number(units);
}

/** Exact cost of `units` integer units at a raw rate, rounded UP to USD nanos. */
export function costNanos(rate: string, units: number): bigint {
  if (!Number.isSafeInteger(units) || units < 0) {
    throw new SpeechError(
      "VOICE_CAPABILITY_UNKNOWN",
      `invalid billed unit count: ${String(units)}`,
    );
  }
  const exact = parseExactDecimal(rate, "rate");
  return ceilDiv(exact.numerator * BigInt(units) * NANOS_PER_USD, exact.denominator);
}

/** Billed audio seconds for a validated WAV: ceil(samples / 16,000), minimum 1. */
export function billedAudioSeconds(samples: number): number {
  if (!Number.isSafeInteger(samples) || samples < 0) {
    throw new SpeechError("VOICE_CAPABILITY_UNKNOWN", `invalid sample count: ${String(samples)}`);
  }
  return Math.max(1, Math.ceil(samples / SPEECH_AUDIO_SAMPLE_RATE));
}

/**
 * UTF-16 length is the conservative character count: it never underestimates
 * astral characters (an emoji counts as two units) and never assumes byte or
 * token billing.
 */
export function billedCharacters(text: string): number {
  return text.length;
}

function feeNanos(fee: string): bigint {
  return costNanos(fee, 1);
}

/**
 * Conservative STT reservation: `max(ceil(audio seconds), minimum seconds) *`
 * worst second rate + fees, rounded up to nanos. Never applied to TTS.
 */
export function reserveSttCostNanos(tariff: SpeechTariff, wavSamples: number): bigint {
  const seconds = Math.max(
    billedAudioSeconds(wavSamples),
    ceilExactToInteger(tariff.minimumUnits, "minimum billing seconds"),
  );
  return costNanos(tariff.ratePerUnit, seconds) + feeNanos(tariff.requestFeeUsd);
}

/** Conservative TTS reservation: character units × worst character rate + fees. */
export function reserveTtsCostNanos(tariff: SpeechTariff, text: string): bigint {
  const units = Math.max(
    billedCharacters(text),
    ceilExactToInteger(tariff.minimumUnits, "minimum billing characters"),
  );
  return costNanos(tariff.ratePerUnit, units) + feeNanos(tariff.requestFeeUsd);
}

/** Worst-case call cost in USD for the profile maxima (diagnostics/tests). */
export function worstCallCostUsd(tariff: SpeechTariff, maxUnits: number): string {
  return formatUsd(costNanos(tariff.ratePerUnit, maxUnits) + feeNanos(tariff.requestFeeUsd));
}
