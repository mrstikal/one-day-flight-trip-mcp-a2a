import { spawnSync } from "node:child_process";
import { loadLocalEnv } from "./_load-env.js";

/**
 * One-shot model validation: AI role profiles first, then voice profiles when
 * voice is configured. The individual scripts stay available
 * (`ai:validate-models`, `voice:validate-models`) for targeted runs.
 */

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function run(script: string): number {
  const result = spawnSync(NPM, ["run", script], { stdio: "inherit", env: process.env });
  if (result.error) {
    process.stderr.write(`${script} could not start: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

function main(): void {
  loadLocalEnv();

  const aiStatus = run("ai:validate-models");
  if (aiStatus !== 0) {
    process.exitCode = aiStatus;
    return;
  }

  const voiceEnabled = ["true", "1", "yes"].includes(
    (process.env.VOICE_ENABLED ?? "").trim().toLowerCase(),
  );
  const voiceConfigured = Boolean(process.env.VOICE_CONFIG_PATH?.trim()) || voiceEnabled;
  if (!voiceConfigured) {
    process.stdout.write(
      "voice validation skipped: VOICE_CONFIG_PATH is not set (voice is optional)\n",
    );
    return;
  }

  const voiceStatus = run("voice:validate-models");
  if (voiceStatus !== 0) {
    process.exitCode = voiceStatus;
  }
}

main();
