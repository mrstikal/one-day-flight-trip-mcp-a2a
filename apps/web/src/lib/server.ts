import { createPool, parseServerConfig, type ServerConfig } from "@odft/persistence";

/**
 * Server-only singletons for the BFF. Cached on `globalThis` so dev HMR and
 * route module re-evaluations do not leak connection pools. Configuration is
 * parsed lazily and fails with an actionable error; secrets never reach the
 * client bundle (these modules are imported by route handlers only).
 */

export type WebPool = ReturnType<typeof createPool>;

interface WebServerDeps {
  readonly config: ServerConfig;
  readonly pool: WebPool;
}

const globalForDeps = globalThis as unknown as { __odftWebDeps?: WebServerDeps };

export function getServerDeps(): WebServerDeps {
  if (!globalForDeps.__odftWebDeps) {
    const config = parseServerConfig();
    globalForDeps.__odftWebDeps = {
      config,
      pool: createPool(config, { applicationName: "odft-web" }),
    };
  }
  return globalForDeps.__odftWebDeps;
}
