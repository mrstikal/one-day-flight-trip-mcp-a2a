import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { voiceProfilesFileSchema, type VoiceProfilesFile } from "@odft/contracts";
import { resolveRepoConfigPath } from "./config.js";

/**
 * Voice profile loading and startup syntax validation (VOICE_CONTROLL.md section 6).
 *
 * The operator speech profile is a separate strict file (never the four-role AI
 * profiles). Loading validates syntax and bounds only; live capability/pricing
 * requirements are checked against the stamped snapshot by the voice service.
 */

export class VoiceConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid voice configuration:\n- ${issues.join("\n- ")}`);
    this.name = "VoiceConfigError";
    this.issues = issues;
  }
}

/** Resolve `VOICE_CONFIG_PATH` with the shared repository-root rule. */
export function resolveVoiceConfigPath(
  configPath: string,
  exists: (candidate: string) => boolean = existsSync,
): string {
  try {
    return resolveRepoConfigPath(configPath, "VOICE_CONFIG_PATH", exists);
  } catch (error) {
    throw new VoiceConfigError([error instanceof Error ? error.message : String(error)]);
  }
}

/** The verified capability snapshot lives next to the operator profile file. */
export function speechCapabilitiesPath(resolvedConfigPath: string): string {
  return `${resolvedConfigPath}.capabilities.json`;
}

/** Load and strictly validate the operator voice profile file. */
export function loadVoiceProfiles(configPath: string): VoiceProfilesFile {
  const resolved = resolveVoiceConfigPath(configPath);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new VoiceConfigError([
      `VOICE_CONFIG_PATH could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  const parsed = voiceProfilesFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new VoiceConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  return parsed.data;
}

/**
 * Stamp the verified pricing version (the capability snapshot's fetch
 * timestamp) into the profile file. `pricingVersion` is machine-managed:
 * `voice:validate-models` refreshes the snapshot and stamps it, so an operator
 * never copies a timestamp by hand.
 */
export function stampVoicePricingVersion(
  profiles: VoiceProfilesFile,
  pricingVersion: string,
): { readonly profiles: VoiceProfilesFile; readonly changed: boolean } {
  if (profiles.pricingVersion === pricingVersion) {
    return { profiles, changed: false };
  }
  return { profiles: { ...profiles, pricingVersion }, changed: true };
}

/** Write a stamped profile file back (only used by the validator script). */
export function writeVoiceProfiles(resolvedConfigPath: string, profiles: VoiceProfilesFile): void {
  writeFileSync(resolvedConfigPath, `${JSON.stringify(profiles, null, 2)}\n`, "utf8");
}
