import type { ChildProcess } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { startWorker, stopWorker, resetRateLimits } from "./_worker.js";

/**
 * AC-08-1/2/3: the assistant rail shows the persisted conversation in fixture
 * mode, a chat message becomes a validated intent with an interpretation card,
 * and a clarification offers bounded options that apply a stored choice.
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

async function selectCombobox(page: Page, label: string, query: string): Promise<void> {
  const input = page.getByRole("combobox", { name: label });
  await input.click();
  await input.fill(query);
  const listbox = page.getByRole("listbox", { name: label });
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole("option").first()).toBeVisible();
  await input.press("Enter");
}

/** Phase 10: a saved program plans the itinerary; approve it to free the chat. */
async function approveItinerary(page: Page, tripId: string): Promise<void> {
  await page.goto(`/trips/${tripId}/itinerary`);
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

async function confirmDialog(page: Page, referencePrefix: string): Promise<void> {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole("button", { name: "Confirm simulated booking" });
  await dialog.getByLabel("I understand this is a simulated booking").check();
  await confirm.click();
  const reference = page.getByTestId("demo-reference");
  await expect(reference).toBeVisible({ timeout: 60_000 });
  await expect(reference).toContainText(referencePrefix);
}

test("assistant rail interprets a chat request and applies a clarification choice", async ({
  page,
}) => {
  // Create the trip and drive it to a decision-free ready state.
  await page.goto("/");
  await page.getByLabel("Your name").fill("Ada Lovelace");
  await selectCombobox(page, "Origin airport", "PRG");
  await page.getByLabel("Sightseeing date").fill("2026-12-01");
  await page.getByRole("button", { name: "Continue to destination" }).click();
  await selectCombobox(page, "Country", "Italy");
  await selectCombobox(page, "City", "Rome");
  await page.getByRole("button", { name: "Create trip" }).click();
  await expect(page).toHaveURL(/\/trips\/[0-9a-f-]+\/flights$/, { timeout: 60_000 });
  const tripId = /\/trips\/([0-9a-f-]+)\//.exec(page.url())?.[1] ?? "";
  expect(tripId).not.toBe("");

  const rail = page.getByTestId("assistant-rail");
  await expect(rail).toBeVisible();
  await expect(rail).toContainText("fixture mode");

  await page.getByRole("button", { name: "Choose this flight" }).first().click();
  await page.getByRole("button", { name: "Review booking" }).click();
  await confirmDialog(page, "DEMO-FLT-");

  await page.getByRole("link", { name: "Continue to hotel selection" }).click();
  const firstHotel = page.getByTestId("hotel-offer").first();
  await expect(firstHotel).toBeVisible({ timeout: 60_000 });
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
  // Phase 10: the saved program plans the itinerary and waits for approval.
  await approveItinerary(page, tripId);
  await page.goto(`/trips/${tripId}/meals`);

  // Chat: one admitted operation, interpreted in fixture mode.
  const composer = rail.getByLabel("Ask for a change");
  await composer.fill("Make the day less exhausting");
  await rail.getByRole("button", { name: "Send" }).click();
  await expect(rail.getByTestId("conversation-messages")).toContainText(
    "Make the day less exhausting",
  );
  await expect(rail.getByTestId("interpretation-card").first()).toContainText("relaxed pace");

  // A relaxed pace invalidates the saved program and re-plans the itinerary
  // directly — no second "Save program" decision is created. The rail
  // auto-opens the itinerary step, where the fresh draft only needs approval.
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/itinerary$`), { timeout: 60_000 });
  await expect(page.getByTestId("open-approval")).toBeVisible({ timeout: 60_000 });
  await approveItinerary(page, tripId);
  await page.goto(`/trips/${tripId}/meals`);

  // A contradictory request opens the bounded clarification card.
  await composer.fill("A relaxed day with six museums");
  await rail.getByRole("button", { name: "Send" }).click();
  const card = rail.getByTestId("clarification-card");
  await expect(card).toBeVisible({ timeout: 60_000 });
  const options = card.getByRole("button");
  await expect(options.first()).toBeVisible();
  const optionCount = await options.count();
  expect(optionCount).toBeGreaterThanOrEqual(2);
  await options.first().click();
  await expect(rail.getByTestId("conversation-messages")).toContainText("Applied", {
    timeout: 60_000,
  });
});

test("an unsupported chat explains itself and keeps the pending decision answerable", async ({
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
  await page.getByRole("button", { name: "Choose this flight" }).first().click();
  await page.getByRole("button", { name: "Review booking" }).click();
  await confirmDialog(page, "DEMO-FLT-");
  await page.getByRole("link", { name: "Continue to hotel selection" }).click();
  await expect(page.getByTestId("hotel-offer").first()).toBeVisible({ timeout: 90_000 });

  // A request the interpreter cannot map: the assistant says so…
  const rail = page.getByTestId("assistant-rail");
  await rail.getByLabel("Ask for a change").fill("moon flight");
  await rail.getByRole("button", { name: "Send" }).click();
  await expect(rail.getByTestId("conversation-messages")).toContainText(
    "scripted fixture response",
    { timeout: 60_000 },
  );

  // …and the exact hotel choice is re-presented: the step stays answerable
  // instead of hanging on a "preparing…" state with no decision.
  await expect(page.getByTestId("hotel-offer").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Choose this hotel" }).first()).toBeEnabled();
});
