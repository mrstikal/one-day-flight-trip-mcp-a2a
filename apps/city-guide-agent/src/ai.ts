import type { DelegatedItineraryDeps } from "@odft/services";
import { loadDelegatedItineraryDeps as loadDeps } from "@odft/services";
import type { ServerConfig } from "@odft/persistence";
import type { CityGuideAgentConfig } from "./config.js";

/**
 * Phase 08 itinerary paid-path wiring: planner (and reviewer) profiles with one
 * delegated transport attempt per reservation, fail-fast profile/manifest
 * loading. Fixture mode stays offline and free.
 */
export async function loadItineraryDeps(
  config: CityGuideAgentConfig,
  serverConfig: ServerConfig,
): Promise<DelegatedItineraryDeps> {
  return loadDeps(config, serverConfig);
}
