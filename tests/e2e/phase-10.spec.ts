import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { Pool } from "pg";
import { expect, test, type Page } from "@playwright/test";
import { startWorker, stopWorker, resetRateLimits } from "./_worker.js";

/**
 * T-E2E-09 (E/F/G) and AC-10-1..7: the itinerary page renders the complete
 * validated day with costs and the offline map fallback, the approval flow
 * distinguishes drafts from approved versions, the injected first-attempt
 * overlap is labeled and repaired, and the budget conflict offers a raise-budget
 * clarification without falsified prices or automatic downgrades.
 */

const ORIGIN = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
test.use({ baseURL: ORIGIN });
test.setTimeout(300_000);

let worker: ChildProcess | undefined;

test.beforeAll(async () => {
  await resetRateLimits();
  worker = startWorker();
});

test.afterAll(async () => {
  await stopWorker(worker);
});

async function withPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the Phase 10 e2e controls");
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/** Scenario E overlay: persisted, applied to the operation's first attempt. */
async function armInvalidItinerary(tripId: string): Promise<void> {
  await withPool(async (pool) => {
    await pool.query(
      `INSERT INTO odft_app.simulation_faults (id, trip_id, operation_id, domain, fault, state, counters)
       VALUES ($1, $2, NULL, 'itinerary', 'invalid_itinerary', '{"label":"Simulated failure"}'::jsonb, '{"overlayVersion":1}'::jsonb)`,
      [randomUUID(), tripId],
    );
  });
}

/** Scenario F overlay: an explicit budget far below any feasible party total. */
async function armBudgetConflict(tripId: string): Promise<void> {
  await withPool(async (pool) => {
    await pool.query(
      `UPDATE odft_app.trips
          SET preferences = jsonb_set(preferences, '{maxBudgetMinor}', '100'::jsonb)
        WHERE id = $1`,
      [tripId],
    );
  });
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

async function confirmDialog(page: Page, referencePrefix: string): Promise<void> {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole("button", { name: "Confirm simulated booking" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("I understand this is a simulated booking").check();
  await confirm.click();
  const reference = page.getByTestId("demo-reference");
  await expect(reference).toBeVisible({ timeout: 60_000 });
  await expect(reference).toContainText(referencePrefix);
}

/** Book flight + hotel and save the program, leaving the worker planning. */
async function driveToProgramSaved(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Choose this flight" }).first().click();
  await page.getByRole("button", { name: "Review booking" }).click();
  await confirmDialog(page, "DEMO-FLT-");

  await page.getByRole("link", { name: "Continue to hotel selection" }).click();
  await expect(page).toHaveURL(/\/trips\/[0-9a-f-]+\/hotel$/, { timeout: 60_000 });
  const firstHotel = page.getByTestId("hotel-offer").first();
  await expect(firstHotel).toBeVisible({ timeout: 90_000 });
  await firstHotel.getByRole("button", { name: "Choose this hotel" }).click();
  await page.getByRole("button", { name: "Review booking" }).click();
  await confirmDialog(page, "DEMO-HTL-");

  await page.getByRole("link", { name: "Continue to meals" }).click();
  await expect(page.getByRole("heading", { name: "Plan your day" })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Save program" }).click();
  await expect(page.getByRole("heading", { name: "Meals" })).toBeVisible({
    timeout: 60_000,
  });
}

/** Open the itinerary page and reload until the worker produced a plan. */
async function openItinerary(page: Page, tripId: string): Promise<void> {
  await page.goto(`/trips/${tripId}/itinerary`);
  await expect(page.getByRole("heading", { name: "Itinerary" })).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("itinerary-timeline")).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 180_000, intervals: [2_000, 3_000, 5_000] });
}

/** Approve the pending itinerary draft from the itinerary page. */
async function approveItinerary(page: Page): Promise<void> {
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("open-approval")).toBeEnabled({ timeout: 10_000 });
  }).toPass({ timeout: 180_000, intervals: [2_000, 3_000, 5_000] });
  await page.getByTestId("open-approval").click();
  await page
    .getByTestId("approval-dialog")
    .getByLabel("I understand this approves the current itinerary version")
    .check();
  await page.getByTestId("approve-itinerary").click();
  await expect(page.getByTestId("itinerary-status")).toHaveText("Approved", { timeout: 90_000 });
}

test("renders the validated day, costs, the map fallback, and approves a draft", async ({
  page,
}) => {
  const tripId = await createTrip(page);
  expect(tripId).not.toBe("");
  await driveToProgramSaved(page);
  await openItinerary(page, tripId);

  // Draft until the approval decision is resolved; blocking errors must be gone.
  await expect(page.getByTestId("itinerary-status")).toHaveText("Draft");
  await expect(page.getByTestId("validation-ok")).toBeVisible();
  await expect(page.getByTestId("validation-errors")).toHaveCount(0);

  // A complete day: breakfast/lunch events, activities, breaks, dinner (or the
  // deterministic exclusion note), and a locked return-flight buffer.
  await expect(page.locator('[data-testid="itinerary-event"]').first()).toBeVisible();
  await expect(page.locator('[data-event-kind="meal"]').first()).toBeVisible();
  await expect(page.locator('[data-event-kind="activity"]').first()).toBeVisible();
  const dinnerOrReason =
    (await page.locator('[data-event-kind="meal"]').count()) >= 3
      ? true
      : (await page.getByTestId("dinner-excluded").count()) > 0;
  expect(dinnerOrReason).toBe(true);
  await expect(page.getByTestId("event-lock").first()).toBeVisible();
  // The return leg reserves the simulated airport transfer plus the full buffer.
  const buffer = page.locator('[data-event-kind="airport_buffer"]').first();
  await expect(buffer).toContainText("Airport transfer");

  // Costs: a semantic table with a party total and excluded notes.
  const costs = page.getByTestId("cost-breakdown");
  await expect(costs).toBeVisible();
  await expect(page.getByTestId("cost-total")).toContainText("€");

  // Map: no tile URL in the test environment -> labeled SVG fallback, and every
  // map fact exists as text.
  await expect(page.getByTestId("map-fallback")).toBeVisible();
  await expect(page.getByTestId("map-fallback-label")).toBeVisible();
  await expect(page.getByTestId("marker-list")).toBeVisible();
  await expect(page.getByTestId("map-canvas")).toHaveCount(0);

  // Approval: the dialog names the version and stays disabled until acknowledged.
  await page.getByTestId("open-approval").click();
  const dialog = page.getByTestId("approval-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Approve itinerary version");
  const confirm = page.getByTestId("approve-itinerary");
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("I understand this approves the current itinerary version").check();
  await confirm.click();
  await expect(page.getByTestId("itinerary-status")).toHaveText("Approved", { timeout: 90_000 });
  await expect(page.getByTestId("approved-note")).toBeVisible();
});

test("scenario E: the injected overlap is labeled and repaired", async ({ page }) => {
  const tripId = await createTrip(page);
  expect(tripId).not.toBe("");
  await armInvalidItinerary(tripId);
  await driveToProgramSaved(page);
  await openItinerary(page, tripId);

  // The repaired draft keeps the labeled injected failure visible.
  await expect(page.getByTestId("simulated-failure-label")).toHaveText("Simulated failure");
  await expect(page.getByTestId("simulated-failure-note")).toContainText(
    "repaired within the bounded loop",
  );
  await expect(page.getByTestId("validation-ok")).toBeVisible();
  await expect(page.getByTestId("open-approval")).toBeEnabled({ timeout: 60_000 });
});

test("scenario F: the budget conflict raises a clarification without falsified prices", async ({
  page,
}) => {
  const tripId = await createTrip(page);
  expect(tripId).not.toBe("");
  await armBudgetConflict(tripId);
  await driveToProgramSaved(page);
  await page.goto(`/trips/${tripId}/itinerary`);

  // The clarification card in the assistant preserves the conflict honestly.
  const rail = page.getByTestId("assistant-rail");
  const card = rail.getByTestId("clarification-card");
  await expect(card).toBeVisible({ timeout: 120_000 });
  await expect(card).toContainText("No price was changed");
  const raise = card.getByRole("button", { name: /Raise the budget to/ });
  await expect(raise).toBeVisible();
  // A refresh may re-render the card; retry the choice until it is consumed.
  await expect(async () => {
    await raise.click();
    await expect(page.getByTestId("clarification-card")).toHaveCount(0, { timeout: 15_000 });
  }).toPass({ timeout: 120_000, intervals: [2_000, 3_000, 5_000] });

  // The raised budget replans with the same deterministic prices and approves.
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("itinerary-status")).toHaveText("Draft", { timeout: 10_000 });
    await expect(page.getByTestId("validation-ok")).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 180_000, intervals: [2_000, 3_000, 5_000] });
  const total = (await page.getByTestId("cost-total").innerText()).trim();
  expect(total).not.toBe("€1.00");
  await page.getByTestId("open-approval").click();
  await page
    .getByTestId("approval-dialog")
    .getByLabel("I understand this approves the current itinerary version")
    .check();
  await page.getByTestId("approve-itinerary").click();
  await expect(page.getByTestId("itinerary-status")).toHaveText("Approved", { timeout: 90_000 });
});

test("scenario G: the relaxed six-museums request preserves the typed number", async ({
  page,
}) => {
  const tripId = await createTrip(page);
  expect(tripId).not.toBe("");
  await driveToProgramSaved(page);
  await openItinerary(page, tripId);
  // The chat composer only accepts messages without a blocking decision.
  await approveItinerary(page);

  const rail = page.getByTestId("assistant-rail");
  const composer = rail.getByLabel("Ask for a change");
  await composer.fill("A relaxed day with six museums");
  await rail.getByRole("button", { name: "Send" }).click();

  const card = rail.getByTestId("clarification-card");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText("6 major museums");
  // Feasible options are offered; the numeric requirement is preserved until the
  // user decides (the dense option keeps all six).
  await expect(
    card.getByRole("button", { name: /Use a moderate pace for 6 museums/ }),
  ).toBeVisible();
  const keepRelaxed = card.getByRole("button", { name: /Keep the relaxed pace with 2 museums/ });
  await expect(keepRelaxed).toBeVisible();
  await keepRelaxed.click();
  // The explicit choice re-derives the program step; nothing was reduced silently.
  await expect(page.getByTestId("clarification-card")).toHaveCount(0, { timeout: 90_000 });
  await page.goto(`/trips/${tripId}/meals`);
  await expect(page.getByRole("button", { name: "Save program" })).toBeVisible({
    timeout: 90_000,
  });
});