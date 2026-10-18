import { constants, copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Copy every committed configuration template to its runtime name.
 *
 * Replaces the manual `cp <name>.example.json <name>.json` steps from the
 * README. Existing runtime files are never overwritten, so operator edits
 * survive repeated runs. Secrets are not handled here: `.env` is created by
 * `npm run setup:env`.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const TEMPLATES = [
  ["ai-profiles.example.json", "ai-profiles.json"],
  ["voice-profiles.example.json", "voice-profiles.json"],
  ["agent-registry.example.json", "agent-registry.json"],
  ["mcp-registry.example.json", "mcp-registry.json"],
  ["mcp-registry.accommodation.example.json", "mcp-registry.accommodation.json"],
  ["mcp-registry.city-guide.example.json", "mcp-registry.city-guide.json"],
  ["mcp-registry.accommodation-alt.example.json", "mcp-registry.accommodation-alt.json"],
  ["mcp-host-registry.example.json", "mcp-host-registry.json"],
] as const;

function main(): void {
  let created = 0;
  let kept = 0;
  for (const [sourceName, targetName] of TEMPLATES) {
    const source = resolve(REPO_ROOT, sourceName);
    const target = resolve(REPO_ROOT, targetName);
    if (!existsSync(source)) {
      throw new Error(`${sourceName} is missing; the committed template set is incomplete`);
    }
    try {
      copyFileSync(source, target, constants.COPYFILE_EXCL);
      process.stdout.write(`created ${targetName}\n`);
      created += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        process.stdout.write(`kept existing ${targetName}\n`);
        kept += 1;
        continue;
      }
      throw error;
    }
  }
  process.stdout.write(
    `Configuration ready: ${String(created)} created, ${String(kept)} left unchanged.\n` +
      "Runtime files are git-ignored; edit them locally and never commit secrets.\n",
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
