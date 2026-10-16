/**
 * Browser-local VAD configuration (VOICE_CONTROLL.md section 10).
 *
 * Data-only module: the capture hook dynamically imports the pinned
 * `@ricky0123/vad-web` detector only after explicit Dictate activation and
 * passes these options. Both asset paths are explicitly same-origin
 * (`/voice-vad/`, prepared by `scripts/voice-vad-assets.ts`); library defaults
 * and example CDN URLs are never used.
 */

/** Speech pause that ends dictation automatically (documented milliseconds option). */
export const END_OF_DICTATION_SILENCE_MS = 2_000;
/** V5 processes 512 samples at 16 kHz: a 2,000 ms threshold completes ≈2,016 ms. */
export const VOICE_VAD_FRAME_MS = 32;
export const VOICE_VAD_ASSET_PATH = "/voice-vad/";
export const VOICE_VAD_MODEL = "v5";

export interface VoiceVadOptions {
  readonly model: "v5";
  readonly positiveSpeechThreshold: number;
  readonly negativeSpeechThreshold: number;
  readonly redemptionMs: number;
  readonly minSpeechMs: number;
  readonly preSpeechPadMs: number;
  readonly submitUserSpeechOnPause: false;
  readonly startOnLoad: false;
  readonly processorType: "AudioWorklet";
  readonly baseAssetPath: string;
  readonly onnxWASMBasePath: string;
}

/**
 * Initial detector settings from section 10. `redemptionMs` is the documented
 * millisecond silence threshold (never a frame count); the two probability
 * thresholds provide hysteresis. CPU/WASM with one thread and no proxy worker
 * is the compatibility baseline and is configured by the caller.
 */
export const VOICE_VAD_OPTIONS: VoiceVadOptions = {
  model: "v5",
  positiveSpeechThreshold: 0.3,
  negativeSpeechThreshold: 0.25,
  redemptionMs: END_OF_DICTATION_SILENCE_MS,
  minSpeechMs: 100,
  preSpeechPadMs: 300,
  submitUserSpeechOnPause: false,
  startOnLoad: false,
  processorType: "AudioWorklet",
  baseAssetPath: VOICE_VAD_ASSET_PATH,
  onnxWASMBasePath: VOICE_VAD_ASSET_PATH,
};

/* ------------------------------------------------------------------ */
/* Frame math (documented granularity, not wall-clock precision)       */
/* ------------------------------------------------------------------ */

/** Whole V5 frames the library needs for the configured silence threshold. */
export function dictationFramesForSilence(ms: number = END_OF_DICTATION_SILENCE_MS): number {
  return Math.ceil(ms / VOICE_VAD_FRAME_MS);
}

/**
 * Wall-clock duration at which the threshold can first complete: 63 frames of
 * 32 ms = 2,016 ms. 62 frames (1,984 ms) are NOT enough — boundary tests use
 * these exact frame counts instead of claiming sample-accurate timing.
 */
export function silenceCompletionMs(ms: number = END_OF_DICTATION_SILENCE_MS): number {
  return dictationFramesForSilence(ms) * VOICE_VAD_FRAME_MS;
}

/* ------------------------------------------------------------------ */
/* Capture session state machine                                       */
/* ------------------------------------------------------------------ */

export type CapturePhase = "idle" | "preparing" | "recording" | "stopping" | "finalizing";

export interface CaptureState {
  /** Monotonic token; every callback and async completion checks it. */
  readonly generation: number;
  readonly phase: CapturePhase;
  /** Set only by onSpeechRealStart: initial silence must not arm the ending. */
  readonly hasConfirmedSpeech: boolean;
  /** Finalize-once gate: set synchronously before awaiting cleanup/chunks. */
  readonly stopGate: boolean;
}

export const INITIAL_CAPTURE_STATE: CaptureState = {
  generation: 0,
  phase: "idle",
  hasConfirmedSpeech: false,
  stopGate: false,
};

/** Start a new capture session: fresh generation, gates reset. */
export function beginCapture(state: CaptureState): CaptureState {
  return {
    generation: state.generation + 1,
    phase: "preparing",
    hasConfirmedSpeech: false,
    stopGate: false,
  };
}

export function captureReady(state: CaptureState, generation: number): CaptureState {
  if (state.generation !== generation || state.phase !== "preparing") {
    return state;
  }
  return { ...state, phase: "recording" };
}

/** A stale callback belongs to an older generation and is always a no-op. */
export function isActiveGeneration(state: CaptureState, generation: number): boolean {
  return state.generation === generation;
}

/** Valid speech (onSpeechRealStart): arms the silence completion. */
export function speechStart(state: CaptureState, generation: number): CaptureState {
  if (state.generation !== generation || state.phase !== "recording") {
    return state;
  }
  return { ...state, hasConfirmedSpeech: true };
}

/**
 * onVADMisfire is an insufficient short segment: keep listening, never submit
 * a fragment, never end an otherwise active recording.
 */
export function vadMisfire(state: CaptureState, _generation: number): CaptureState {
  return state;
}

/**
 * onSpeechEnd: finalize ONCE only for the active generation with confirmed
 * speech and an open gate. Repeated callbacks (and simultaneous manual stop or
 * the duration timer) become no-ops through the same gate.
 */
export function speechEnd(
  state: CaptureState,
  generation: number,
): { readonly state: CaptureState; readonly finalize: boolean } {
  if (state.generation !== generation || state.phase !== "recording") {
    return { state, finalize: false };
  }
  if (!state.hasConfirmedSpeech) {
    // Initial silence: no countdown was armed; keep recording.
    return { state, finalize: false };
  }
  if (state.stopGate) {
    return { state, finalize: false };
  }
  return {
    state: { ...state, phase: "stopping", stopGate: true },
    finalize: true,
  };
}

/** Manual Stop recording: always finalizes an active recording (same gate). */
export function manualStop(
  state: CaptureState,
  generation: number,
): { readonly state: CaptureState; readonly finalize: boolean } {
  if (state.generation !== generation || state.phase !== "recording" || state.stopGate) {
    return { state, finalize: false };
  }
  return {
    state: { ...state, phase: "stopping", stopGate: true },
    finalize: true,
  };
}

/**
 * Hard 60-second limit with the same gate. A healthy detector that saw no
 * valid speech discards the recording with the no-speech copy and ZERO STT
 * transport; confirmed speech still finalizes.
 */
export function durationLimit(
  state: CaptureState,
  generation: number,
): { readonly state: CaptureState; readonly finalize: boolean; readonly discard: boolean } {
  if (state.generation !== generation || state.phase !== "recording" || state.stopGate) {
    return { state, finalize: false, discard: false };
  }
  const next: CaptureState = { ...state, phase: "stopping", stopGate: true };
  if (!state.hasConfirmedSpeech) {
    return { state: next, finalize: false, discard: true };
  }
  return { state: next, finalize: true, discard: false };
}

/** Cancel dictation: invalidate the generation and discard everything. */
export function cancelCapture(state: CaptureState): CaptureState {
  return {
    generation: state.generation + 1,
    phase: "idle",
    hasConfirmedSpeech: false,
    stopGate: false,
  };
}

/* ------------------------------------------------------------------ */
/* ONNX runtime baseline (CPU/WASM, one thread, no proxy)               */
/* ------------------------------------------------------------------ */

/** Minimal structural ONNX runtime shape; keeps this module DOM-free. */
export interface VadOrtLike {
  env: { wasm: { numThreads?: number; proxy?: boolean } };
}

/**
 * Explicit compatibility baseline (section 10): one WASM thread and no proxy
 * worker, so no cross-origin isolation headers are required.
 */
export function applyVadOrtBaseline(ort: VadOrtLike): void {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
}
