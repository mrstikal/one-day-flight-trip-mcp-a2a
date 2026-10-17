import {
  loadCapabilityManifest,
  loadRoleProfiles,
  OpenRouterAdapter,
  resolveAiConfigPath,
} from "@odft/ai";
import type { RoleProfile } from "@odft/contracts";
import type { ServerConfig } from "@odft/persistence";
import type { DelegatedFlightRankingDeps, DelegatedItineraryDeps } from "./runtime.js";

/**
 * Phase 06 shared paid-path wiring for delegated specialists.
 *
 * The adapter carries NO governor: every transport attempt is reserved and
 * settled by the delegated runtime against the restricted ledger functions,
 * never through the coordinator's fenced `reserveCall`. The adapter is built
 * with a single transport attempt per reservation so one ledger row equals one
 * billable send. Profile and capability manifest load once at startup; a
 * missing or stale manifest fails closed with the actionable
 * `ai:validate-models` error instead of failing every task.
 */
export async function loadDelegatedRankingDeps(
  config: { readonly aiMode: "fixture" | "openrouter"; readonly aiConfigPath: string | null },
  serverConfig: ServerConfig,
): Promise<DelegatedFlightRankingDeps> {
  if (config.aiMode !== "openrouter") {
    return {};
  }
  const loaded = loadRoleProfiles({
    mode: "openrouter",
    configPath: config.aiConfigPath ?? serverConfig.aiConfigPath,
  });
  if (!loaded.profiles) {
    throw new Error(
      "AI_MODE=openrouter requires AI_CONFIG_PATH with a validated recommendation profile",
    );
  }
  const profile: RoleProfile | undefined = loaded.profiles.recommendation;
  if (!profile) {
    throw new Error("the AI profile config has no recommendation profile for the delegated specialist");
  }
  // One delegated reservation must cover EXACTLY one billable transport
  // attempt: the ledger counts reservations, so the adapter's internal retry
  // loop is disabled on this path (a task-level re-attempt needs a new
  // reservation, bounded by the per-scope attempt limit).
  const delegatedProfile: RoleProfile = { ...profile, maxAttempts: 1 };
  const configPath = config.aiConfigPath ?? serverConfig.aiConfigPath;
  const manifest = await loadCapabilityManifest({
    cachePath: configPath
      ? `${resolveAiConfigPath(configPath)}.capabilities.json`
      : ".ai/capabilities.json",
    models: Object.values(loaded.profiles).map((entry) => entry.model),
  });
  return {
    paidProfile: delegatedProfile,
    paidAdapter: new OpenRouterAdapter({
      apiKey: serverConfig.openrouterApiKey ?? "",
      manifest,
      profiles: { ...loaded.profiles, recommendation: delegatedProfile },
    }),
  };
}

/**
 * Phase 08 City Guide itinerary paid-path wiring: planner (and reviewer, kept
 * available for agent-local review) profiles with exactly one transport attempt
 * per delegated reservation. Fixture mode stays free and needs no profile.
 */
export async function loadDelegatedItineraryDeps(
  config: { readonly aiMode: "fixture" | "openrouter"; readonly aiConfigPath: string | null },
  serverConfig: ServerConfig,
): Promise<DelegatedItineraryDeps> {
  if (config.aiMode !== "openrouter") {
    return {};
  }
  const loaded = loadRoleProfiles({
    mode: "openrouter",
    configPath: config.aiConfigPath ?? serverConfig.aiConfigPath,
  });
  if (!loaded.profiles) {
    throw new Error(
      "AI_MODE=openrouter requires AI_CONFIG_PATH with validated planner and reviewer profiles",
    );
  }
  const planner = loaded.profiles.planner;
  const reviewer = loaded.profiles.reviewer;
  if (!planner || !reviewer) {
    throw new Error("the AI profile config has no planner/reviewer profile for the itinerary skill");
  }
  const plannerProfile: RoleProfile = { ...planner, maxAttempts: 1 };
  const reviewerProfile: RoleProfile = { ...reviewer, maxAttempts: 1 };
  const configPath = config.aiConfigPath ?? serverConfig.aiConfigPath;
  const manifest = await loadCapabilityManifest({
    cachePath: configPath
      ? `${resolveAiConfigPath(configPath)}.capabilities.json`
      : ".ai/capabilities.json",
    models: Object.values(loaded.profiles).map((entry) => entry.model),
  });
  return {
    paidPlannerProfile: plannerProfile,
    paidReviewerProfile: reviewerProfile,
    paidAdapter: new OpenRouterAdapter({
      apiKey: serverConfig.openrouterApiKey ?? "",
      manifest,
      profiles: {
        ...loaded.profiles,
        planner: plannerProfile,
        reviewer: reviewerProfile,
      },
    }),
  };
}
