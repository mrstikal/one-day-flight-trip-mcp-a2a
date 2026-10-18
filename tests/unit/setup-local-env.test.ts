import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../scripts/setup-local-env.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "odft-setup-env-"));

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("setup:env", () => {
  it("generates a distinct random secret for every replace-me placeholder", () => {
    writeFileSync(
      join(directory, ".env.example"),
      [
        "SESSION_HMAC_KEY=replace-me",
        "ODFT_PROTOCOL_ROLE_PASSWORD=replace-me",
        "ODFT_MCP_READONLY_PASSWORD=replace-me",
        "ODFT_AGENT_TOKEN_FLIGHT=replace-me",
        "ODFT_AGENT_TOKEN_ACCOMMODATION=replace-me",
        "",
      ].join("\n"),
    );
    execFileSync(TSX, [SCRIPT], { cwd: directory, stdio: "pipe" });
    const env = readFileSync(join(directory, ".env"), "utf8");
    expect(env).not.toContain("replace-me");
    const values = env
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.slice(line.indexOf("=") + 1));
    expect(values).toHaveLength(5);
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) {
      expect(value).toMatch(/^[0-9a-f]{96}$/);
    }
    expect(statSync(join(directory, ".env")).mode & 0o777).toBe(0o600);
  }, 30_000);
});
