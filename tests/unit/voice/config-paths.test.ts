import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { aiConfigRepoRoot, resolveRepoConfigPath } from "@odft/ai";

/**
 * The repository-root fallback for operator config paths must be exactly the
 * repository root for processes started from a workspace (the web app or
 * worker), not one level above it (VOICE_CONTROLL.md section 6: "do not depend
 * on whether the process starts inside the web app or at the root").
 */

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("repository-root config resolution", () => {
  it("resolves the repository root exactly", () => {
    expect(aiConfigRepoRoot()).toBe(resolve(repoRoot));
    expect(existsSync(resolve(aiConfigRepoRoot(), "voice-profiles.example.json"))).toBe(true);
  });

  it("falls back to the repository root when the cwd candidate is missing", () => {
    const fromRoot = resolve(aiConfigRepoRoot(), "operator-config.json");
    const resolved = resolveRepoConfigPath(
      "operator-config.json",
      "VOICE_CONFIG_PATH",
      (candidate) => {
        // Only the repository-root candidate "exists".
        return candidate === fromRoot;
      },
    );
    expect(resolved).toBe(fromRoot);
  });

  it("prefers a cwd candidate over the repository root when both exist", () => {
    const cwdBefore = process.cwd();
    const subdir = mkdtempSync(join(tmpdir(), "voice-cwd-"));
    try {
      // Simulate a workspace cwd so the two candidates genuinely differ.
      process.chdir(subdir);
      const fromCwd = resolve(subdir, "cwd-config.json");
      const fromRoot = resolve(aiConfigRepoRoot(), "cwd-config.json");
      expect(fromCwd).not.toBe(fromRoot);
      expect(resolveRepoConfigPath("cwd-config.json", "VOICE_CONFIG_PATH", () => true)).toBe(
        fromCwd,
      );

      // When the cwd candidate is absent, the fallback is the repository root.
      expect(
        resolveRepoConfigPath(
          "cwd-config.json",
          "VOICE_CONFIG_PATH",
          (candidate) => candidate === fromRoot,
        ),
      ).toBe(fromRoot);
    } finally {
      process.chdir(cwdBefore);
      rmSync(subdir, { recursive: true, force: true });
    }
  });

  it("still resolves absolute paths without a filesystem check", () => {
    expect(resolveRepoConfigPath("/absolute/config.json", "VOICE_CONFIG_PATH", () => false)).toBe(
      "/absolute/config.json",
    );
  });
});
