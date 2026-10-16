"use client";

import { VOICE_COPY } from "@/lib/voice-state";
import type { AssistantVoice } from "@/lib/use-assistant-voice";

/**
 * Voice controls (VOICE_CONTROLL.md sections 11 and 12).
 *
 * Mounted inside the existing assistant form between the textarea and Send:
 * Dictate/Stop recording, Cancel dictation, the "Read replies aloud" checkbox,
 * Stop speaking / Play reply when applicable, and the live status/error lines.
 * All buttons are `type="button"` so no voice action can ever submit the form.
 * The fixed helper sentence lives below Send, referenced via aria-describedby.
 */
export function VoiceControls({
  voice,
}: {
  readonly voice: AssistantVoice;
}): React.JSX.Element | null {
  if (voice.serverEnabled === null) {
    // Availability unknown: never silent when the query itself failed.
    if (voice.availabilityError) {
      return (
        <p role="status" className="text-xs text-ink-muted" data-testid="voice-availability-error">
          {voice.availabilityError}
        </p>
      );
    }
    return null;
  }
  if (voice.serverEnabled === false) {
    return (
      <p role="status" className="text-xs text-ink-muted" data-testid="voice-disabled">
        {VOICE_COPY.voiceDisabled}
      </p>
    );
  }
  const recording = voice.phase === "recording";
  const captureBusy =
    voice.phase === "preparing" ||
    voice.phase === "recording" ||
    voice.phase === "stopping" ||
    voice.phase === "transcribing";
  return (
    <section
      aria-label="Voice controls"
      data-testid="voice-controls"
      aria-describedby="assistant-voice-help"
      className="flex flex-col gap-2"
    >
      <p className="text-xs text-ink-muted" data-testid="voice-privacy">
        {VOICE_COPY.privacyNotice}
      </p>
      <p className="text-xs text-ink-muted" data-testid="voice-pause-hint">
        {VOICE_COPY.pauseHint}
      </p>
      {voice.mode === "fixture" ? (
        <p className="text-xs text-ink-muted" data-testid="voice-fixture-label">
          {VOICE_COPY.fixtureMode}
        </p>
      ) : null}
      {!voice.supported ? (
        <p role="status" className="text-xs text-ink-muted" data-testid="voice-unsupported">
          {VOICE_COPY.unsupported}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="voice-dictate"
            aria-pressed={recording}
            disabled={captureBusy && !recording}
            onClick={() => {
              if (recording) {
                voice.stopRecording();
              } else {
                voice.dictate();
              }
            }}
            className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {recording ? VOICE_COPY.stopRecording : VOICE_COPY.dictate}
          </button>
          {captureBusy ? (
            <button
              type="button"
              data-testid="voice-cancel"
              onClick={() => {
                voice.cancelDictation();
              }}
              className="rounded border border-border px-3 py-1.5 text-sm"
            >
              {VOICE_COPY.cancelDictation}
            </button>
          ) : null}
        </div>
      )}
      <label className="flex items-center gap-2 text-sm" htmlFor="assistant-voice-replies">
        <input
          id="assistant-voice-replies"
          type="checkbox"
          data-testid="voice-replies-toggle"
          checked={voice.repliesEnabled}
          onChange={(event) => {
            voice.setRepliesEnabled(event.target.checked);
          }}
        />
        {VOICE_COPY.readReplies}
      </label>
      {voice.speaking ? (
        <button
          type="button"
          data-testid="voice-stop-speaking"
          onClick={() => {
            voice.stopSpeaking();
          }}
          className="self-start rounded border border-border px-3 py-1.5 text-sm"
        >
          {VOICE_COPY.stopSpeaking}
        </button>
      ) : null}
      {voice.offerPlayReply ? (
        <button
          type="button"
          data-testid="voice-play-reply"
          onClick={() => {
            voice.playReply();
          }}
          className="self-start rounded border border-border px-3 py-1.5 text-sm"
        >
          {VOICE_COPY.playReply}
        </button>
      ) : null}
      {voice.statusMessage ? (
        <p role="status" className="text-xs text-ink-muted" data-testid="voice-status">
          {voice.statusMessage}
        </p>
      ) : null}
      {voice.error ? (
        <p role="alert" className="text-sm text-red-700" data-testid="voice-error">
          {voice.error}
        </p>
      ) : null}
      {voice.notice ? (
        <p role="status" className="text-xs text-ink-muted" data-testid="voice-notice">
          {voice.notice}
        </p>
      ) : null}
    </section>
  );
}
