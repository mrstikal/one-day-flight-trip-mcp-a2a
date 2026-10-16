import { describe, expect, it } from "vitest";
import {
  applyVadOrtBaseline,
  beginCapture,
  cancelCapture,
  captureReady,
  dictationFramesForSilence,
  durationLimit,
  INITIAL_CAPTURE_STATE,
  isActiveGeneration,
  manualStop,
  silenceCompletionMs,
  speechEnd,
  speechStart,
  vadMisfire,
  END_OF_DICTATION_SILENCE_MS,
  VOICE_VAD_OPTIONS,
  type CaptureState,
} from "../../../apps/web/src/lib/voice-vad.js";

/**
 * T-UT-VOICE-13/14 (VOICE_CONTROLL.md section 15): VAD defaults and the
 * documented frame granularity, first-speech gating, misfires, silence/manual/
 * duration stop races finalizing exactly once, cancellation discarding, and
 * stale callbacks that can never stop a new capture.
 */

function recording(): { state: CaptureState; generation: number } {
  const state = captureReady(beginCapture(INITIAL_CAPTURE_STATE), 1);
  return { state, generation: 1 };
}

describe("VAD frame granularity", () => {
  it("pins every documented detector option", () => {
    expect(VOICE_VAD_OPTIONS.model).toBe("v5");
    expect(VOICE_VAD_OPTIONS.positiveSpeechThreshold).toBe(0.3);
    expect(VOICE_VAD_OPTIONS.negativeSpeechThreshold).toBe(0.25);
    expect(VOICE_VAD_OPTIONS.minSpeechMs).toBe(100);
    expect(VOICE_VAD_OPTIONS.preSpeechPadMs).toBe(300);
    expect(VOICE_VAD_OPTIONS.redemptionMs).toBe(END_OF_DICTATION_SILENCE_MS);
  });

  it("configures the single-thread, no-proxy ONNX baseline explicitly", () => {
    const ort = { env: { wasm: { numThreads: 4, proxy: true } } };
    applyVadOrtBaseline(ort);
    expect(ort.env.wasm).toEqual({ numThreads: 1, proxy: false });
  });

  it("documents the 32 ms frames and the ~2,016 ms completion boundary", () => {
    expect(VOICE_VAD_OPTIONS.redemptionMs).toBe(END_OF_DICTATION_SILENCE_MS);
    expect(dictationFramesForSilence()).toBe(63);
    // 62 frames are NOT enough (1,984 ms < 2,000 ms); 63 first reach it.
    expect(62 * 32).toBe(1_984);
    expect(62 * 32).toBeLessThan(END_OF_DICTATION_SILENCE_MS);
    expect(silenceCompletionMs()).toBe(2_016);
    expect(silenceCompletionMs()).toBeGreaterThanOrEqual(END_OF_DICTATION_SILENCE_MS);
  });
});

describe("capture session machine", () => {
  it("arms the automatic ending only after confirmed speech", () => {
    const { state, generation } = recording();
    // Initial silence: onSpeechEnd from an unconfirmed session finalizes nothing.
    const beforeSpeech = speechEnd(state, generation);
    expect(beforeSpeech.finalize).toBe(false);
    expect(beforeSpeech.state.phase).toBe("recording");

    const confirmed = speechStart(state, generation);
    expect(confirmed.hasConfirmedSpeech).toBe(true);
    const ending = speechEnd(confirmed, generation);
    expect(ending.finalize).toBe(true);
    expect(ending.state).toMatchObject({ phase: "stopping", stopGate: true });
  });

  it("keeps listening through misfires and renewed speech", () => {
    const { state, generation } = recording();
    const afterMisfire = vadMisfire(speechStart(state, generation), generation);
    expect(afterMisfire.hasConfirmedSpeech).toBe(true);
    expect(afterMisfire.phase).toBe("recording");
    const second = speechStart(afterMisfire, generation);
    expect(second.hasConfirmedSpeech).toBe(true);
  });

  it("finalizes exactly once across silence, manual stop, and the duration timer", () => {
    const { state, generation } = recording();
    const confirmed = speechStart(state, generation);
    const silence = speechEnd(confirmed, generation);
    expect(silence.finalize).toBe(true);

    // Repeated VAD end callbacks and a simultaneous manual stop are no-ops.
    expect(speechEnd(silence.state, generation).finalize).toBe(false);
    expect(manualStop(silence.state, generation).finalize).toBe(false);
    expect(durationLimit(silence.state, generation)).toMatchObject({
      finalize: false,
      discard: false,
    });

    // A manually stopped recording without VAD confirmation still finalizes
    // (accommodates a VAD false negative).
    const manual = manualStop(state, generation);
    expect(manual.finalize).toBe(true);
    expect(durationLimit(manual.state, generation).finalize).toBe(false);
  });

  it("discards a speechless hard-limit recording with no STT", () => {
    const { state, generation } = recording();
    const limit = durationLimit(state, generation);
    expect(limit.discard).toBe(true);
    expect(limit.finalize).toBe(false);
    expect(limit.state).toMatchObject({ phase: "stopping", stopGate: true });
  });

  it("cancel invalidates the generation and late callbacks cannot stop a new capture", () => {
    const { state, generation } = recording();
    const cancelled = cancelCapture(speechStart(state, generation));
    expect(isActiveGeneration(cancelled, generation)).toBe(false);

    // Late callbacks from the cancelled generation are inert.
    expect(speechEnd(cancelled, generation).finalize).toBe(false);
    expect(manualStop(cancelled, generation).finalize).toBe(false);
    expect(durationLimit(cancelled, generation).finalize).toBe(false);

    // A new capture gets a new generation; old tokens still cannot finalize it.
    const next = captureReady(beginCapture(cancelled), cancelled.generation + 1);
    expect(next.phase).toBe("recording");
    expect(speechEnd(next, generation).finalize).toBe(false);
    expect(manualStop(next, generation).finalize).toBe(false);
    // The duration timer of the old generation is inert for the new capture.
    expect(durationLimit(next, generation)).toMatchObject({ finalize: false, discard: false });
  });

  it("cancelling during preparation discards before any finalize", () => {
    const preparing = beginCapture(INITIAL_CAPTURE_STATE);
    expect(preparing.phase).toBe("preparing");
    expect(speechEnd(preparing, preparing.generation).finalize).toBe(false);
    const cancelled = cancelCapture(preparing);
    expect(cancelled.phase).toBe("idle");
    expect(isActiveGeneration(cancelled, preparing.generation)).toBe(false);
  });
});
