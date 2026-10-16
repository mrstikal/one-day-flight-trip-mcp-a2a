/**
 * Regenerates the committed synthetic-speech fixtures.
 *
 * Run ad hoc (the generator dependency is intentionally NOT a project
 * dependency and must not be installed in CI):
 *
 *   npm i --no-save mespeak
 *   node tests/fixtures/voice/generate.mjs
 *
 * meSpeak.js (eSpeak heritage, GPL-3.0) is used only to render the synthetic
 * speech waveform; the generated WAV files are plain test data and the phrases
 * are authored for this repository. No personal or third-party recordings.
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const meSpeak = require("mespeak");
meSpeak.loadConfig(require("mespeak/src/mespeak_config.json"));
meSpeak.loadVoice(require("mespeak/voices/en/en-us.json"));

const here = dirname(fileURLToPath(import.meta.url));

function render(text) {
  const buffer = meSpeak.speak(text, { rawdata: "ArrayBuffer", speed: 150, pitch: 50 });
  const bytes = Buffer.from(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint16(20, true) !== 1 ||
    view.getUint16(22, true) !== 1 ||
    view.getUint16(34, true) !== 16
  ) {
    throw new Error("unexpected meSpeak output format");
  }
  const dataBytes = view.getUint32(40, true);
  return Int16Array.from(new Int16Array(bytes.buffer, bytes.byteOffset + 44, dataBytes / 2));
}

const RATE = 22050;
const silence = (ms) => new Int16Array(Math.round((ms / 1000) * RATE));

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function writeWav(name, samples) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(RATE, 24);
  bytes.writeUInt32LE(RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i += 1) {
    bytes.writeInt16LE(samples[i], 44 + i * 2);
  }
  writeFileSync(join(here, name), bytes);
  console.log(name, `${(samples.length / RATE).toFixed(2)}s`);
}

// One fixture drives both timing tests:
// [2.6 s initial silence] speech A [0.8 s short pause] speech B [4 s trailing silence]
// - initial silence > 2 s: must NOT stop (no confirmed speech yet)
// - 0.8 s pause between phrases: below the 2 s threshold, must NOT stop
// - trailing > 2 s after confirmed speech: MUST stop automatically once
const a = render("Please ease the pace a little.");
const b = render("And find a quieter museum.");
writeWav("speech-with-pauses.wav", concat(silence(2600), a, silence(800), b, silence(4000)));
