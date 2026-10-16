import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { Pool } from "pg";
import { expect, test, type Page } from "@playwright/test";
import { startWorker, stopWorker, resetRateLimits } from "./_worker.js";

/**
 * AC-09-4/5 (Phase 09): scenario C renders the empty compatible hotel set with
 * the flight preserved and a retry action that submits `retry_failed_domains`;
 * scenario D renders the siblings and labels the injected `Simulated failure`.
 * Both run on desktop and mobile projects.
 */

const ORIGIN = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
test.use({ baseURL: ORIGIN });
test.setTimeout(240_000);

let worker: ChildProcess | undefined;

test.beforeAll(async () => {
  await resetRateLimits();
  worker = startWorker();
});

test.afterAll(async () => {
  await stopWorker(worker);
});

async function armFault(
  tripId: string,
  domain: string,
  fault: string,
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the Phase 09 e2e faults");
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await pool.query(
      `INSERT INTO odft_app.simulation_faults (id, trip_id, operation_id, domain, fault, state, counters)
       VALUES ($1, $2, NULL, $3, $4, '{}'::jsonb, '{"overlayVersion":1}'::jsonb)`,
      [randomUUID(), tripId, domain, fault],
    );
  } finally {
    await pool.end();
  }
}

async function selectCombobox(page: Page, label: string, query: string): Promise<void> {
  const input = page.getByRole("combobox", { name: label });
  await input.click();
  await input.fill(query);
  const listbox = page.getByRole("listbox", { name: label });
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole("option").first()).toBeVisible();
  await input.press("Enter");
}

async function createTrip(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByLabel("Your name").fill("Ada Lovelace");
  await selectCombobox(page, "Origin airport", "PRG");
  await page.getByLabel("Sightseeing date").fill("2026-12-01");
  await page.getByRole("button", { name: "Continue to destination" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Choose your destination");
  await selectCombobox(page, "Country", "Italy");
  await selectCombobox(page, "City", "Rome");
  await page.getByRole("button", { name: "Create trip" }).click();
  await expect(page).toHaveURL(/\/trips\/[0-9a-f-]+\/flights$/, { timeout: 60_000 });
  const match = /\/trips\/([0-9a-f-]+)\/flights/.exec(page.url());
  return match?.[1] ?? "";
}

async function bookFlight(page: Page): Promise<void> {
  const firstFlight = page.getByRole("button", { name: "Choose this flight" }).first();
  await expect(firstFlight).toBeVisible({ timeout: 60_000 });
  await firstFlight.click();
  await page.getByRole("button", { name: "Review booking" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole("button", { name: "Confirm simulated booking" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("I understand this is a simulated booking").check();
  await confirm.click();
  await expect(page.getByTestId("demo-reference")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("demo-reference")).toContainText("DEMO-FLT-");
}

test("scenario D: the retried hotel research renders siblings and labels the simulated failure", async ({
  page,
}) => {
  const tripId = await createTrip(page);
  expect(tripId).not.toBe("");
  await armFault(tripId, "hotels", "provider_failure");
  await bookFlight(page);

  await page.getByRole("link", { name: "Continue to hotel selection" }).click();
  await expect(page).toHaveURL(/\/trips\/[0-9a-f-]+\/hotel$/, { timeout: 60_000 });
  await expect(page.getByTestId("hotel-offer").first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("simulated-failure-note")).toBeVisible();
  await expect(page.getByTestId("simulated-failure-note")).toContainText("Simulated failure");

  // Siblings were researched in the same run: the meals page renders the meal
  // defaults without any failed-domain panel.
  await page.goto(`/trips/${tripId}/meals`);
  await expect(page.getByRole("heading", { name: "Meals" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("research-failure-breakfast")).toHaveCount(0);
  await expect(page.getByTestId("research-failure-lunch")).toHaveCount(0);
  await expect(page.getByTestId("research-failure-dinner")).toHaveCount(0);
});

test("scenario C: an empty compatible hotel set explains the gap and offers retry", async ({
  page,
}) => {
  const tripId = await createTrip(page);
  expect(tripId).not.toBe("");
  await armFault(tripId, "hotels", "hotels_unavailable");
  await bookFlight(page);

  await page.getByRole("link", { name: "Continue to hotel selection" }).click();
  await expect(page).toHaveURL(/\/trips\/[0-9a-f-]+\/hotel$/, { timeout: 60_000 });

  // The necessary-domain gate opens the recovery decision first.
  await expect(
    page.getByRole("heading", { name: "We need one change to keep your day feasible" }),
  ).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Adjust the hotel" }).click();

  // The failed state explains the gap and offers the retry action.
  const panel = page.getByTestId("research-failure-hotel");
  await expect(panel).toBeVisible({ timeout: 90_000 });
  await expect(panel.getByTestId("simulated-failure-label")).toHaveText("Simulated failure");
  await expect(page.getByTestId("hotel-offer")).toHaveCount(0);
  const retry = page.getByTestId("retry-failed-domains");
  await expect(retry).toBeVisible();
  await expect(retry).toBeEnabled({ timeout: 90_000 });
  await retry.click();

  // The retry re-runs the deterministic domain; the gate honestly explains the
  // gap again (no error banner, no fabricated offer).
  const recoveryHeading = page.getByRole("heading", {
    name: "We need one change to keep your day feasible",
  });
  await expect(recoveryHeading).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('main [role="alert"]')).toHaveCount(0);

  // The confirmed flight is preserved.
  await page.goto(`/trips/${tripId}/flights`);
  await expect(page.getByTestId("demo-reference")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("demo-reference")).toContainText("DEMO-FLT-");
});
