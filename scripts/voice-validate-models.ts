import { parseServerConfig } from "@odft/persistence";
import {
  assertDocumentedSpeechDefaults,
  assertSpeechCapable,
  loadVoiceProfiles,
  refreshSpeechCapabilityManifest,
  resolveVoiceConfigPath,
  speechCapabilitiesPath,
  stampVoicePricingVersion,
  type SpeechCapabilityFetch,
  VoiceConfigError,
  writeVoiceProfiles,
} from "@odft/ai";
import { loadLocalEnv } from "./_load-env.js";

/**
 * `npm run voice:validate-models` (VOICE_CONTROLL.md section 6; task V02).
 *
 * Requires `AI_MODE=openrouter` and `VOICE_CONFIG_PATH` (a copy of
 * `voice-profiles.example.json`). Fetches the public endpoint metadata for the
 * configured STT/TTS models, verifies model/modality/endpoint/billing unit and
 * exact pricing normalization, checks the profile limits and per-call ceilings,
 * writes `<VOICE_CONFIG_PATH>.capabilities.json`, and stamps the verified
 * `pricingVersion` into the profile file.
 *
 * It validates ONLY public metadata: the assigned Groq-restricted key policy and
 * the actual serving provider/billing remain operator/live verification gates
 * (T-LIVE-VOICE-01). It never prints credentials.
 */

async function main(): Promise<void> {
  // Load .env/.env.local exactly like the other operational scripts, so the
  // documented "set the values in .env and run the command" flow works.
  loadLocalEnv();
  const config = parseServerConfig(process.env);
  if (config.aiMode !== "openrouter") {
    throw new Error(
      "AI_MODE=openrouter is required to validate live speech models (see README: AI modes and configuration)",
    );
  }
  if (!config.voiceConfigPath) {
    throw new Error(
      "VOICE_CONFIG_PATH is required to validate speech models; copy voice-profiles.example.json to a git-ignored voice-profiles.json and point VOICE_CONFIG_PATH at it",
    );
  }
  if (!config.openrouterSttApiKey) {
    console.warn(
      "warning: OPENROUTER_STT_API_KEY is not set; live STT will refuse transport until the dedicated Groq-restricted key is configured",
    );
  }
  // Resolve like the web app (cwd, then repo root) so both use the same file/cache.
  const resolvedConfigPath = resolveVoiceConfigPath(config.voiceConfigPath);
  const profiles = loadVoiceProfiles(resolvedConfigPath);
  // Section 6: the documented models and STT endpoint cannot be swapped silently.
  assertDocumentedSpeechDefaults(profiles);
  const cachePath = speechCapabilitiesPath(resolvedConfigPath);
  const fetchImpl: SpeechCapabilityFetch = (url, init) =>
    fetch(url, { ...init, headers: { ...init?.headers } });

  const manifest = await refreshSpeechCapabilityManifest({ cachePath, fetchImpl, profiles });

  // Validate the stamped profile IN MEMORY first: a failed limit/ceiling check
  // must not leave a freshly pinned profile on disk.
  const stamped = stampVoicePricingVersion(profiles, manifest.pricingVersion);
  for (const kind of ["stt", "tts"] as const) {
    const check = assertSpeechCapable({ profiles: stamped.profiles, kind, manifest });
    const source =
      check.entry.minimumUnitsSource === "documented-provider-evidence"
        ? " (documented provider evidence)"
        : "";
    console.log(
      `${kind}: ${check.entry.model} endpoint=${check.entry.endpointProviderId} unit=${check.entry.unit} rate=${check.entry.ratePerUnitUsd} minimum=${check.entry.minimumUnits}${source} requestFee=${check.entry.requestFeeUsd} worst-call=${check.worstCallCostUsd} (ceiling ${stamped.profiles[kind].maxCallCostUsd})`,
    );
  }

  // `pricingVersion` is the snapshot's fetch timestamp: stamp it only after every
  // check passed, so the profile pins the exact price set that was verified.
  if (stamped.changed) {
    writeVoiceProfiles(resolvedConfigPath, stamped.profiles);
    console.log(`stamped pricingVersion ${manifest.pricingVersion} into ${resolvedConfigPath}`);
  }
  console.log(`voice capability manifest cached at ${cachePath}`);
  console.log(
    "note: public model/pricing metadata validated only; the assigned Groq-only key policy and actual serving/billing remain operator/live gates",
  );
}

main().catch((error: unknown) => {
  if (error instanceof VoiceConfigError) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
