import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Post-build verification:
 *  1. Every shared workspace package resolves by name from its built `dist/`
 *     output and exposes its expected PACKAGE_ID (proves production ESM
 *     resolution and declaration emission, not just tsx).
 *  2. The Next.js client bundle under `apps/web/.next/static` contains no
 *     server-only configuration tokens or graph/database references.
 */

const PACKAGES: ReadonlyArray<readonly [string, string]> = [
  ["@odft/contracts", "@odft/contracts"],
  ["@odft/domain", "@odft/domain"],
  ["@odft/data", "@odft/data"],
  ["@odft/ai", "@odft/ai"],
  ["@odft/persistence", "@odft/persistence"],
  ["@odft/workflow", "@odft/workflow"],
];

const FORBIDDEN_CLIENT_TOKENS = [
  "SESSION_HMAC_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_STT_API_KEY",
  "VOICE_CONFIG_PATH",
  "VOICE_ENABLED",
  "voice-profiles.json",
  "DATABASE_URL",
  "odft_checkpoint",
  "reference_cities",
  "cities15000",
  "geo-tz",
  "@langchain/core",
  "@langchain/langgraph",
  "langgraph-checkpoint-postgres",
  "checkpointer",
];

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

async function verifyBuiltPackages(): Promise<void> {
  for (const [name, expectedId] of PACKAGES) {
    const mod = (await import(name)) as { PACKAGE_ID?: unknown };
    if (mod.PACKAGE_ID !== expectedId) {
      throw new Error(`Built package ${name} did not expose expected PACKAGE_ID`);
    }
    process.stdout.write(`ok: ${name} resolves from built output\n`);
  }
}

async function verifyClientBundle(): Promise<void> {
  const staticDir = "apps/web/.next/static";
  if (!existsSync(staticDir)) {
    throw new Error(`Next client bundle not found at ${staticDir}`);
  }
  let scanned = 0;
  const violations: string[] = [];
  for (const file of await listFiles(staticDir)) {
    if (!file.endsWith(".js")) {
      continue;
    }
    const info = await stat(file);
    if (info.size > 5_000_000) {
      continue;
    }
    const content = await readFile(file, "utf8");
    scanned += 1;
    for (const token of FORBIDDEN_CLIENT_TOKENS) {
      if (content.includes(token)) {
        violations.push(`${file}: contains forbidden token "${token}"`);
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(`Client bundle leaks server-only content:\n${violations.join("\n")}`);
  }
  process.stdout.write(`ok: client bundle clean (${scanned} chunk(s) scanned)\n`);
}

async function main(): Promise<void> {
  await verifyBuiltPackages();
  await verifyClientBundle();
}

await main();
