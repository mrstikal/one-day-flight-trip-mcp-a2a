import { describe, expect, it } from "vitest";
import {
  downmixToMono,
  encodePcmWav,
  inspectCanonicalWav,
  VOICE_WAV_HEADER_BYTES,
  VOICE_WAV_MAX_SAMPLES,
  VOICE_WAV_SAMPLE_RATE,
} from "../../../apps/web/src/lib/voice-audio.js";

/**
 * T-UT-VOICE-04 (VOICE_CONTROLL.md section 15): canonical RIFF/WAVE PCM
 * parameters, the exact 60-second sample threshold, and rejection of malformed
 * lengths, stereo, non-PCM, and wrong-rate files.
 */

function silentSamples(count: number): Float32Array {
  return new Float32Array(count);
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

describe("encodePcmWav", () => {
  it("produces the canonical 44-byte header and PCM16 payload", () => {
    const samples = silentSamples(16_000);
    const bytes = encodePcmWav(samples);
    expect(bytes.byteLength).toBe(VOICE_WAV_HEADER_BYTES + 32_000);
    const inspection = inspectCanonicalWav(bytes);
    expect(inspection).toEqual({
      ok: true,
      info: { sampleCount: 16_000, durationSeconds: 1, byteLength: bytes.byteLength },
    });
  });

  it("clamps out-of-range samples instead of wrapping", () => {
    const bytes = encodePcmWav(new Float32Array([2, -2, 0]));
    const view = viewOf(bytes);
    expect(view.getInt16(44, true)).toBe(32_767);
    expect(view.getInt16(46, true)).toBe(-32_768);
    expect(view.getInt16(48, true)).toBe(0);
  });

  it("refuses to encode empty or over-long recordings instead of truncating", () => {
    expect(() => encodePcmWav(silentSamples(0))).toThrow(/empty/);
    expect(() => encodePcmWav(silentSamples(VOICE_WAV_MAX_SAMPLES + 1))).toThrow(/60-second/);
  });
});

describe("inspectCanonicalWav", () => {
  it("accepts exactly 60 seconds and rejects one sample more", () => {
    const exact = encodePcmWav(silentSamples(VOICE_WAV_MAX_SAMPLES));
    const result = inspectCanonicalWav(exact);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.info.sampleCount).toBe(960_000);
      expect(result.info.durationSeconds).toBe(60);
    }
    // One extra sample written directly into a copy of the 60-second file.
    const longer = new Uint8Array(exact.byteLength + 2);
    longer.set(exact, 0);
    const longerView = viewOf(longer);
    longerView.setUint32(4, longer.byteLength - 8, true);
    longerView.setUint32(40, longer.byteLength - VOICE_WAV_HEADER_BYTES, true);
    expect(inspectCanonicalWav(longer)).toEqual({ ok: false, rejection: "too_long" });
  });

  it("rejects malformed headers and PCM parameters", () => {
    const canonical = encodePcmWav(silentSamples(100));
    const mutate = (apply: (view: DataView) => void): Uint8Array => {
      const copy = new Uint8Array(canonical);
      apply(viewOf(copy));
      return copy;
    };
    expect(inspectCanonicalWav(canonical.subarray(0, 40))).toEqual({
      ok: false,
      rejection: "truncated_header",
    });
    expect(
      inspectCanonicalWav(
        mutate((view) => {
          view.setUint8(0, 0x58);
        }),
      ),
    ).toEqual({ ok: false, rejection: "not_riff" });
    expect(
      inspectCanonicalWav(
        mutate((view) => {
          view.setUint8(8, 0x58);
        }),
      ),
    ).toEqual({ ok: false, rejection: "not_wave" });
    expect(
      inspectCanonicalWav(
        mutate((view) => {
          view.setUint32(4, canonical.byteLength, true);
        }),
      ),
    ).toEqual({ ok: false, rejection: "bad_riff_size" });
    expect(
      inspectCanonicalWav(
        mutate((view) => {
          view.setUint32(16, 18, true);
        }),
      ),
    ).toEqual({ ok: false, rejection: "bad_fmt_chunk_size" });
    expect(
      inspectCanonicalWav(
        mutate((view) => {
          view.setUint16(20, 3, true);
        }),
      ),
    ).toEqual({ ok: false, rejection: "not_pcm" });
    expect(
      inspectCanonicalWav(
        mutate((view) => {
          view.setUint16(22, 2, true);
        }),
      ),
    ).toEqual({ ok: false, rejection: "wrong_channel_count" });
    expect(
      inspectCanonicalWav(
        mutate((view) => {
          view.setUint32(24, 44_100, true);
        }),
      ),
    ).toEqual({ ok: false, rejection: "wrong_sample_rate" });
    expect(
      inspectCanonicalWav(
        mutate((view) => {
          view.setUint32(28, 32_001, true);
        }),
      ),
    ).toEqual({ ok: false, rejection: "bad_byte_rate" });
    expect(
      inspectCanonicalWav(
        mutate((view) => {
          view.setUint16(32, 4, true);
        }),
      ),
    ).toEqual({ ok: false, rejection: "bad_block_align" });
    expect(
      inspectCanonicalWav(
        mutate((view) => {
          view.setUint16(34, 8, true);
        }),
      ),
    ).toEqual({ ok: false, rejection: "wrong_bit_depth" });
    expect(
      inspectCanonicalWav(
        mutate((view) => {
          view.setUint8(36, 0x58);
        }),
      ),
    ).toEqual({ ok: false, rejection: "missing_data_chunk" });
  });

  it("rejects odd data lengths, trailing bytes, and empty audio", () => {
    const canonical = encodePcmWav(silentSamples(100));
    const odd = new Uint8Array(canonical.byteLength + 1);
    odd.set(canonical, 0);
    const oddView = viewOf(odd);
    oddView.setUint32(4, odd.byteLength - 8, true);
    oddView.setUint32(40, odd.byteLength - VOICE_WAV_HEADER_BYTES, true);
    expect(inspectCanonicalWav(odd)).toEqual({ ok: false, rejection: "odd_data_length" });

    const trailing = new Uint8Array(canonical.byteLength + 2);
    trailing.set(canonical, 0);
    viewOf(trailing).setUint32(4, trailing.byteLength - 8, true);
    expect(inspectCanonicalWav(trailing)).toEqual({ ok: false, rejection: "length_mismatch" });

    const empty = new Uint8Array(VOICE_WAV_HEADER_BYTES);
    empty.set(canonical.subarray(0, VOICE_WAV_HEADER_BYTES), 0);
    const emptyView = viewOf(empty);
    emptyView.setUint32(4, empty.byteLength - 8, true);
    emptyView.setUint32(40, 0, true);
    expect(inspectCanonicalWav(empty)).toEqual({ ok: false, rejection: "empty_audio" });
  });

  it("derives duration from the sample count and not from any client field", () => {
    const bytes = encodePcmWav(silentSamples(VOICE_WAV_SAMPLE_RATE + 8_000));
    const result = inspectCanonicalWav(bytes);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.info.durationSeconds).toBe(1.5);
    }
  });
});

describe("downmixToMono", () => {
  it("averages channels deterministically", () => {
    const left = new Float32Array([1, 0, -1]);
    const right = new Float32Array([0, 1, 1]);
    expect(Array.from(downmixToMono([left, right]))).toEqual([0.5, 0.5, 0]);
  });

  it("returns a single channel unchanged and refuses an empty list", () => {
    const mono = new Float32Array([0.25, -0.25]);
    expect(downmixToMono([mono])).toBe(mono);
    expect(() => downmixToMono([])).toThrow(/zero channels/);
  });
});
