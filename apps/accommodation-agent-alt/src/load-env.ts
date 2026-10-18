/**
 * Minimal .env loader for the alternative Accommodation Agent (mirrors the
 * other agents' helper without importing another application).
 */
export function loadLocalEnv(): void {
  const file = process.env.ODFT_ENV_FILE ?? ".env";
  try {
    process.loadEnvFile(file);
  } catch {
    // Missing .env is fine when every required variable comes from the process.
  }
}
