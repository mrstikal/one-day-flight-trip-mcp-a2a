# Voice E2E speech fixtures

Synthetic English speech fixtures for the browser voice tests
(`tests/e2e/voice-control.spec.ts`). They exist so the real Silero VAD
detector in the browser can run against actual speech-like audio with
controlled silence — a tone/beep is not evidence that the model recognizes
speech.

- `speech-with-pauses.wav` — 22050 Hz mono PCM16, 11.84 s:
  `[2.655 s initial silence | 1.54 s phrase A | 1.25 s pause | 1.99 s phrase B | 4.4 s trailing silence]`.
  Drives the timing tests: the 2.65 s initial silence must not stop an
  unconfirmed recording; the 1.25 s internal pause is below the 2 s threshold;
  the trailing silence must complete exactly one dictation.
- `live-smoke-16k.wav` — 16 kHz mono PCM16, 4.85 s: the two phrases (2.60–7.45 s)
  resampled to the canonical upload format. Used by the credential-gated live
  speech smoke (T-LIVE-VOICE-01); never uploaded by CI.

Provenance: rendered offline with `meSpeak.js` (eSpeak heritage, GPL-3.0; used
only as a local generator, NOT a project or runtime dependency) using the
phrases above, authored for this repository. No personal, third-party, or
otherwise sensitive recordings are included; the content is non-sensitive
travel-neutral text.

Regenerate (ad hoc only; requires network for the temporary install):

```bash
npm i --no-save mespeak
node tests/fixtures/voice/generate.mjs
```

CI never regenerates these files and never installs the generator.
