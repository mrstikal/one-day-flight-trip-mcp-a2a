import { defineConfig, devices } from "@playwright/test";
import { loadLocalEnv } from "./scripts/_load-env.js";

// Populate process.env (DATABASE_URL, PUBLIC_BASE_URL, ...) for the web server
// and for test workers that spawn the Phase 05 worker process.
// Existing environment variables win: `process.loadEnvFile` never overwrites
// them, so an isolated run can point the whole stack at a disposable database
// and a dedicated port without editing `.env`.
loadLocalEnv();

/**
 * One local origin for the web server, the browser and the API helpers, derived
 * from `PUBLIC_BASE_URL` — the BFF validates the exact Origin of mutating
 * requests against it, so a hardcoded origin would fail session creation
 * whenever the configured origin differs. The server is started on the same
 * port (Next.js honors `PORT`), and an already-running server is never reused:
 * the isolated baseline must own its fixture-mode stack instead of silently
 * attaching to a live `npm run dev` server or the user's application worker.
 */
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000/";
const baseUrl = new URL(PUBLIC_BASE_URL);
const BASE_URL = baseUrl.origin;
const PORT = baseUrl.port || (baseUrl.protocol === "https:" ? "443" : "80");

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
    // Never attach to an existing server: a dev/live server may run in another
    // AI mode, on another database, or share the operation queue with a live
    // worker. A busy port must fail the run explicitly instead.
    reuseExistingServer: false,
    timeout: 120_000,
    // The end-to-end suite must run in deterministic fixture mode (AC-06-10);
    // voice is enabled without credentials (fixture needs no profile/keys).
    // `PORT` binds the server to the same port the browser/API helpers use.
    env: { AI_MODE: "fixture", VOICE_ENABLED: "true", PORT },
  },
});
