import type { ChildProcess } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { startWorker, stopWorker, resetRateLimits } from "./_worker.js";

/**
 * AC-06-1/2/5/9: the full wizard — no trip before a city, worker-driven flights,
 * a keyboard-operable choice and confirmation, and a single DEMO-FLT reference.
 * Runs on both the desktop and mobile projects.
 */

const DEMO_DISCLAIMER =
  "DEMO APPLICATION - No real reservations are made and no payments are processed.";
const CONFIRMATION_DISCLAIMER =
  "Simulated booking - not valid for travel, accommodation, or restaurant admission.";

// The browser origin must match the server's PUBLIC_BASE_URL so session creation
// passes the same-origin check.
const ORIGIN = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
test.use({ baseURL: ORIGIN });

let worker: ChildProcess | undefined;

test.beforeAll(async () => {
  await resetRateLimits();
  worker = startWorker();
});

test.afterAll(async () => {
  await stopWorker(worker);
});

async function selectCombobox(page: Page, label: string, query: string): Promise<void> {
  const input = page.getByRole("combobox", { name: label });
  await input.click();
  await input.fill(query);
  const listbox = page.getByRole("listbox", { name: label });
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole("option").first()).toBeVisible();
  await input.press("Enter");
}

test("plans PRG -> Rome and books the demo flight with a reference", async ({ page }) => {
  await page.goto("/");

  // No trip exists yet: the welcome step is shown, not a trip page.
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Plan one sightseeing day");
  await expect(page).toHaveURL(/\/$/);

  // AC-06-10: the AI-mode banner is visible.
  await expect(page.getByTestId("ai-mode-banner")).toContainText(
    "Deterministic fixture mode - no live AI calls",
  );

  await page.getByLabel("Your name").fill("Ada Lovelace");
  await selectCombobox(page, "Origin airport", "PRG");
  await page.getByLabel("Sightseeing date").fill("2026-12-01");
  await page.getByRole("button", { name: "Continue to destination" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toContainText("Choose your destination");
  await selectCombobox(page, "Country", "Italy");
  await selectCombobox(page, "City", "Rome");
  await page.getByRole("button", { name: "Create trip" }).click();

  // The worker drives feasibility, generation, and schedule validation.
  await expect(page).toHaveURL(/\/trips\/[0-9a-f-]+\/flights$/, { timeout: 60_000 });
  const firstOffer = page.getByRole("button", { name: "Choose this flight" }).first();
  await expect(firstOffer).toBeVisible({ timeout: 60_000 });

  // Keyboard-only selection of the first offer.
  await firstOffer.focus();
  await page.keyboard.press("Enter");

  const review = page.getByRole("button", { name: "Review booking" });
  await expect(review).toBeVisible({ timeout: 60_000 });
  await review.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // AC-06-6: both disclaimers verbatim inside the confirmation dialog.
  await expect(dialog.getByText(CONFIRMATION_DISCLAIMER, { exact: true })).toBeVisible();
  await expect(dialog.getByText(DEMO_DISCLAIMER, { exact: true })).toBeVisible();

  // AC-06-5: confirmation is blocked until the disclaimer is acknowledged.
  const confirm = dialog.getByRole("button", { name: "Confirm simulated booking" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("I understand this is a simulated booking").check();
  await expect(confirm).toBeEnabled();
  await confirm.click();

  const reference = page.getByTestId("demo-reference");
  await expect(reference).toBeVisible({ timeout: 60_000 });
  await expect(reference).toContainText("DEMO-FLT-");

  // The summary is a waypoint, not a dead end: it offers the next unfinished step.
  await page.getByRole("link", { name: "View trip summary" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "Confirmed simulated reservations" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue to hotel selection" })).toBeVisible();
});

test("going back to steps 1-2 keeps the created trip's values visible and read-only, reload included", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Your name").fill("Grace Hopper");
  await selectCombobox(page, "Origin airport", "PRG");
  await page.getByLabel("Sightseeing date").fill("2026-12-01");
  await page.getByRole("button", { name: "Continue to destination" }).click();

  await selectCombobox(page, "Country", "Italy");
  await selectCombobox(page, "City", "Rome");
  await page.getByRole("button", { name: "Create trip" }).click();
  await expect(page).toHaveURL(/\/trips\/[0-9a-f-]+\/flights$/, { timeout: 60_000 });
  const tripPath = new URL(page.url()).pathname;

  // Step 2 survives the trip round trip: values visible, the wizard read-only.
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Choose your destination");
  await expect(page.getByRole("combobox", { name: "Country" })).toHaveValue("Italy");
  await expect(page.getByRole("combobox", { name: "City" })).toHaveValue("Rome");
  await expect(page.getByRole("combobox", { name: "Country" })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "City" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Create trip" })).toBeDisabled();

  // Step 1: same, and the entered values are restored.
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Plan one sightseeing day");
  await expect(page.getByLabel("Your name")).toHaveValue("Grace Hopper");
  await expect(page.getByLabel("Sightseeing date")).toHaveValue("2026-12-01");
  await expect(page.getByLabel("Your name")).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Origin airport" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Continue to destination" })).toBeDisabled();

  // A reload keeps the created-trip record: the wizard steps show the values
  // read-only instead of an empty new-trip form.
  await page.reload();
  await expect(page.getByLabel("Your name")).toHaveValue("Grace Hopper");
  await expect(page.getByRole("button", { name: "Continue to destination" })).toBeDisabled();
  await page.goto("/destination");
  await expect(page.getByRole("combobox", { name: "Country" })).toHaveValue("Italy");
  await expect(page.getByRole("button", { name: "Create trip" })).toBeDisabled();

  // The reported flow: refresh the trip page, then use the Trip steps links.
  await page.goto(tripPath);
  await page.reload();
  await page.getByTestId("step-nav-destination").click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Choose your destination");
  await expect(page.getByRole("combobox", { name: "City" })).toHaveValue("Rome");
  await expect(page.getByRole("combobox", { name: "City" })).toBeDisabled();
  await page.goto(tripPath);
  await page.getByTestId("step-nav-details").click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Plan one sightseeing day");
  await expect(page.getByLabel("Your name")).toHaveValue("Grace Hopper");

  // Starting a new trip clears the read-only draft and its stored record.
  await page.getByRole("button", { name: "Start a new trip" }).click();
  await expect(page.getByLabel("Your name")).toBeEnabled();
  await expect(page.getByLabel("Your name")).toHaveValue("");
  await page.reload();
  await expect(page.getByLabel("Your name")).toBeEnabled();
  await expect(page.getByLabel("Your name")).toHaveValue("");
});
