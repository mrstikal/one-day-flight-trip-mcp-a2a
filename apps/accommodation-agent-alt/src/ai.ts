import type { DelegatedFlightRankingDeps } from "@odft/services";
import { loadDelegatedRankingDeps as loadDeps } from "@odft/services";
import type { ServerConfig } from "@odft/persistence";
import type { AccommodationAltAgentConfig } from "./config.js";

/**
 * Phase 10 alternative paid-path wiring. It reuses the shared governed
 * delegated wiring but loads ITS OWN optional profile file
 * (`ODFT_ACCOMMODATION_ALT_AI_CONFIG_PATH`), so the replacement implementation
 * can run a different model profile without touching the primary agent.
 */
export async function loadDelegatedRankingDeps(
  config: AccommodationAltAgentConfig,
  serverConfig: ServerConfig,
): Promise<DelegatedFlightRankingDeps> {
  return loadDeps(config, serverConfig);
}
