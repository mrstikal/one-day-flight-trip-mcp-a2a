import {
  SpeechError,
  type SpeechAdapter,
  type SpeechSynthesisRequest,
  type SpeechSynthesisResult,
  type SpeechTranscriptionRequest,
  type SpeechTranscriptionResult,
  type SpeechUsage,
} from "./speech-adapter.js";

/**
 * Deterministic offline speech fixtures (VOICE_CONTROLL.md section 14, V02).
 *
 * Fixture mode makes zero external calls and creates no billable rows: STT
 * returns the known scripted transcript, TTS returns generated short valid
 * canonical PCM WAV bytes (16 kHz mono 16-bit), so the whole voice path can be
 * exercised in CI without any speech service.
 */

export const FIXTURE_TRANSCRIPT = "Make the day less exhausting";
/** Half a second of audio: 8,000 mono samples, 16,044 canonical WAV bytes. */
export const FIXTURE_TTS_SECONDS = 0.5;
export const FIXTURE_TONE_HZ = 440;

const FIXTURE_SAMPLE_RATE = 16_000;
const FIXTURE_HEADER_BYTES = 44;

/**
 * Build a valid canonical PCM WAV (44-byte header, PCM format 1, 16 kHz mono
 * 16-bit, even data length). Used as fixture TTS output; tests cross-check it
 * with the shared browser/server WAV inspector.
 */
export function fixtureWavBytes(
  seconds: number = FIXTURE_TTS_SECONDS,
  toneHz: number = FIXTURE_TONE_HZ,
): Uint8Array {
  const sampleCount = Math.round(seconds * FIXTURE_SAMPLE_RATE);
  const dataBytes = sampleCount * 2;
  const bytes = new Uint8Array(FIXTURE_HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, FIXTURE_SAMPLE_RATE, true);
  view.setUint32(28, FIXTURE_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.sin((2 * Math.PI * toneHz * index) / FIXTURE_SAMPLE_RATE);
    view.setInt16(FIXTURE_HEADER_BYTES + index * 2, Math.round(value * 0.25 * 32767), true);
  }
  return bytes;
}

export class FixtureSpeechAdapter implements SpeechAdapter {
  private readonly transcript: string;

  constructor(options: { readonly transcript?: string } = {}) {
    this.transcript = options.transcript ?? FIXTURE_TRANSCRIPT;
  }

  async transcribe(request: SpeechTranscriptionRequest): Promise<SpeechTranscriptionResult> {
    if (request.signal.aborted) {
      throw new SpeechError("VOICE_REQUEST_ABORTED", "the speech request was cancelled", false);
    }
    const usage: SpeechUsage = {
      latencyMs: 0,
      costStatus: "actual",
      costUsd: "0",
      unitKind: "audio_seconds",
    };
    return { text: this.transcript, usage };
  }

  async synthesize(request: SpeechSynthesisRequest): Promise<SpeechSynthesisResult> {
    if (request.signal.aborted) {
      throw new SpeechError("VOICE_REQUEST_ABORTED", "the speech request was cancelled", false);
    }
    const usage: SpeechUsage = {
      latencyMs: 0,
      costStatus: "actual",
      costUsd: "0",
      unitKind: "characters",
    };
    return { audio: fixtureWavBytes(), contentType: "audio/wav", usage };
  }
}
