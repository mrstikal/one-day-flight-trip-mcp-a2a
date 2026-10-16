import { describe, expect, it, vi } from "vitest";
import { FixtureSpeechAdapter, FIXTURE_TRANSCRIPT, SpeechError } from "@odft/ai";
import { inspectCanonicalWav } from "../../../apps/web/src/lib/voice-audio.js";

/**
 * T-UT-VOICE-08 (VOICE_CONTROLL.md section 15): the fixture response is the
 * known scripted transcript and generated valid WAV audio, with zero fetches
 * and zero live usage writes.
 */

const adapter = new FixtureSpeechAdapter();

describe("FixtureSpeechAdapter", () => {
  it("returns the known scripted transcript", async () => {
    const result = await adapter.transcribe({
      audio: new Uint8Array([1, 2, 3]),
      format: "wav",
      signal: new AbortController().signal,
    });
    expect(result.text).toBe(FIXTURE_TRANSCRIPT);
    expect(result.text).toBe("Make the day less exhausting");
    expect(result.usage).toMatchObject({
      costStatus: "actual",
      costUsd: "0",
      unitKind: "audio_seconds",
    });
  });

  it("generates short valid canonical WAV test audio for TTS", async () => {
    const result = await adapter.synthesize({
      text: "Read this aloud.",
      signal: new AbortController().signal,
    });
    expect(result.contentType).toBe("audio/wav");
    const inspection = inspectCanonicalWav(result.audio);
    expect(inspection.ok).toBe(true);
    if (inspection.ok) {
      expect(inspection.info.sampleCount).toBe(8_000);
      expect(inspection.info.durationSeconds).toBe(0.5);
    }
    expect(result.usage).toMatchObject({
      costStatus: "actual",
      costUsd: "0",
      unitKind: "characters",
    });
  });

  it("performs zero fetches and live usage writes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await adapter.transcribe({
        audio: new Uint8Array([1]),
        format: "wav",
        signal: new AbortController().signal,
      });
      await adapter.synthesize({ text: "hi", signal: new AbortController().signal });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("honors an aborted signal for both directions", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter.transcribe({ audio: new Uint8Array([1]), format: "wav", signal: controller.signal }),
    ).rejects.toBeInstanceOf(SpeechError);
    await expect(
      adapter.synthesize({ text: "hi", signal: controller.signal }),
    ).rejects.toMatchObject({ code: "VOICE_REQUEST_ABORTED" });
  });

  it("supports a deterministic scripted transcript override for wiring tests", async () => {
    const custom = new FixtureSpeechAdapter({ transcript: "scripted test transcript" });
    const result = await custom.transcribe({
      audio: new Uint8Array([1]),
      format: "wav",
      signal: new AbortController().signal,
    });
    expect(result.text).toBe("scripted test transcript");
  });
});
