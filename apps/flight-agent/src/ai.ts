import type { DelegatedFlightRankingDeps } from "@odft/services";
import { loadDelegatedRankingDeps as loadDeps } from "@odft/services";
import type { ServerConfig } from "@odft/persistence";
import type { FlightAgentConfig } from "./config.js";

/**
 * Phase 05 flight paid-path wiring: the shared delegated wiring (governor-free
 * adapter, single transport attempt per reservation, fail-fast profile loading).
 */
export async function loadDelegatedRankingDeps(
  config: FlightAgentConfig,
  serverConfig: ServerConfig,
): Promise<DelegatedFlightRankingDeps> {
  return loadDeps(config, serverConfig);
}
