import {
  recordingLimitAppliedCopy,
  VOICE_COPY,
  VOICE_CAPTURE_LIMIT_MS,
  type VoicePhase,
  type VoiceVadState,
} from "./voice-state";
import {
  beginCapture,
  cancelCapture,
  captureReady,
  durationLimit,
  INITIAL_CAPTURE_STATE,
  isActiveGeneration,
  manualStop,
  speechEnd,
  speechStart,
  type CaptureState,
} from "./voice-vad";

/**
 * Framework-free capture pipeline (VOICE_CONTROLL.md section 10).
 *
 * Every browser API is an injected port, so the exact lifecycle the hook relies
 * on — one microphone stream, one VAD, one shared finalizer, exactly one
 * transcription per finished capture, generation-guarded late results, and
 * full resource release — is provable in mocked-browser Node tests without a
 * DOM test stack.
 */

/** Raw recording safety cap before normalization (8 MiB). */
export const VOICE_CAPTURE_MAX_BYTES = 8 * 1024 * 1024;

/** Structural ports: no DOM lib required, so Node tests can mock every call. */
export interface AudioContextLike {
  close(): Promise<void>;
}

export interface MediaStreamLike {
  getTracks(): ReadonlyArray<{
    stop(): void;
    /** Optional: the controller reports unexpected device loss. */
    addEventListener?: (type: "ended", listener: () => void) => void;
  }>;
}

export interface RecorderLike {
  readonly state: "inactive" | "recording" | "paused";
  readonly mimeType: string;
  ondataavailable: ((event: { readonly data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

export interface VadLike {
  start(): Promise<void>;
  pause(): Promise<void>;
  destroy(): Promise<void>;
  /**
   * Pinned-package fallback: MicVAD.destroy() throws before model.release()
   * when the audio graph was never initialized; this releases the ONNX model
   * without assuming an initialized graph.
   */
  releaseModel?(): Promise<void>;
}

export interface VadCallbacks {
  onSpeechRealStart: () => void;
  onSpeechEnd: () => void;
}

export interface CaptureControllerPorts {
  readonly acquireStream: () => Promise<MediaStreamLike>;
  readonly createRecorder: (stream: MediaStreamLike) => RecorderLike;
  readonly createContext: () => AudioContextLike;
  readonly loadVad: (
    context: AudioContextLike,
    stream: MediaStreamLike,
    callbacks: VadCallbacks,
  ) => Promise<VadLike>;
  readonly normalize: (
    blob: Blob,
    context: AudioContextLike,
    maxSamples: number,
  ) => Promise<{ readonly audio: Uint8Array; readonly bounded: boolean }>;
  readonly transcribe: (input: {
    readonly audio: Uint8Array;
    readonly requestId: string;
    readonly signal: AbortSignal;
  }) => Promise<{ readonly text: string }>;
  readonly describeError: (error: unknown) => string;
  readonly randomId: () => string;
  readonly setTimer: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  readonly isAbort: (error: unknown) => boolean;
  readonly callbacks: {
    readonly onPhase: (phase: VoicePhase) => void;
    readonly onConfirmedSpeech: (confirmed: boolean) => void;
    /** loading -> ready | unavailable: drives the "Preparing speech detection..." cue. */
    readonly onVadState: (state: VoiceVadState) => void;
    readonly onNotice: (message: string) => void;
    readonly onError: (message: string) => void;
    readonly onTranscript: (text: string) => void;
  };
}

export interface CaptureStartOptions {
  /** Advertised recording limit (capabilities/profile); defaults to 60 s. */
  readonly maxRecordingMs?: number;
}

export interface CaptureController {
  start(options?: CaptureStartOptions): void;
  stopManual(): void;
  cancel(): void;
  dispose(): Promise<void>;
}

/** Prefer Opus containers the pipeline can decode; ordered by preference. */
export function pickRecorderMimeType(isTypeSupported: (type: string) => boolean): string | null {
  for (const candidate of [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ]) {
    if (isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function createCaptureController(ports: CaptureControllerPorts): CaptureController {
  let machine: CaptureState = INITIAL_CAPTURE_STATE;
  let recorder: RecorderLike | null = null;
  let stream: MediaStreamLike | null = null;
  let chunks: Blob[] = [];
  let chunkBytes = 0;
  let context: AudioContextLike | null = null;
  let vad: VadLike | null = null;
  let vadStarted = false;
  let durationTimer: ReturnType<typeof setTimeout> | null = null;
  let transcribeAbort: AbortController | null = null;
  let disposing = false;
  /** Detector health for this session: a failed detector is UNKNOWN activity. */
  let vadFailed = false;
  /** Advertised recording limit for this session (defaults to the 60 s cap). */
  let sessionLimitMs = VOICE_CAPTURE_LIMIT_MS;

  const active = (generation: number): boolean => isActiveGeneration(machine, generation);

  /**
   * Lifecycle-safe disposal for the pinned package: destroy() throws before
   * releasing the ONNX model when the audio graph was never initialized, so an
   * unstarted/partially started detector is first started on the SAME owned
   * stream (never reacquiring the microphone) and then destroyed; if even that
   * fails, the model is released directly. Nothing here claims success.
   */
  async function disposeVadInstance(current: VadLike | null, started: boolean): Promise<void> {
    if (!current) {
      return;
    }
    if (started) {
      try {
        await current.pause();
      } catch {
        // A pause failure must not block disposal of the rest.
      }
    }
    try {
      await current.destroy();
      return;
    } catch {
      // Expected for an unstarted or partially initialized detector.
    }
    try {
      await current.start();
      await current.destroy();
      return;
    } catch {
      // The graph could not be initialized (e.g. broken worklet assets).
    }
    try {
      await current.releaseModel?.();
    } catch {
      // Best effort only; never reported as a completed release.
    }
  }

  async function disposeVad(): Promise<void> {
    const current = vad;
    const started = vadStarted;
    vad = null;
    vadStarted = false;
    await disposeVadInstance(current, started);
  }

  /** Return to idle for THIS generation after a finalized capture. */
  function completeCapture(generation: number): void {
    if (isActiveGeneration(machine, generation)) {
      machine = {
        generation: machine.generation,
        phase: "idle",
        hasConfirmedSpeech: false,
        stopGate: false,
      };
    }
  }

  /**
   * Close one specific owned context. Closing the exact INSTANCE (not the
   * mutable binding) prevents a late finalizer from closing the context of a
   * newer capture that started while this one was disposing.
   */
  function closeContextInstance(target: AudioContextLike | null): void {
    if (context === target) {
      context = null;
    }
    target?.close().catch(() => {
      // Owned context; a double close is safe to ignore.
    });
  }

  function closeContext(): void {
    closeContextInstance(context);
  }

  /** Release recorder/tracks/VAD/timers; the context survives normalization. */
  async function releaseCapture(options: { readonly closeContext?: boolean } = {}): Promise<void> {
    if (durationTimer !== null) {
      ports.clearTimer(durationTimer);
      durationTimer = null;
    }
    const currentRecorder = recorder;
    recorder = null;
    if (currentRecorder && currentRecorder.state !== "inactive") {
      try {
        currentRecorder.stop();
      } catch {
        // Ignore double-stop races.
      }
    }
    for (const track of stream?.getTracks() ?? []) {
      track.stop();
    }
    stream = null;
    chunks = [];
    chunkBytes = 0;
    await disposeVad();
    if (options.closeContext !== false) {
      closeContext();
    }
  }

  async function transcribeBlob(blob: Blob, generation: number): Promise<void> {
    if (!active(generation)) {
      return;
    }
    ports.callbacks.onPhase("transcribing");
    const controller = new AbortController();
    transcribeAbort = controller;
    const currentContext = context;
    try {
      if (!currentContext) {
        return;
      }
      const maxSamples = Math.min(Math.floor((sessionLimitMs / 1000) * 16000), 960_000);
      const normalized = await ports.normalize(blob, currentContext, maxSamples);
      if (!active(generation)) {
        return;
      }
      if (normalized.bounded) {
        // A delayed background-tab timer must not discard valid dictation: the
        // recording is bounded to the advertised limit with a visible notice.
        ports.callbacks.onNotice(recordingLimitAppliedCopy(Math.round(sessionLimitMs / 1000)));
      }
      const result = await ports.transcribe({
        audio: normalized.audio,
        requestId: ports.randomId(),
        signal: controller.signal,
      });
      if (active(generation)) {
        ports.callbacks.onTranscript(result.text);
      }
    } catch (error) {
      if (!ports.isAbort(error) && active(generation)) {
        ports.callbacks.onError(ports.describeError(error));
      }
    } finally {
      if (transcribeAbort === controller) {
        transcribeAbort = null;
      }
      // Close the instance this attempt used, even if the shared binding was
      // replaced by a newer capture in the meantime.
      closeContextInstance(currentContext);
      if (active(generation)) {
        completeCapture(generation);
        ports.callbacks.onPhase("idle");
      }
    }
  }

  /** The ONE shared finalizer used by silence, manual, and duration stops. */
  function finishCapture(mode: "silence" | "manual" | "duration", generation: number): void {
    ports.callbacks.onPhase("stopping");
    const currentRecorder = recorder;
    const recorderActive = currentRecorder !== null && currentRecorder.state !== "inactive";
    const stopped = recorderActive
      ? new Promise<void>((resolve) => {
          if (currentRecorder) {
            currentRecorder.onstop = () => resolve();
          } else {
            resolve();
          }
        })
      : Promise.resolve();
    if (recorderActive) {
      try {
        currentRecorder?.stop();
      } catch {
        // Already stopped.
      }
    }
    void stopped.then(async () => {
      const blob =
        chunks.length > 0
          ? new Blob(chunks, { type: currentRecorder?.mimeType || "audio/webm" })
          : null;
      chunks = [];
      chunkBytes = 0;
      await releaseCapture({ closeContext: false });
      if (!active(generation)) {
        // Cancelled/trip-changed mid-finalize: not a transcription.
        return;
      }
      if (mode === "duration" && !machine.hasConfirmedSpeech && !vadFailed) {
        // A HEALTHY detector saw no valid speech at the hard limit: discard
        // with zero STT transport. A failed detector is unknown activity and
        // still transcribes (below).
        closeContext();
        completeCapture(generation);
        ports.callbacks.onError(VOICE_COPY.noSpeech);
        ports.callbacks.onPhase("idle");
        return;
      }
      if (!blob || blob.size === 0) {
        // Nothing was captured (e.g. an immediate device loss).
        closeContext();
        completeCapture(generation);
        ports.callbacks.onPhase("idle");
        return;
      }
      await transcribeBlob(blob, generation);
    });
  }

  function handleSpeechEnd(): void {
    const generation = machine.generation;
    const outcome = speechEnd(machine, generation);
    machine = outcome.state;
    if (outcome.finalize) {
      finishCapture("silence", generation);
    }
  }

  async function teardown(): Promise<void> {
    // Synchronously lock out new captures until disposal has really finished.
    disposing = true;
    try {
      machine = cancelCapture(machine);
      if (transcribeAbort) {
        transcribeAbort.abort();
        transcribeAbort = null;
      }
      ports.callbacks.onConfirmedSpeech(false);
      ports.callbacks.onPhase("idle");
      await releaseCapture();
    } finally {
      disposing = false;
    }
  }

  return {
    start(options?: CaptureStartOptions): void {
      if (machine.phase !== "idle" || disposing) {
        return;
      }
      sessionLimitMs = options?.maxRecordingMs ?? VOICE_CAPTURE_LIMIT_MS;
      vadFailed = false;
      machine = beginCapture(machine);
      const generation = machine.generation;
      context = ports.createContext();
      ports.callbacks.onPhase("preparing");
      ports.callbacks.onConfirmedSpeech(false);

      void (async () => {
        let acquired: MediaStreamLike;
        try {
          acquired = await ports.acquireStream();
        } catch (error) {
          if (!active(generation)) {
            return;
          }
          const name =
            typeof error === "object" && error !== null && "name" in error
              ? String((error as { name?: unknown }).name)
              : "";
          ports.callbacks.onError(
            name === "NotFoundError" ? VOICE_COPY.noDevice : VOICE_COPY.permissionDenied,
          );
          await teardown();
          return;
        }
        if (!active(generation)) {
          // Cancelled/unmounted while the permission prompt was pending.
          for (const track of acquired.getTracks()) {
            track.stop();
          }
          return;
        }
        stream = acquired;
        // Unexpected microphone loss must be reported, not silently swallowed.
        for (const track of acquired.getTracks()) {
          track.addEventListener?.("ended", () => {
            if (!active(generation) || machine.stopGate) {
              return;
            }
            ports.callbacks.onError(VOICE_COPY.deviceLost);
            if (machine.phase === "recording" || machine.phase === "preparing") {
              machine = { ...machine, phase: "stopping", stopGate: true };
              finishCapture("manual", generation);
            }
          });
        }

        let created: RecorderLike;
        try {
          created = ports.createRecorder(acquired);
        } catch {
          ports.callbacks.onError(VOICE_COPY.unsupported);
          await teardown();
          return;
        }
        recorder = created;
        chunks = [];
        chunkBytes = 0;
        created.ondataavailable = (event) => {
          if (!active(generation)) {
            return;
          }
          if (event.data.size > 0) {
            chunkBytes += event.data.size;
            if (chunkBytes > VOICE_CAPTURE_MAX_BYTES) {
              ports.callbacks.onError(
                "The recording is too large. Try again with a shorter message.",
              );
              void teardown();
              return;
            }
            chunks.push(event.data);
          }
        };
        created.onerror = () => {
          if (active(generation)) {
            ports.callbacks.onError("Recording failed. Try again or type your request.");
            void teardown();
          }
        };
        created.start();
        // The hard limit starts with actual recording, not asset loading.
        durationTimer = ports.setTimer(() => {
          const outcome = durationLimit(machine, generation);
          machine = outcome.state;
          if (outcome.discard || outcome.finalize) {
            finishCapture("duration", generation);
          }
        }, sessionLimitMs);
        machine = captureReady(machine, generation);
        ports.callbacks.onPhase("recording");

        // Local VAD on the SAME stream; failure keeps manual dictation.
        ports.callbacks.onVadState("loading");
        try {
          const createdVad = await ports.loadVad(context as AudioContextLike, acquired, {
            onSpeechRealStart: () => {
              if (!active(generation)) {
                return;
              }
              machine = speechStart(machine, generation);
              ports.callbacks.onConfirmedSpeech(machine.hasConfirmedSpeech);
            },
            onSpeechEnd: () => {
              if (!active(generation)) {
                return;
              }
              ports.callbacks.onConfirmedSpeech(machine.hasConfirmedSpeech);
              handleSpeechEnd();
            },
          });
          if (!active(generation)) {
            // Cancelled while loading assets: lifecycle-safe disposal.
            await disposeVadInstance(createdVad, false);
            return;
          }
          vad = createdVad;
          await createdVad.start();
          vadStarted = true;
          if (active(generation)) {
            ports.callbacks.onVadState("ready");
          }
        } catch {
          vadFailed = true;
          if (active(generation)) {
            ports.callbacks.onVadState("unavailable");
          }
        }
      })();
    },

    stopManual(): void {
      const generation = machine.generation;
      // The recorder starts before detector assets finish loading; a manual
      // stop must work from the moment audio is actually being captured.
      if (machine.phase === "preparing" && recorder) {
        if (machine.stopGate) {
          return;
        }
        machine = { ...machine, phase: "stopping", stopGate: true };
        finishCapture("manual", generation);
        return;
      }
      const outcome = manualStop(machine, generation);
      machine = outcome.state;
      if (outcome.finalize) {
        finishCapture("manual", generation);
      }
    },

    cancel(): void {
      void teardown();
    },

    async dispose(): Promise<void> {
      await teardown();
    },
  };
}
