/**
 * Canonical PCM WAV codec (VOICE_CONTROLL.md section 10).
 *
 * The browser recording pipeline downmixes and resamples to 16 kHz mono, then
 * encodes this exact canonical layout for upload; the server validates the
 * uploaded bytes with the same pure inspector and derives duration from the
 * sample count, never from a client field. Pure module: no browser globals, so
 * both the client hook and the BFF route can import it.
 */

export const VOICE_WAV_SAMPLE_RATE = 16_000;
export const VOICE_WAV_CHANNELS = 1;
export const VOICE_WAV_BITS_PER_SAMPLE = 16;
export const VOICE_WAV_HEADER_BYTES = 44;
/** 60 seconds at 16 kHz mono. */
export const VOICE_WAV_MAX_SAMPLES = 960_000;
export const VOICE_WAV_MAX_DATA_BYTES = VOICE_WAV_MAX_SAMPLES * 2;

const RIFF_SIZE_OFFSET = 4;
const FMT_OFFSET = 12;
const DATA_OFFSET = 36;

export type WavRejection =
  | "truncated_header"
  | "bad_riff_size"
  | "not_riff"
  | "not_wave"
  | "missing_fmt_chunk"
  | "bad_fmt_chunk_size"
  | "not_pcm"
  | "wrong_channel_count"
  | "wrong_sample_rate"
  | "wrong_bit_depth"
  | "bad_block_align"
  | "bad_byte_rate"
  | "missing_data_chunk"
  | "odd_data_length"
  | "length_mismatch"
  | "empty_audio"
  | "too_long";

export interface CanonicalWavInfo {
  readonly sampleCount: number;
  readonly durationSeconds: number;
  readonly byteLength: number;
}

export type WavInspection =
  | { readonly ok: true; readonly info: CanonicalWavInfo }
  | { readonly ok: false; readonly rejection: WavRejection };

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return text;
}

/**
 * Validate the strict canonical upload layout: 44-byte header, PCM format 1,
 * one channel, 16 kHz, 16-bit, block align 2, byte rate 32,000, even data
 * length exactly matching the file/header lengths, and 1..960,000 samples.
 * Anything else (stereo, float, wrong rate, extra chunks, malformed lengths)
 * is rejected instead of repaired.
 */
export function inspectCanonicalWav(bytes: Uint8Array): WavInspection {
  if (bytes.byteLength < VOICE_WAV_HEADER_BYTES) {
    return { ok: false, rejection: "truncated_header" };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(bytes, 0, 4) !== "RIFF") {
    return { ok: false, rejection: "not_riff" };
  }
  if (view.getUint32(RIFF_SIZE_OFFSET, true) !== bytes.byteLength - 8) {
    return { ok: false, rejection: "bad_riff_size" };
  }
  if (ascii(bytes, 8, 4) !== "WAVE") {
    return { ok: false, rejection: "not_wave" };
  }
  if (ascii(bytes, FMT_OFFSET, 4) !== "fmt ") {
    return { ok: false, rejection: "missing_fmt_chunk" };
  }
  if (view.getUint32(16, true) !== 16) {
    return { ok: false, rejection: "bad_fmt_chunk_size" };
  }
  if (view.getUint16(20, true) !== 1) {
    return { ok: false, rejection: "not_pcm" };
  }
  if (view.getUint16(22, true) !== VOICE_WAV_CHANNELS) {
    return { ok: false, rejection: "wrong_channel_count" };
  }
  if (view.getUint32(24, true) !== VOICE_WAV_SAMPLE_RATE) {
    return { ok: false, rejection: "wrong_sample_rate" };
  }
  if (view.getUint32(28, true) !== VOICE_WAV_SAMPLE_RATE * 2) {
    return { ok: false, rejection: "bad_byte_rate" };
  }
  if (view.getUint16(32, true) !== 2) {
    return { ok: false, rejection: "bad_block_align" };
  }
  if (view.getUint16(34, true) !== VOICE_WAV_BITS_PER_SAMPLE) {
    return { ok: false, rejection: "wrong_bit_depth" };
  }
  if (ascii(bytes, DATA_OFFSET, 4) !== "data") {
    return { ok: false, rejection: "missing_data_chunk" };
  }
  const dataBytes = view.getUint32(40, true);
  if (dataBytes % 2 !== 0) {
    return { ok: false, rejection: "odd_data_length" };
  }
  if (bytes.byteLength !== VOICE_WAV_HEADER_BYTES + dataBytes) {
    return { ok: false, rejection: "length_mismatch" };
  }
  const sampleCount = dataBytes / 2;
  if (sampleCount === 0) {
    return { ok: false, rejection: "empty_audio" };
  }
  if (sampleCount > VOICE_WAV_MAX_SAMPLES) {
    return { ok: false, rejection: "too_long" };
  }
  return {
    ok: true,
    info: {
      sampleCount,
      durationSeconds: sampleCount / VOICE_WAV_SAMPLE_RATE,
      byteLength: bytes.byteLength,
    },
  };
}

function clampToInt16(value: number): number {
  if (Number.isNaN(value) || value <= -1) {
    return -32_768;
  }
  if (value >= 1) {
    return 32_767;
  }
  return Math.round(value * 32_767);
}

/**
 * Encode float samples (already 16 kHz mono, roughly -1..1) as a canonical PCM
 * WAV. The caller enforces the 60-second bound; encoding throws instead of
 * silently truncating.
 */
export function encodePcmWav(samples: ArrayLike<number>): Uint8Array {
  if (samples.length === 0) {
    throw new Error("cannot encode an empty recording");
  }
  if (samples.length > VOICE_WAV_MAX_SAMPLES) {
    throw new Error("the recording exceeds the 60-second sample limit");
  }
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(VOICE_WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(RIFF_SIZE_OFFSET, bytes.byteLength - 8, true);
  writeAscii(8, "WAVE");
  writeAscii(FMT_OFFSET, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, VOICE_WAV_CHANNELS, true);
  view.setUint32(24, VOICE_WAV_SAMPLE_RATE, true);
  view.setUint32(28, VOICE_WAV_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, VOICE_WAV_BITS_PER_SAMPLE, true);
  writeAscii(DATA_OFFSET, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(VOICE_WAV_HEADER_BYTES + index * 2, clampToInt16(samples[index] ?? 0), true);
  }
  return bytes;
}

/** Deterministic channel downmix: the arithmetic mean of all channels. */
export function downmixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) {
    throw new Error("cannot downmix zero channels");
  }
  const first = channels[0];
  if (!first) {
    throw new Error("cannot downmix an empty channel");
  }
  if (channels.length === 1) {
    return first;
  }
  const mixed = new Float32Array(first.length);
  for (let index = 0; index < first.length; index += 1) {
    let sum = 0;
    for (const channel of channels) {
      sum += channel[index] ?? 0;
    }
    mixed[index] = sum / channels.length;
  }
  return mixed;
}
