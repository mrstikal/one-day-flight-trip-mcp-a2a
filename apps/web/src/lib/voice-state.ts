import type { OperationStatus } from "@odft/contracts";

/** Hard recording cap; the timer starts with actual MediaRecorder recording. */
export const VOICE_CAPTURE_LIMIT_MS = 60_000;

export type VoicePhase =
  "idle" | "preparing" | "recording" | "stopping" | "transcribing" | "tts-preparing" | "playing";

/** User-visible English copy (VOICE_CONTROLL.md section 12). */
export const VOICE_COPY = {
  preparing: "Preparing speech detection...",
  /** Advertised recording limit applied to the UI copy and the capture bound. */
  listening: "Listening... Start speaking. Maximum 60 seconds.",
  recording:
    "Recording... Stops automatically after 2 seconds without speech. You can also stop manually. Maximum 60 seconds.",
  deviceLost: "The microphone disconnected. Recording stopped - review the draft before sending.",
  availabilityError:
    "Voice availability could not be checked. Typed chat remains available; reload to retry.",
  vadUnavailable: "Automatic stopping is unavailable. Use Stop recording.",
  preparingRecording: "Preparing your recording...",
  transcribing: "Transcribing...",
  preparingReply: "Preparing spoken reply...",
  playing: "Reading the assistant reply...",
  permissionDenied:
    "Microphone access was denied. Allow it in your browser settings or type your request.",
  noDevice: "No microphone was found. Connect one or type your request.",
  unsupported: "Voice recording is not supported in this browser. Type your request instead.",
  noSpeech: "No speech was detected. Try again or type your request.",
  voiceDisabled: "Voice control is not enabled on this server.",
  replyNotAvailable: "The assistant reply is not available yet.",
  fixtureMode: "Voice fixture mode: scripted transcription and test audio, no live speech service.",
  dictate: "Dictate",
  stopRecording: "Stop recording",
  cancelDictation: "Cancel dictation",
  readReplies: "Read replies aloud",
  stopSpeaking: "Stop speaking",
  playReply: "Play reply",
  privacyNotice:
    "Voice recording and spoken replies use OpenRouter. Starting dictation also enables spoken replies for this tab. You can turn them off at any time.",
  helper: "Use your microphone and speakers/headphones to control the assistant.",
  pauseHint:
    "A pause longer than two seconds may split the question; edit the draft or dictate more before sending.",
} as const;

/** The prepared detector state for the capture UI cue. */
export type VoiceVadState = "loading" | "ready" | "unavailable";

/** "Listening..." copy with the ADVERTISED limit (the profile may narrow it). */
export function listeningCopy(maxSeconds: number): string {
  return `Listening... Start speaking. Maximum ${String(maxSeconds)} seconds.`;
}

/** "Recording..." copy with the ADVERTISED limit (the profile may narrow it). */
export function recordingCopy(maxSeconds: number): string {
  return `Recording... Stops automatically after 2 seconds without speech. You can also stop manually. Maximum ${String(maxSeconds)} seconds.`;
}

/** Visible explanation when a delayed timer had to bound the recording. */
export function recordingLimitAppliedCopy(maxSeconds: number): string {
  return `The ${String(maxSeconds)}-second recording limit was applied.`;
}

/**
 * Pure voice state/selection helpers (VOICE_CONTROLL.md sections 10 and 11).
 *
 * No React, DOM, timer, network, or AudioContext access: every decision the
 * assistant voice hook makes (draft insertion, spoken-reply selection,
 * playback state, bounded reply refresh) is computed here so Node unit tests
 * pin the exact behavior. Message DTOs only — never DOM scraping.
 */

/* ------------------------------------------------------------------ */
/* Composer draft insertion                                            */
/* ------------------------------------------------------------------ */

export const VOICE_DRAFT_LIMIT = 2000;

export const VOICE_TRANSCRIPT_LIMIT_MESSAGE =
  "The transcript would exceed the 2,000-character message limit. Shorten your draft and try again.";

export interface ComposerState {
  readonly draft: string;
  readonly voiceInsertionError: string | null;
}

/**
 * Functional transcript append: inserts into the CURRENT draft (never a stale
 * snapshot), adds one separator only when needed, preserves existing text
 * exactly, and on overflow keeps the original draft plus the insertion error.
 */
export function appendTranscript(current: ComposerState, transcript: string): ComposerState {
  const trimmed = transcript.trim();
  const separator = current.draft.length > 0 && !/\s$/.test(current.draft) ? " " : "";
  const nextDraft = current.draft + separator + trimmed;
  if (nextDraft.length > VOICE_DRAFT_LIMIT) {
    return { ...current, voiceInsertionError: VOICE_TRANSCRIPT_LIMIT_MESSAGE };
  }
  return { draft: nextDraft, voiceInsertionError: null };
}

/* ------------------------------------------------------------------ */
/* Spoken reply selection                                              */
/* ------------------------------------------------------------------ */

export interface VoiceReplyMessage {
  readonly id: string;
  readonly sequence: number;
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly operationId: string | null;
}

export interface VoiceOperationStatus {
  readonly operationId: string;
  readonly status: OperationStatus;
}

export interface ReplySelectionState {
  readonly initialized: boolean;
  /** Maximum sequence visible at the baseline moment; only newer ones count. */
  readonly baselineSequence: number;
  readonly processedMessageIds: ReadonlySet<string>;
  readonly inFlightMessageId: string | null;
}

export interface ReplyCandidate {
  readonly messageId: string;
  readonly operationId: string;
}

export const INITIAL_REPLY_SELECTION: ReplySelectionState = {
  initialized: false,
  baselineSequence: 0,
  processedMessageIds: new Set(),
  inFlightMessageId: null,
};

/** A FRESH selection state (new Set); hooks and trip changes must use this. */
export function initialReplySelection(): ReplySelectionState {
  return { ...INITIAL_REPLY_SELECTION, processedMessageIds: new Set() };
}

/**
 * Section 2 settled statuses: a reply is eligible only for `succeeded`,
 * `waiting` (yielded to a decision), or `failed` when an actual persisted
 * message exists. `queued`/`running`/`cancelled`/missing never speak.
 */
const SETTLED_STATUSES = new Set<OperationStatus>(["succeeded", "waiting", "failed"]);

/** Record the current maximum visible sequence once (first projection/enable). */
export function initializeReplyBaseline(
  state: ReplySelectionState,
  messages: readonly VoiceReplyMessage[],
): ReplySelectionState {
  if (state.initialized) {
    return state;
  }
  let baseline = 0;
  for (const message of messages) {
    if (message.sequence > baseline) {
      baseline = message.sequence;
    }
  }
  return { ...state, initialized: true, baselineSequence: baseline };
}

/**
 * Pick at most one automatic spoken reply from a new projection.
 *
 * Rules (section 11): only assistant messages NEWER than the baseline; a
 * non-null operation link with a settled status; no already processed or
 * in-flight id; no empty content; choose the highest sequence when several
 * appear together. The baseline is advanced and the id marked in-flight in the
 * SAME returned state, before any asynchronous work, so repeated renders,
 * replayed events, and Strict Mode double effects cannot start a second call.
 */
export function selectReplyCandidate(
  state: ReplySelectionState,
  messages: readonly VoiceReplyMessage[],
  operations: readonly VoiceOperationStatus[],
): { readonly state: ReplySelectionState; readonly candidate: ReplyCandidate | null } {
  if (!state.initialized) {
    return { state, candidate: null };
  }
  const statusByOperation = new Map(
    operations.map((operation) => [operation.operationId, operation.status]),
  );
  let chosen: VoiceReplyMessage | undefined;
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    if (message.sequence <= state.baselineSequence) {
      continue;
    }
    if (!message.operationId) {
      continue;
    }
    const status = statusByOperation.get(message.operationId);
    if (!status || !SETTLED_STATUSES.has(status)) {
      continue;
    }
    if (message.content.trim().length === 0) {
      continue;
    }
    if (state.processedMessageIds.has(message.id) || state.inFlightMessageId === message.id) {
      continue;
    }
    if (!chosen || message.sequence > chosen.sequence) {
      chosen = message;
    }
  }
  if (!chosen || !chosen.operationId) {
    return { state, candidate: null };
  }
  return {
    state: {
      ...state,
      baselineSequence: chosen.sequence,
      inFlightMessageId: chosen.id,
    },
    candidate: { messageId: chosen.id, operationId: chosen.operationId },
  };
}

/**
 * Mark an attempt finished (success, deliberate stop, or failure): a failed
 * automatic attempt never retries on a later projection.
 */
export function markReplyProcessed(
  state: ReplySelectionState,
  messageId: string,
): ReplySelectionState {
  const processed = new Set(state.processedMessageIds);
  processed.add(messageId);
  return {
    ...state,
    processedMessageIds: processed,
    inFlightMessageId: state.inFlightMessageId === messageId ? null : state.inFlightMessageId,
  };
}

/** Discard a pending automatic reply (replies turned off) without forgetting history. */
export function clearInFlightReply(state: ReplySelectionState): ReplySelectionState {
  return { ...state, inFlightMessageId: null };
}

/** On an explicit enable action, re-baseline so old history never speaks. */
export function resetReplyBaseline(
  state: ReplySelectionState,
  messages: readonly VoiceReplyMessage[],
): ReplySelectionState {
  let baseline = 0;
  for (const message of messages) {
    if (message.sequence > baseline) {
      baseline = message.sequence;
    }
  }
  return { ...state, initialized: true, baselineSequence: baseline, inFlightMessageId: null };
}

/* ------------------------------------------------------------------ */
/* Playback state                                                      */
/* ------------------------------------------------------------------ */

export type PlaybackPhase = "idle" | "preparing" | "playing";

export interface PlaybackState {
  readonly phase: PlaybackPhase;
  /** Message whose audio is currently preparing/playing. */
  readonly activeMessageId: string | null;
  /** Latest decoded buffer kept ONLY for the manual Play reply fallback. */
  readonly bufferMessageId: string | null;
}

export const INITIAL_PLAYBACK_STATE: PlaybackState = {
  phase: "idle",
  activeMessageId: null,
  bufferMessageId: null,
};

export function playbackPrepare(state: PlaybackState, messageId: string): PlaybackState {
  return { ...state, phase: "preparing", activeMessageId: messageId };
}

/** A decoded buffer is ready (also when autoplay stays blocked): keep it for Play reply. */
export function playbackBufferReady(state: PlaybackState, messageId: string): PlaybackState {
  return { ...state, phase: "idle", activeMessageId: null, bufferMessageId: messageId };
}

export function playbackStart(state: PlaybackState, messageId: string): PlaybackState {
  return { ...state, phase: "playing", activeMessageId: messageId, bufferMessageId: messageId };
}

/** Stop the active source; the decoded buffer stays for the Play reply fallback. */
export function playbackStop(state: PlaybackState): PlaybackState {
  return { ...state, phase: "idle", activeMessageId: null };
}

/** Completion only clears the source belonging to this message. */
export function playbackComplete(state: PlaybackState, messageId: string): PlaybackState {
  if (state.activeMessageId !== messageId) {
    return state;
  }
  return { ...state, phase: "idle", activeMessageId: null };
}

/** A kept decoded buffer enables a gesture-resumed "Play reply". */
export function canPlayReply(state: PlaybackState): boolean {
  return state.phase === "idle" && state.bufferMessageId !== null;
}

/** Discard the retained buffer (disable, trip change, unmount). */
export function playbackDiscard(): PlaybackState {
  return { ...INITIAL_PLAYBACK_STATE };
}

/* ------------------------------------------------------------------ */
/* Bounded post-completion reply refresh                               */
/* ------------------------------------------------------------------ */

export const VOICE_REPLY_REFRESH_INTERVAL_MS = 1_500;
export const VOICE_REPLY_REFRESH_WINDOW_MS = 10_000;

export interface ReplyRefreshState {
  readonly operationId: string | null;
  /**
   * Deadline belongs to ONE operation: it is anchored when the operation is
   * first observed settled (section 11) and never reset by later updates.
   */
  readonly deadlineAt: number | null;
}

export const INITIAL_REPLY_REFRESH: ReplyRefreshState = { operationId: null, deadlineAt: null };

/** Register the operation of an accepted Send (no deadline yet). */
export function registerReplyRefresh(
  state: ReplyRefreshState,
  operationId: string,
): ReplyRefreshState {
  if (state.operationId === operationId) {
    return state;
  }
  return { operationId, deadlineAt: null };
}

/** Anchor the 10 s window the first time the operation is seen settled. */
export function anchorReplyRefresh(state: ReplyRefreshState, now: number): ReplyRefreshState {
  if (state.operationId === null || state.deadlineAt !== null) {
    return state;
  }
  return { ...state, deadlineAt: now + VOICE_REPLY_REFRESH_WINDOW_MS };
}

export function replyRefreshActive(state: ReplyRefreshState, now: number): boolean {
  return state.operationId !== null && state.deadlineAt !== null && now < state.deadlineAt;
}

/** Stop the bounded refresh (reply arrived, disabled, trip change, unmount). */
export function stopReplyRefresh(): ReplyRefreshState {
  return INITIAL_REPLY_REFRESH;
}
