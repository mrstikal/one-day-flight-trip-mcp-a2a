# ADR-008: Optional Voice Interface (Speech-to-Text and Spoken Replies)

Status: accepted; V00-V06 implemented 2026-10-15 (plan 2026-10-14). Verification limits listed below.

## Context

The assistant rail is complete for typed input. An optional voice interface adds dictation into the existing
composer and spoken replies for settled assistant messages. It must not weaken the existing guarantees:
manual Send, the four reasoning roles, budget/authorization semantics, no business mutations from speech,
auditability, and English-only UI copy. Speech involves external billable providers, microseconds-fresh
pricing, microphone permissions, and potentially persistent audio - all of which need explicit boundaries.
Full plan: [`../../../VOICE_CONTROLL.md`](../../../VOICE_CONTROLL.md) (local-only planning document).

## Decision

- **OpenRouter-only speech.** Both models go exclusively through the OpenRouter gateway using documented
  native audio endpoints: `openai/whisper-large-v3-turbo` for STT and `elevenlabs/eleven-v4-turbo`
  (voice `george`, MP3) for TTS. No direct provider calls, no provider SDK, no invented model ids.
- **Approved dedicated Groq-restricted STT key.** STT uses `OPENROUTER_STT_API_KEY` - a separate inference
  key that must have an **assigned** guardrail (provider allowlist exactly `groq`, model allowlist exactly
  `openai/whisper-large-v3-turbo`) because the speech API has no per-request provider pin. The shared
  `OPENROUTER_API_KEY` continues to serve TTS/reasoning and is never an STT substitute. A blocked-model
  attempt is the required policy proof (guardrail assignment/verification currently pending).
- **Separate adapters, profiles, and ledger.** Speech lives in `@odft/ai` adapters with its own operator
  profile (`voice-profiles.json`), strict capability/pricing snapshot, exact rational tariff math
  (arbitrary fractional digits, upward nanos rounding, documented Groq 10-second minimum), and the
  independent `voice_calls` USD ledger - never merged with LLM calls or travel EUR money.
- **Explicit activation and manual Send.** No microphone access on mount; the first explicit Dictate
  gesture activates capture (and enables "Read replies aloud" for the tab, which the user can turn off).
  Recording/transcription only fill the composer; the ordinary chat admission requires an explicit Send
  and keeps its request id, revision checks, and error handling.
- **Content-only TTS and the settled-operation gate.** Only a persisted assistant message with a non-null
  `operationId` whose same-trip operation is settled (`succeeded`/`waiting`/`failed`) is spoken; the
  synthesized input equals the message's plain `content` - interpretation cards, options, history, and
  user text are never read. Delayed message delivery is covered by a bounded post-Send refresh
  (1.5 s cadence, one 10 s window).
- **Native Web APIs only.** Capture, normalization (canonical 16 kHz mono PCM WAV), local Silero VAD
  detection, and playback use standard browser APIs via a framework-free capture controller; no
  third-party runtime, no DOM scraping.
- **Browser-local VAD with self-hosted assets (FR-VOICE-14).** The pinned Silero detector and its ONNX
  runtime assets are same-origin (`/voice-vad/`, prepared by `predev`/`prebuild`, licenses recorded in the
  generated MANIFEST); no CDN, no raw audio frames leave the device, and there is no VAD provider billing.
- **No persistent audio and no speech-induced business mutations.** Audio, transcripts, and TTS text are
  never persisted or logged; successful speech changes no trip revision, decision, reservation, or
  booking, and never invokes the graph. The atomically emitted `conversation.message_added` event carries
  only `{messageId, sequence, role}`.

## Alternatives

| Alternative                                 | Reason not chosen                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Direct Groq/ElevenLabs provider calls       | Second credential class, no unified billing/guardrail, contradicts gateway-only transport |
| Reuse the shared key for STT                | Cannot be Groq-restricted; violates Groq-only routing and key separation                  |
| Server-side or hosted VAD                   | Adds provider billing and raw-audio egress; local detection needs no service              |
| Browser dependency/CDN for the VAD assets   | Violates same-origin/self-hosted requirements and CSP minimalism                          |
| Provider `strict`/`only` request pin        | Not part of the documented speech endpoint schemas                                        |
| Auto-Send after dictation                   | Removes explicit review; violates "recording creates no message/operation"                |
| Speak cards/interpretations or read history | Wrong eligibility and leakage of derived/label content                                    |
| Persist audio/transcripts for replay        | Privacy, retention, and cost-reconciliation burden without user value                     |
| Fire-and-forget TTS without a ledger        | Uncertain charges would be silently forgiven or overspent                                 |

## Consequences

- The voice feature is opt-in (`VOICE_ENABLED=false` default); fixture mode is credential-free and labeled
  in the UI, and fixture audio is test audio - not proof of live TTS.
- An invalid live configuration surfaces as a voice-only 503 with actionable copy; unrelated routes and
  typed chat keep working, and no silent fallback happens.
- Uncertain upstream charges stay reserved until explicit reconciliation with billing evidence.
- The operator runbook (README "Voice control (optional)") covers enable/disable, exact environment names,
  profile validation (`npm run voice:validate-models`), guardrail creation **and assignment**, and
  effective-policy verification.

## Verification and References

- Tests: `tests/unit/voice/*` (contracts/config, capabilities/costs, audio, adapters, state, events, VAD,
  mocked-browser capture, asset provenance), `tests/integration/voice/*` (BFF routes, ledger concurrency
  and uncertainty, atomic conversation events, inspector separation), `tests/e2e/voice-control.spec.ts`
  (desktop + mobile, real Silero detector with committed synthetic-speech fixtures in
  `tests/fixtures/voice/`). FR mapping: [01-functional-requirements](../01-functional-requirements.md#61-voice-traceability-2026-10-15).
- Dated live evidence (provider level, 2026-10-15): real transcript from a 4.85 s synthetic recording;
  Groq serving evidence with `usage.seconds = 10` (documented 10-second minimum confirmed through the
  gateway) and `usage.cost 0.000111111111111`; ElevenLabs `eleven-v4-turbo-20260930` delivering a 43 511 B
  MP3 at `total_cost 0.00074` (37 chars x 0.00002) - both matching the reservation math.
- Verification limits (unverified, not passed): assigned-guardrail effective-policy proof (pending
  operator assignment), full in-app live flow, audible listening, real mobile/Safari/Firefox behavior,
  and the browser network inspection of a live session.
