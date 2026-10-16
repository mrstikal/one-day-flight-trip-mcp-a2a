import { describe, expect, it, vi } from "vitest";
import {
  createCaptureController,
  pickRecorderMimeType,
  VOICE_CAPTURE_MAX_BYTES,
  type AudioContextLike,
  type CaptureControllerPorts,
  type MediaStreamLike,
  type RecorderLike,
  type VadCallbacks,
  type VadLike,
} from "../../../apps/web/src/lib/voice-capture.js";
import {
  VOICE_COPY,
  type VoicePhase,
  type VoiceVadState,
} from "../../../apps/web/src/lib/voice-state.js";

/**
 * Mocked-browser tests for the capture pipeline (VOICE_CONTROLL.md section 15,
 * gate V05 + the review fixes): exactly one transcription per finished capture,
 * repeatable captures, bounded background-tab recordings with a visible notice,
 * detector-failure and device-loss handling, lifecycle-safe disposal, stale
 * callback isolation, and complete resource cleanup — without a DOM test stack.
 */

interface FakeTrack {
  stop(): void;
  stopped(): boolean;
  addEventListener(type: "ended", listener: () => void): void;
  end(): void;
}

interface FakeEnvironment {
  readonly ports: CaptureControllerPorts;
  readonly phases: VoicePhase[];
  readonly errors: string[];
  readonly notices: string[];
  readonly transcripts: string[];
  readonly vadStates: VoiceVadState[];
  readonly vadCallbacks: VadCallbacks[];
  readonly transcribeCalls: Array<{ requestId: string; aborted: () => boolean }>;
  recorderStops(): number;
  recorderCount(): number;
  acquireCount(): number;
  transcribeCount(): number;
  vadStarts(): number;
  vadPaused(): number;
  vadDestroyed(): number;
  vadDestroyAttempts(): number;
  modelReleases(): number;
  contextClosed(): number;
  fireTimer(): void;
  emitChunk(size?: number): void;
  resolveAcquire(): void;
  rejectAcquire(name: string): void;
  resolveLoadVad(): void;
  releaseTranscription(text?: string): void;
  endTracks(): void;
  streamTracksStopped(): boolean;
  loadVadMode: "ok" | "fail" | "deferred";
  destroyAlwaysFails: boolean;
  normalizeBounded: boolean;
}

function createEnvironment(): FakeEnvironment {
  const phases: VoicePhase[] = [];
  const errors: string[] = [];
  const notices: string[] = [];
  const transcripts: string[] = [];
  const vadStates: VoiceVadState[] = [];
  const vadCallbacks: VadCallbacks[] = [];
  const transcribeCalls: Array<{ requestId: string; aborted: () => boolean }> = [];
  const tracks: FakeTrack[] = [];
  let recorderStops = 0;
  let recorderStartCount = 0;
  let acquires = 0;
  let vadStarts = 0;
  let vadPauseCount = 0;
  let vadDestroyed = 0;
  let vadDestroyAttempts = 0;
  let modelReleases = 0;
  let contextCloseCount = 0;
  let timerHandler: (() => void) | null = null;
  let pendingTranscription: {
    resolve: (result: { text: string }) => void;
    reject: (error: unknown) => void;
  } | null = null;
  let pendingAcquire: {
    resolve: (stream: MediaStreamLike) => void;
    reject: (error: unknown) => void;
  } | null = null;
  let pendingVad: { resolve: () => void } | null = null;
  let lastRecorder: (RecorderLike & { emit: (size: number) => void }) | null = null;

  const makeTrack = (): FakeTrack => {
    let stopped = false;
    const endedListeners: Array<() => void> = [];
    return {
      stop: () => {
        stopped = true;
      },
      stopped: () => stopped,
      addEventListener: (_type, listener) => {
        endedListeners.push(listener);
      },
      end: () => {
        for (const listener of endedListeners) {
          listener();
        }
      },
    };
  };

  const makeStream = (): MediaStreamLike => {
    const localTracks = [makeTrack(), makeTrack()];
    tracks.push(...localTracks);
    return { getTracks: () => localTracks };
  };

  const env: FakeEnvironment = {
    phases,
    errors,
    notices,
    transcripts,
    vadStates,
    vadCallbacks,
    transcribeCalls,
    loadVadMode: "ok",
    destroyAlwaysFails: false,
    normalizeBounded: false,
    ports: {
      acquireStream: () => {
        acquires += 1;
        return new Promise<MediaStreamLike>((resolve, reject) => {
          pendingAcquire = { resolve, reject };
        });
      },
      createRecorder: (): RecorderLike => {
        recorderStartCount += 1;
        let state: RecorderLike["state"] = "inactive";
        const recorder: RecorderLike & { emit: (size: number) => void } = {
          get state() {
            return state;
          },
          mimeType: "audio/webm",
          ondataavailable: null,
          onstop: null,
          onerror: null,
          start() {
            state = "recording";
          },
          stop() {
            if (state === "inactive") {
              return;
            }
            recorderStops += 1;
            state = "inactive";
            const onstop = recorder.onstop;
            queueMicrotask(() => onstop?.());
          },
          emit: (size: number) => {
            recorder.ondataavailable?.({ data: { size } as Blob });
          },
        };
        lastRecorder = recorder;
        return recorder;
      },
      createContext: (): AudioContextLike => ({
        close: async () => {
          contextCloseCount += 1;
        },
      }),
      loadVad: async (_context, _stream, callbacks) => {
        if (env.loadVadMode === "fail") {
          throw new Error("worklet unavailable");
        }
        if (env.loadVadMode === "deferred") {
          await new Promise<void>((resolve) => {
            pendingVad = { resolve };
          });
        }
        vadCallbacks.push(callbacks);
        let started = false;
        const vad: VadLike = {
          start: async () => {
            vadStarts += 1;
            started = true;
          },
          pause: async () => {
            vadPauseCount += 1;
          },
          destroy: async () => {
            vadDestroyAttempts += 1;
            if (!started || env.destroyAlwaysFails) {
              // Mirrors the pinned package: destroy() needs initialized nodes.
              throw new Error("MicVAD has null stream, audio context, or processor adapter");
            }
            vadDestroyed += 1;
          },
          releaseModel: async () => {
            modelReleases += 1;
          },
        };
        return vad;
      },
      normalize: async (_blob, _context, _maxSamples) => ({
        audio: new Uint8Array([1, 2, 3, 4]),
        bounded: env.normalizeBounded,
      }),
      transcribe: (input) =>
        new Promise<{ text: string }>((resolve, reject) => {
          transcribeCalls.push({
            requestId: input.requestId,
            aborted: () => input.signal.aborted,
          });
          input.signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
          pendingTranscription = { resolve, reject };
        }),
      describeError: () => "boom",
      randomId: () => `request-${String(transcribeCalls.length + 1)}`,
      setTimer: (handler) => {
        timerHandler = handler;
        return setTimeout(() => {}, 0);
      },
      clearTimer: (timer) => clearTimeout(timer),
      isAbort: (error) => error instanceof DOMException && error.name === "AbortError",
      callbacks: {
        onPhase: (phase) => phases.push(phase),
        onConfirmedSpeech: () => {},
        onVadState: (state) => vadStates.push(state),
        onNotice: (message) => notices.push(message),
        onError: (message) => errors.push(message),
        onTranscript: (text) => transcripts.push(text),
      },
    },
    recorderStops: () => recorderStops,
    recorderCount: () => recorderStartCount,
    acquireCount: () => acquires,
    transcribeCount: () => transcribeCalls.length,
    vadStarts: () => vadStarts,
    vadPaused: () => vadPauseCount,
    vadDestroyed: () => vadDestroyed,
    vadDestroyAttempts: () => vadDestroyAttempts,
    modelReleases: () => modelReleases,
    contextClosed: () => contextCloseCount,
    fireTimer: () => timerHandler?.(),
    emitChunk: (size = 10) => lastRecorder?.emit(size),
    resolveAcquire: () => {
      const pending = pendingAcquire;
      pendingAcquire = null;
      pending?.resolve(makeStream());
    },
    rejectAcquire: (name: string) => {
      const pending = pendingAcquire;
      pendingAcquire = null;
      pending?.reject(new DOMException("nope", name));
    },
    resolveLoadVad: () => {
      const pending = pendingVad;
      pendingVad = null;
      pending?.resolve();
    },
    releaseTranscription: (text = "hello") => {
      const pending = pendingTranscription;
      pendingTranscription = null;
      pending?.resolve({ text });
    },
    endTracks: () => {
      for (const track of tracks) {
        track.end();
      }
    },
    streamTracksStopped: () => tracks.length > 0 && tracks.every((track) => track.stopped()),
  };
  return env;
}

async function started(env: FakeEnvironment) {
  const controllers = env.vadCallbacks.length;
  const controller = createCaptureController(env.ports);
  controller.start();
  env.resolveAcquire();
  await vi.waitFor(() => expect(env.phases).toContain("recording"));
  if (env.loadVadMode !== "fail") {
    await vi.waitFor(() => expect(env.vadCallbacks).toHaveLength(controllers + 1));
  }
  return controller;
}

async function finishViaSilence(
  env: FakeEnvironment,
  vadIndex = 0,
  expectedCount = 1,
): Promise<void> {
  env.emitChunk();
  env.vadCallbacks[vadIndex]?.onSpeechRealStart();
  env.vadCallbacks[vadIndex]?.onSpeechEnd();
  await vi.waitFor(() => expect(env.transcribeCount()).toBeGreaterThanOrEqual(expectedCount));
}

describe("pickRecorderMimeType", () => {
  it("prefers opus webm and falls back in order, or null", () => {
    expect(pickRecorderMimeType(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickRecorderMimeType((type) => type === "audio/webm")).toBe("audio/webm");
    expect(pickRecorderMimeType((type) => type === "audio/mp4")).toBe("audio/mp4");
    expect(pickRecorderMimeType(() => false)).toBeNull();
  });
});

describe("capture controller (mocked browser)", () => {
  it("finalizes silence exactly once: one stream, one transcription, full cleanup", async () => {
    const env = createEnvironment();
    const controller = await started(env);
    await finishViaSilence(env);
    env.releaseTranscription("dictated words");
    await vi.waitFor(() => expect(env.transcripts).toEqual(["dictated words"]));

    expect(env.acquireCount()).toBe(1);
    expect(env.recorderCount()).toBe(1);
    expect(env.recorderStops()).toBe(1);
    expect(env.vadPaused()).toBe(1);
    expect(env.vadDestroyed()).toBe(1);
    expect(env.contextClosed()).toBe(1);
    expect(env.streamTracksStopped()).toBe(true);
    expect(env.errors).toEqual([]);
    expect(env.phases.at(-1)).toBe("idle");

    // Every repeated stop path is a no-op for this finished generation.
    controller.stopManual();
    env.vadCallbacks[0]?.onSpeechEnd();
    env.fireTimer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(env.transcribeCount()).toBe(1);
    expect(env.recorderStops()).toBe(1);
  });

  it("allows a second completed recording in the same session (no stuck capture state)", async () => {
    const env = createEnvironment();
    const controller = await started(env);
    await finishViaSilence(env, 0);
    env.releaseTranscription("first");
    await vi.waitFor(() => expect(env.transcripts).toEqual(["first"]));
    await vi.waitFor(() => expect(env.phases.at(-1)).toBe("idle"));

    controller.start();
    env.resolveAcquire();
    await vi.waitFor(() => expect(env.vadCallbacks).toHaveLength(2));
    await vi.waitFor(() => expect(env.phases.at(-1)).toBe("recording"));
    await finishViaSilence(env, 1, 2);
    env.releaseTranscription("second");
    await vi.waitFor(() => expect(env.transcripts).toEqual(["first", "second"]));
    expect(env.acquireCount()).toBe(2);
    expect(env.recorderCount()).toBe(2);
  });

  it("bounds a delayed background-tab recording with a visible notice instead of discarding it", async () => {
    const env = createEnvironment();
    env.normalizeBounded = true;
    await started(env);
    await finishViaSilence(env);
    await vi.waitFor(() => expect(env.transcribeCount()).toBe(1));
    expect(env.notices).toContain("The 60-second recording limit was applied.");
    env.releaseTranscription("bounded");
    await vi.waitFor(() => expect(env.transcripts).toEqual(["bounded"]));
  });

  it("transcribes at the hard limit when the detector failed (unknown activity, not silence)", async () => {
    const env = createEnvironment();
    env.loadVadMode = "fail";
    const controller = await started(env);
    await vi.waitFor(() => expect(env.vadStates).toContain("unavailable"));
    env.emitChunk();
    env.fireTimer();
    await vi.waitFor(() => expect(env.transcribeCount()).toBe(1));
    env.releaseTranscription("never confirmed");
    await vi.waitFor(() => expect(env.transcripts).toEqual(["never confirmed"]));
    expect(env.errors).toEqual([]);
    controller.cancel();
  });

  it("discards at the hard limit only with a healthy detector and no valid speech", async () => {
    const env = createEnvironment();
    await started(env);
    env.emitChunk();
    env.fireTimer();
    await vi.waitFor(() => expect(env.phases.at(-1)).toBe("idle"));
    expect(env.transcribeCount()).toBe(0);
    expect(env.errors).toEqual([VOICE_COPY.noSpeech]);
    expect(env.vadDestroyed()).toBe(1);
    expect(env.streamTracksStopped()).toBe(true);
  });

  it("reports device loss and still transcribes the captured audio", async () => {
    const env = createEnvironment();
    await started(env);
    env.emitChunk();
    env.vadCallbacks[0]?.onSpeechRealStart();
    env.endTracks();
    await vi.waitFor(() => expect(env.errors).toEqual([VOICE_COPY.deviceLost]));
    await vi.waitFor(() => expect(env.transcribeCount()).toBe(1));
    env.releaseTranscription("before the loss");
    await vi.waitFor(() => expect(env.transcripts).toEqual(["before the loss"]));
    expect(env.streamTracksStopped()).toBe(true);
  });

  it("manual stop works while detector assets are still loading", async () => {
    const env = createEnvironment();
    env.loadVadMode = "deferred";
    const controller = createCaptureController(env.ports);
    controller.start();
    env.resolveAcquire();
    await vi.waitFor(() => expect(env.phases).toContain("recording"));
    env.emitChunk();
    controller.stopManual();
    await vi.waitFor(() => expect(env.transcribeCount()).toBe(1));
    env.releaseTranscription("early stop");
    await vi.waitFor(() => expect(env.transcripts).toEqual(["early stop"]));
  });

  it("disposes a detector cancelled while assets were still loading", async () => {
    const env = createEnvironment();
    env.loadVadMode = "deferred";
    const controller = createCaptureController(env.ports);
    controller.start();
    env.resolveAcquire();
    await vi.waitFor(() => expect(env.phases).toContain("recording"));
    controller.cancel();
    env.resolveLoadVad();
    // The unstarted detector is started on the SAME owned stream and destroyed.
    await vi.waitFor(() => expect(env.vadDestroyed()).toBe(1));
    expect(env.transcribeCount()).toBe(0);
  });

  it("releases the ONNX model even when destroy() keeps failing", async () => {
    const env = createEnvironment();
    env.destroyAlwaysFails = true;
    const controller = await started(env);
    controller.cancel();
    await vi.waitFor(() => expect(env.modelReleases()).toBe(1));
    await vi.waitFor(() => expect(env.phases.at(-1)).toBe("idle"));
    expect(env.streamTracksStopped()).toBe(true);
  });

  it("does not stop on initial silence and misfires keep the recording", async () => {
    const env = createEnvironment();
    await started(env);
    env.vadCallbacks[0]?.onSpeechEnd();
    env.vadCallbacks[0]?.onSpeechEnd();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(env.transcribeCount()).toBe(0);
    expect(env.phases).not.toContain("stopping");
    expect(env.recorderStops()).toBe(0);
  });

  it("manual stop still transcribes a short utterance (VAD false negative)", async () => {
    const env = createEnvironment();
    const controller = await started(env);
    env.emitChunk();
    controller.stopManual();
    await vi.waitFor(() => expect(env.transcribeCount()).toBe(1));
    env.releaseTranscription("short");
    await vi.waitFor(() => expect(env.transcripts).toEqual(["short"]));
  });

  it("cancel aborts the in-flight upload, discards, and releases resources", async () => {
    const env = createEnvironment();
    const controller = await started(env);
    await finishViaSilence(env);
    controller.cancel();
    await vi.waitFor(() => expect(env.phases.at(-1)).toBe("idle"));
    expect(env.transcribeCalls[0]?.aborted()).toBe(true);
    expect(env.transcripts).toEqual([]);
    expect(env.errors).toEqual([]);
    expect(env.streamTracksStopped()).toBe(true);
  });

  it("a late transcription result after cancel never inserts", async () => {
    const env = createEnvironment();
    const controller = await started(env);
    await finishViaSilence(env);
    controller.cancel();
    env.releaseTranscription("too late");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(env.transcripts).toEqual([]);
  });

  it("stale VAD callbacks cannot stop a new capture", async () => {
    const env = createEnvironment();
    const first = await started(env);
    const staleCallbacks = env.vadCallbacks[0];
    const staleGeneration = env.vadCallbacks.length;
    first.cancel();
    await vi.waitFor(() => expect(env.phases.at(-1)).toBe("idle"));

    const controller = await started(env);
    expect(env.vadCallbacks).toHaveLength(staleGeneration + 1);
    staleCallbacks?.onSpeechEnd();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(env.transcribeCount()).toBe(0);
    env.emitChunk();
    env.vadCallbacks[1]?.onSpeechRealStart();
    env.vadCallbacks[1]?.onSpeechEnd();
    await vi.waitFor(() => expect(env.transcribeCount()).toBe(1));
    env.releaseTranscription("second");
    await vi.waitFor(() => expect(env.transcripts).toEqual(["second"]));
    controller.cancel();
  });

  it("VAD initialization failure keeps manual dictation available", async () => {
    const env = createEnvironment();
    env.loadVadMode = "fail";
    const controller = await started(env);
    await vi.waitFor(() => expect(env.vadStates).toContain("unavailable"));
    env.emitChunk();
    controller.stopManual();
    await vi.waitFor(() => expect(env.transcribeCount()).toBe(1));
    env.releaseTranscription("manual");
    await vi.waitFor(() => expect(env.transcripts).toEqual(["manual"]));
  });

  it("cancelling while the permission prompt is pending stops the late stream", async () => {
    const env = createEnvironment();
    const controller = createCaptureController(env.ports);
    controller.start();
    await vi.waitFor(() => expect(env.phases).toContain("preparing"));
    controller.cancel();
    env.resolveAcquire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(env.recorderCount()).toBe(0);
    expect(env.streamTracksStopped()).toBe(true);
    expect(env.transcribeCount()).toBe(0);
  });

  it("maps permission failures to the copy and releases partial state", async () => {
    const env = createEnvironment();
    const controller = createCaptureController(env.ports);
    controller.start();
    await vi.waitFor(() => expect(env.phases).toContain("preparing"));
    env.rejectAcquire("NotAllowedError");
    await vi.waitFor(() => expect(env.phases.at(-1)).toBe("idle"));
    expect(env.errors).toEqual([VOICE_COPY.permissionDenied]);
    expect(env.recorderCount()).toBe(0);
  });

  it("stops over-cap recordings before they can be transcribed", async () => {
    const env = createEnvironment();
    await started(env);
    env.emitChunk(VOICE_CAPTURE_MAX_BYTES + 1);
    await vi.waitFor(() => expect(env.phases.at(-1)).toBe("idle"));
    expect(env.transcribeCount()).toBe(0);
    expect(env.errors[0]).toContain("too large");
    expect(env.streamTracksStopped()).toBe(true);
  });
});
