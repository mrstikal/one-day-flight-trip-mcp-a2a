import { existsSync } from "node:fs";

/**
 * Load local `.env` files into `process.env` for development scripts.
 *
 * `.env.local` is loaded first so it takes precedence (process.loadEnvFile does
 * not overwrite existing values). Never throws; callers rely on
 * `parseServerConfig` to report missing or invalid required values.
 */
export function loadLocalEnv(candidates: readonly string[] = [".env.local", ".env"]): void {
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      process.loadEnvFile(candidate);
    } catch {
      // Ignore parse errors here; configuration validation reports the problem.
    }
  }
}
