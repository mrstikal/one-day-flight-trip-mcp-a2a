import { describe, expect, it } from "vitest";
import {
  anchorReplyRefresh,
  appendTranscript,
  listeningCopy,
  recordingCopy,
  recordingLimitAppliedCopy,
  canPlayReply,
  clearInFlightReply,
  initialReplySelection,
  initializeReplyBaseline,
  markReplyProcessed,
  playbackBufferReady,
  playbackComplete,
  playbackPrepare,
  playbackStart,
  playbackStop,
  registerReplyRefresh,
  replyRefreshActive,
  resetReplyBaseline,
  selectReplyCandidate,
  stopReplyRefresh,
  INITIAL_PLAYBACK_STATE,
  INITIAL_REPLY_REFRESH,
  INITIAL_REPLY_SELECTION,
  VOICE_DRAFT_LIMIT,
  VOICE_REPLY_REFRESH_INTERVAL_MS,
  VOICE_REPLY_REFRESH_WINDOW_MS,
  VOICE_TRANSCRIPT_LIMIT_MESSAGE,
  type ReplySelectionState,
  type VoiceOperationStatus,
  type VoiceReplyMessage,
} from "../../../apps/web/src/lib/voice-state.js";

/**
 * T-UT-VOICE-09/10/11 (VOICE_CONTROLL.md section 15): draft insertion,
 * spoken-reply selection (no early, duplicate, historical, or card-derived
 * speech), and the bounded post-completion refresh.
 */

function message(overrides: Partial<VoiceReplyMessage> = {}): VoiceReplyMessage {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    sequence: 1,
    role: "assistant",
    content: "Your day is ready.",
    operationId: "op-1",
    ...overrides,
  };
}

function settled(operationId: string): VoiceOperationStatus {
  return { operationId, status: "succeeded" };
}

describe("appendTranscript", () => {
  it("inserts into the current draft with the exact separator rules", () => {
    expect(appendTranscript({ draft: "", voiceInsertionError: null }, "  hello  ")).toEqual({
      draft: "hello",
      voiceInsertionError: null,
    });
    expect(
      appendTranscript({ draft: "Plan a trip", voiceInsertionError: null }, "to Rome"),
    ).toEqual({ draft: "Plan a trip to Rome", voiceInsertionError: null });
    expect(
      appendTranscript({ draft: "Plan a trip ", voiceInsertionError: null }, "to Rome"),
    ).toEqual({ draft: "Plan a trip to Rome", voiceInsertionError: null });
    // Existing text is preserved exactly (no rewrite/normalization).
    expect(
      appendTranscript({ draft: "Keep  double  spaces", voiceInsertionError: null }, "ok"),
    ).toEqual({ draft: "Keep  double  spaces ok", voiceInsertionError: null });
  });

  it("enforces the exact 2,000/2,001 boundary including astral characters", () => {
    const atLimit = appendTranscript({ draft: "x".repeat(1996), voiceInsertionError: null }, "abc");
    expect(atLimit.draft.length).toBe(2000);
    expect(atLimit.voiceInsertionError).toBeNull();
    const overLimit = appendTranscript(
      { draft: "x".repeat(1997), voiceInsertionError: null },
      "abc",
    );
    expect(overLimit.draft.length).toBe(1997);
    expect(overLimit.voiceInsertionError).toBe(VOICE_TRANSCRIPT_LIMIT_MESSAGE);
    // An emoji counts as two UTF-16 units, exactly like the server cap.
    const emoji = appendTranscript({ draft: "x".repeat(1998), voiceInsertionError: null }, "🙂");
    expect(emoji.voiceInsertionError).toBe(VOICE_TRANSCRIPT_LIMIT_MESSAGE);
    expect(emoji.draft.length).toBe(1998);
    const emojiAtLimit = appendTranscript(
      { draft: "x".repeat(1997), voiceInsertionError: null },
      "ok",
    );
    expect(emojiAtLimit.draft.length).toBe(2000);
  });

  it("keeps the original draft and raises the insertion error on overflow", () => {
    const draft = "x".repeat(VOICE_DRAFT_LIMIT - 2);
    const next = appendTranscript({ draft, voiceInsertionError: null }, "abc");
    expect(next.draft).toBe(draft);
    expect(next.voiceInsertionError).toBe(VOICE_TRANSCRIPT_LIMIT_MESSAGE);
    // A later successful append clears the error.
    const cleared = appendTranscript(
      { draft: "short", voiceInsertionError: VOICE_TRANSCRIPT_LIMIT_MESSAGE },
      "text",
    );
    expect(cleared.voiceInsertionError).toBeNull();
  });
});

describe("reply selection", () => {
  function ready(messages: readonly VoiceReplyMessage[]): ReplySelectionState {
    return initializeReplyBaseline(initialReplySelection(), messages);
  }

  it("returns a fresh processed-id set for every state factory call", () => {
    expect(initialReplySelection().processedMessageIds).not.toBe(
      initialReplySelection().processedMessageIds,
    );
    expect(INITIAL_REPLY_SELECTION.initialized).toBe(false);
  });

  it("never treats a newer user or system message as a reply", () => {
    const history = [message({ sequence: 5, role: "user" })];
    const messages = [
      message({ id: "u1", sequence: 6, role: "user" }),
      message({ id: "u2", sequence: 7, role: "user" }),
    ];
    const { candidate } = selectReplyCandidate(ready(history), messages, []);
    expect(candidate).toBeNull();
  });

  it("records the baseline once and never speaks older history", () => {
    const history = [message({ sequence: 4 }), message({ sequence: 5, role: "user" })];
    const state = ready(history);
    expect(state.baselineSequence).toBe(5);
    const older = selectReplyCandidate(initializeReplyBaseline(state, history), history, [
      settled("op-1"),
    ]);
    expect(older.candidate).toBeNull();
  });

  it("selects the highest settled new assistant reply and marks it in-flight", () => {
    const history = [message({ sequence: 5, role: "user" })];
    const messages = [
      ...history,
      message({ id: "a", sequence: 6, operationId: "op-6" }),
      message({ id: "b", sequence: 7, operationId: "op-7" }),
      message({ id: "u", sequence: 8, role: "user", operationId: "op-8" }),
    ];
    const first = selectReplyCandidate(ready(history), messages, [
      settled("op-6"),
      settled("op-7"),
    ]);
    expect(first.candidate).toEqual({ messageId: "b", operationId: "op-7" });
    expect(first.state.inFlightMessageId).toBe("b");
    expect(first.state.baselineSequence).toBe(7);
    // A replay of the same projection (Strict Mode/rerender) starts nothing.
    const replay = selectReplyCandidate(first.state, messages, [settled("op-6"), settled("op-7")]);
    expect(replay.candidate).toBeNull();
  });

  it("rejects queued/running/cancelled/missing operations, unlinked and empty messages", () => {
    const messages = [
      message({ id: "queued", sequence: 6, operationId: "op-q" }),
      message({ id: "running", sequence: 7, operationId: "op-r" }),
      message({ id: "cancelled", sequence: 8, operationId: "op-c" }),
      message({ id: "unlinked", sequence: 9, operationId: null }),
      message({ id: "empty", sequence: 10, operationId: "op-e", content: "   " }),
      message({ id: "missing", sequence: 11, operationId: "op-nope" }),
    ];
    const operations: VoiceOperationStatus[] = [
      { operationId: "op-q", status: "queued" },
      { operationId: "op-r", status: "running" },
      { operationId: "op-c", status: "cancelled" },
      settled("op-e"),
    ];
    const { candidate } = selectReplyCandidate(ready(messages), messages, operations);
    expect(candidate).toBeNull();
  });

  it("accepts waiting and failed settled replies with a persisted message", () => {
    const history = [message({ sequence: 5, role: "user" })];
    const messages = [message({ id: "w", sequence: 6, operationId: "op-w" })];
    const waiting = selectReplyCandidate(ready(history), messages, [
      { operationId: "op-w", status: "waiting" },
    ]);
    expect(waiting.candidate?.messageId).toBe("w");
    const failed = selectReplyCandidate(ready(history), messages, [
      { operationId: "op-w", status: "failed" },
    ]);
    expect(failed.candidate?.messageId).toBe("w");
  });

  it("never retries a processed or failed attempt on a later projection", () => {
    const history = [message({ sequence: 5, role: "user" })];
    const messages = [message({ id: "a", sequence: 6 })];
    const { state, candidate } = selectReplyCandidate(ready(history), messages, [settled("op-1")]);
    expect(candidate).not.toBeNull();
    const processed = markReplyProcessed(state, "a");
    expect(processed.inFlightMessageId).toBeNull();
    const project = selectReplyCandidate(processed, messages, [settled("op-1")]);
    expect(project.candidate).toBeNull();
  });

  it("re-baselines on an explicit enable so old replies never speak", () => {
    const messages = [message({ id: "old", sequence: 9 })];
    const state = resetReplyBaseline(INITIAL_REPLY_SELECTION, messages);
    expect(selectReplyCandidate(state, messages, [settled("op-1")]).candidate).toBeNull();
  });

  it("clears an in-flight reply when replies are turned off without forgetting processed ids", () => {
    const messages = [message({ id: "a", sequence: 6 })];
    const { state } = selectReplyCandidate(ready(messages), messages, [settled("op-1")]);
    const cleared = clearInFlightReply(state);
    expect(cleared.inFlightMessageId).toBeNull();
    expect(cleared.processedMessageIds.size).toBe(0);
  });
});

describe("playback state", () => {
  it("keeps at most one active source and retains the buffer for Play reply", () => {
    let state = playbackPrepare(INITIAL_PLAYBACK_STATE, "m1");
    expect(state).toMatchObject({ phase: "preparing", activeMessageId: "m1" });
    state = playbackStart(state, "m1");
    expect(state).toMatchObject({ phase: "playing", activeMessageId: "m1", bufferMessageId: "m1" });
    // Stop keeps the buffer; completion only clears the matching source.
    const stopped = playbackStop(state);
    expect(stopped).toMatchObject({ phase: "idle", activeMessageId: null, bufferMessageId: "m1" });
    expect(canPlayReply(stopped)).toBe(true);
    expect(playbackComplete(state, "other")).toEqual(state);
    const completed = playbackComplete(state, "m1");
    expect(completed).toMatchObject({ phase: "idle", activeMessageId: null });
  });

  it("offers Play reply only after a decoded buffer without an active source", () => {
    const ready = playbackBufferReady(INITIAL_PLAYBACK_STATE, "m1");
    expect(canPlayReply(ready)).toBe(true);
    expect(canPlayReply(playbackStart(ready, "m1"))).toBe(false);
    expect(canPlayReply(INITIAL_PLAYBACK_STATE)).toBe(false);
  });
});

describe("advertised-limit copy", () => {
  it("templates the seconds and matches the documented default at 60", () => {
    expect(listeningCopy(60)).toBe("Listening... Start speaking. Maximum 60 seconds.");
    expect(recordingCopy(60)).toContain("Maximum 60 seconds.");
    expect(recordingCopy(30)).toContain("Maximum 30 seconds.");
    expect(recordingLimitAppliedCopy(30)).toBe("The 30-second recording limit was applied.");
  });
});

describe("bounded reply refresh", () => {
  it("registers without a deadline and anchors the 10 s window once on settle", () => {
    const registered = registerReplyRefresh(INITIAL_REPLY_REFRESH, "op-1");
    expect(registered).toEqual({ operationId: "op-1", deadlineAt: null });
    // Not anchored yet: no bounded polling.
    expect(replyRefreshActive(registered, 0)).toBe(false);
    const anchored = anchorReplyRefresh(registered, 1_000);
    expect(anchored.deadlineAt).toBe(11_000);
    // Projection updates keep re-registering: the deadline is never reset.
    expect(registerReplyRefresh(anchored, "op-1")).toBe(anchored);
    expect(anchorReplyRefresh(anchored, 5_000)).toBe(anchored);
    // A different operation starts a fresh, unanchored registration.
    expect(registerReplyRefresh(anchored, "op-2")).toEqual({
      operationId: "op-2",
      deadlineAt: null,
    });
  });

  it("expires at the window boundary and stops explicitly", () => {
    const anchored = anchorReplyRefresh(registerReplyRefresh(INITIAL_REPLY_REFRESH, "op-1"), 1_000);
    expect(VOICE_REPLY_REFRESH_WINDOW_MS).toBe(10_000);
    expect(VOICE_REPLY_REFRESH_INTERVAL_MS).toBe(1_500);
    expect(replyRefreshActive(anchored, 10_999)).toBe(true);
    expect(replyRefreshActive(anchored, 11_000)).toBe(false);
    expect(stopReplyRefresh()).toEqual({ operationId: null, deadlineAt: null });
    expect(replyRefreshActive(INITIAL_REPLY_REFRESH, 0)).toBe(false);
  });
});
