import { writeFileSync } from "node:fs";
import { parseServerConfig } from "@odft/persistence";
import { loadLocalEnv } from "./_load-env.js";
import {
  assertModelCapable,
  loadRoleProfiles,
  resolveAiConfigPath,
  refreshCapabilityManifest,
  stampPricingVersion,
  type CapabilityFetch,
} from "@odft/ai";

/**
 * `npm run ai:validate-models` (06-ai-agent-design.md section 3).
 *
 * Requires `AI_MODE=openrouter`, `OPENROUTER_API_KEY`, and `AI_CONFIG_PATH`
 * (a JSON file with all four role profiles). Refreshes the per-endpoint
 * capability/pricing manifest, stamps the verified `pricingVersion` into the
 * profiles file, and asserts every profile is capable and priced. Exits
 * non-zero on any failure; never prints credentials.
 */

async function main(): Promise<void> {
  // Load .env/.env.local exactly like the other operational scripts, so the
  // documented "set the values in .env and run the command" flow works.
  loadLocalEnv();
  const config = parseServerConfig(process.env);
  if (config.aiMode !== "openrouter") {
    throw new Error(
      "AI_MODE=openrouter is required to validate model capabilities (see README: AI modes and configuration)",
    );
  }
  if (!config.openrouterApiKey) {
    // Capability/pricing listing is public; the worker still needs the key to call.
    console.warn(
      "warning: OPENROUTER_API_KEY is not set; validating public capability/pricing data only",
    );
  }
  const configPath = config.aiConfigPath;
  if (!configPath) {
    throw new Error(
      "AI_CONFIG_PATH is required to validate model capabilities (see README: AI modes and configuration)",
    );
  }
  // Resolve like the worker (cwd, then repo root) so both use the same file/cache.
  const resolvedConfigPath = resolveAiConfigPath(configPath);
  const loaded = loadRoleProfiles({ mode: "openrouter", configPath: resolvedConfigPath });
  if (!loaded.profiles) {
    throw new Error("no role profiles were loaded");
  }
  const cachePath = `${resolvedConfigPath}.capabilities.json`;
  const fetchImpl: CapabilityFetch = (url, init) =>
    fetch(url, { ...init, headers: { ...init?.headers } });
  const manifest = await refreshCapabilityManifest({
    cachePath,
    fetchImpl,
    models: [
      loaded.profiles.intent.model,
      loaded.profiles.recommendation.model,
      loaded.profiles.planner.model,
      loaded.profiles.reviewer.model,
    ],
    ...(config.openrouterApiKey ? { apiKey: config.openrouterApiKey } : {}),
  });

  // `pricingVersion` is the manifest's fetch timestamp: stamp it so the profiles
  // pin the exact price set that was just verified.
  const stamped = stampPricingVersion(loaded.profiles, manifest.pricingVersion);
  if (stamped.changed) {
    writeFileSync(resolvedConfigPath, `${JSON.stringify(stamped.profiles, null, 2)}\n`, "utf8");
    console.log(`stamped pricingVersion ${manifest.pricingVersion} into ${resolvedConfigPath}`);
  }

  for (const role of ["intent", "recommendation", "planner", "reviewer"] as const) {
    const check = assertModelCapable(stamped.profiles[role], manifest);
    console.log(
      `${role}: ${check.model} endpoints=[${check.endpoints
        .map((endpoint) => endpoint.providerId)
        .join(
          ", ",
        )}] worst-case rates ok (in ${check.worstInputPriceUsdPerMillion}/M, out ${check.worstOutputPriceUsdPerMillion}/M)`,
    );
  }
  console.log(`capability manifest cached at ${cachePath}`);
  const missing = [
    loaded.profiles.intent.model,
    loaded.profiles.recommendation.model,
    loaded.profiles.planner.model,
    loaded.profiles.reviewer.model,
  ].filter((model) => manifest.models[model] === undefined);
  if (missing.length > 0) {
    console.warn(`warning: no capability data for ${missing.join(", ")}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
