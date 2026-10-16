import { existsSync } from "node:fs";

// Load local env files for tests when present. `.env.local` is loaded first so
// it takes precedence (process.loadEnvFile does not overwrite existing values).
// Missing files are fine: tests that need a value fail loudly on their own.
for (const candidate of [".env.local", ".env"]) {
  if (existsSync(candidate)) {
    try {
      process.loadEnvFile(candidate);
    } catch {
      // Ignore parse errors; individual tests validate what they need.
    }
  }
}
