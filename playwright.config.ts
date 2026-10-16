import { defineConfig, devices } from "@playwright/test";
import { loadLocalEnv } from "./scripts/_load-env.js";

// Populate process.env (DATABASE_URL, PUBLIC_BASE_URL, ...) for the web server
// and for test workers that spawn the Phase 05 worker process.
loadLocalEnv();

const BASE_URL = "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  // Each spec spawns its own worker process; serializing specs avoids CPU/DB
  // contention between concurrent worker processes (flaky under parallelism).
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 5"], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command: "npm run start -w @odft/web",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // The end-to-end suite must run in deterministic fixture mode (AC-06-10);
    // voice is enabled without credentials (fixture needs no profile/keys).
    env: { AI_MODE: "fixture", VOICE_ENABLED: "true" },
  },
});
