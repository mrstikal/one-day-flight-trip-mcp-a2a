import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isDirectScriptInvocation,
  prepareVoiceVadAssets,
} from "../../../scripts/voice-vad-assets.js";
import {
  END_OF_DICTATION_SILENCE_MS,
  VOICE_VAD_ASSET_PATH,
  VOICE_VAD_OPTIONS,
} from "../../../apps/web/src/lib/voice-vad.js";

/**
 * T-UT-VOICE-15 (VOICE_CONTROLL.md section 15): the pinned VAD preparation
 * copies the model, worklet, and matching WASM/MJS runtime files, and the
 * browser configuration uses only same-origin `/voice-vad/` URLs — never
 * library defaults or CDN URLs.
 */

const require = createRequire(import.meta.url);

describe("voice VAD asset preparation", () => {
  it("prepares the exact pinned file set with provenance", () => {
    const result = prepareVoiceVadAssets();
    const targets = result.assets.map((asset) => asset.target).sort();
    expect(targets).toEqual(
      [
        "ort-wasm-simd-threaded.jsep.mjs",
        "ort-wasm-simd-threaded.jsep.wasm",
        "ort-wasm-simd-threaded.mjs",
        "ort-wasm-simd-threaded.wasm",
        "silero_vad_v5.onnx",
        "vad.worklet.bundle.min.js",
      ].sort(),
    );
    for (const asset of result.assets) {
      const targetPath = join(result.outputDir, asset.target);
      expect(existsSync(targetPath), targetPath).toBe(true);
      expect(statSync(targetPath).size, targetPath).toBeGreaterThan(0);
    }
    const manifest = JSON.parse(readFileSync(join(result.outputDir, "MANIFEST.json"), "utf8")) as {
      packages: Array<{ name: string; version: string }>;
      files: Array<{ target: string }>;
    };
    const versions = new Map(manifest.packages.map((pkg) => [pkg.name, pkg.version]));
    expect(versions.get("@ricky0123/vad-web")).toBe("0.0.31");
    expect(versions.get("onnxruntime-web")).toBe("1.22.0");
    expect(manifest.files.map((file) => file.target).sort()).toEqual(targets);
  });

  it("matches the asset names the pinned detector library loads", () => {
    const assetPathScript = require.resolve("@ricky0123/vad-web/dist/real-time-vad.js");
    const source = readFileSync(assetPathScript, "utf8");
    expect(source).toContain("vad.worklet.bundle.min.js");
    expect(source).toContain("silero_vad_v5.onnx");
  });

  it("preserves upstream license notices including the dist bundle notice", () => {
    const result = prepareVoiceVadAssets();
    const vadWeb = result.packages.find((pkg) => pkg.name === "@ricky0123/vad-web");
    expect(vadWeb?.shippedLicenseFiles).toContain("dist/bundle.min.js.LICENSE.txt");
    const copied = result.copiedLicenseFiles.find(
      (entry) => entry.source === "dist/bundle.min.js.LICENSE.txt",
    );
    expect(copied).toBeDefined();
    if (copied) {
      const text = readFileSync(join(result.outputDir, copied.target), "utf8");
      expect(text).toContain("ONNX Runtime Web");
      expect(text).toContain("MIT License");
    }
  });

  it("detects direct invocation robustly through symlinked entry paths", () => {
    const scriptPath = fileURLToPath(
      new URL("../../../scripts/voice-vad-assets.ts", import.meta.url),
    );
    const realUrl = pathToFileURL(realpathSync(scriptPath)).href;
    const dir = mkdtempSync(join(tmpdir(), "voice-vad-guard-"));
    try {
      const link = join(dir, "voice-vad-assets-link.ts");
      symlinkSync(scriptPath, link);
      // As under a symlinked checkout: argv[1] is the symlink while the ESM
      // loader reports the real path in import.meta.url.
      expect(isDirectScriptInvocation(link, realUrl)).toBe(true);
      expect(isDirectScriptInvocation(link, pathToFileURL(link).href)).toBe(true);
      expect(isDirectScriptInvocation(scriptPath, realUrl)).toBe(true);
      expect(isDirectScriptInvocation(undefined, realUrl)).toBe(false);
      expect(isDirectScriptInvocation(join(dir, "other.ts"), realUrl)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses only same-origin asset URLs and the documented VAD options", () => {
    expect(VOICE_VAD_ASSET_PATH).toBe("/voice-vad/");
    expect(VOICE_VAD_OPTIONS.baseAssetPath).toBe("/voice-vad/");
    expect(VOICE_VAD_OPTIONS.onnxWASMBasePath).toBe("/voice-vad/");
    expect(VOICE_VAD_OPTIONS.model).toBe("v5");
    expect(VOICE_VAD_OPTIONS.processorType).toBe("AudioWorklet");
    expect(VOICE_VAD_OPTIONS.redemptionMs).toBe(END_OF_DICTATION_SILENCE_MS);
    expect(VOICE_VAD_OPTIONS.redemptionMs).toBe(2_000);
    expect(VOICE_VAD_OPTIONS.startOnLoad).toBe(false);
    expect(VOICE_VAD_OPTIONS.submitUserSpeechOnPause).toBe(false);
    expect(JSON.stringify(VOICE_VAD_OPTIONS)).not.toMatch(/https?:\/\//);
  });
});
