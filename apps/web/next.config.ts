import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/**
 * Load the repository-root `.env` files (development convenience) before Next.js
 * reads its own. `.env.local` is loaded first so it takes precedence. Production
 * deployments provide real environment variables. No secret reaches the client.
 */
function loadRootEnv(): void {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const candidates = [
    join(repoRoot, ".env.local"),
    join(repoRoot, ".env"),
    ".env.local",
    ".env",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch {
        // Ignore; server configuration validation reports real problems.
      }
    }
  }
}

loadRootEnv();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
