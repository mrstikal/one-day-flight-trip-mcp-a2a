/**
 * Minimal .env loader for the Accommodation Agent (mirrors the worker's helper
 * without importing the worker app).
 */
export function loadLocalEnv(): void {
  const file = process.env.ODFT_ENV_FILE ?? ".env";
  try {
    process.loadEnvFile(file);
  } catch {
    // Missing .env is fine when every required variable comes from the process.
  }
}
