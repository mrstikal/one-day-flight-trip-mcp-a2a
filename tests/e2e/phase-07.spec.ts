import type { ChildProcess } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { startWorker, stopWorker, resetRateLimits } from "./_worker.js";

/**
 * AC-07-1/2/5/6: from a confirmed flight the wizard continues into hotel
 * selection, a review proposal, and a simulated hotel reservation, then the
 * program choices. The confirmation dialog shows both disclaimers verbatim and
 * stays blocked until acknowledged. Runs on desktop and mobile.
 */

const DEMO_DISCLAIMER =
  "DEMO APPLICATION - No real reservations are made and no payments are processed.";
const CONFIRMATION_DISCLAIMER =
  "Simulated booking - not valid for travel, accommodation, or restaurant admission.";

const ORIGIN = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
test.use({ baseURL: ORIGIN });
// The Phase 07 flow drives flights, hotel, and program choices through the
// worker; under the full parallel run this exceeds the 30s default.
test.setTimeout(180_000);

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
  await expect(dialog.getByText(CONFIRMATION_DISCLAIMER, { exact: true })).toBeVisible();
  await expect(dialog.getByText(DEMO_DISCLAIMER, { exact: true })).toBeVisible();
  const confirm = dialog.getByRole("button", { name: "Confirm simulated booking" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("I understand this is a simulated booking").check();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  const reference = page.getByTestId("demo-reference");
  await expect(reference).toBeVisible({ timeout: 60_000 });
  await expect(reference).toContainText(referencePrefix);
}

test("books a simulated flight and hotel, then saves the program choices", async ({ page }) => {
  const tripId = await createTrip(page);
  expect(tripId).not.toBe("");

  // The step nav lists every step; the hotel unlocks only after a confirmed flight.
  await expect(page.getByTestId("step-nav")).toBeVisible();
  await expect(page.getByTestId("step-nav-details")).toHaveAttribute("href", "/");
  await expect(page.getByTestId("step-nav-flights")).toHaveAttribute(
    "href",
    `/trips/${tripId}/flights`,
  );
  await expect(page.getByTestId("step-nav-hotel")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("step-nav-meals")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("step-nav-activities")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("step-nav-itinerary")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("step-nav-summary")).toHaveAttribute(
    "href",
    `/trips/${tripId}/summary`,
  );

  const firstFlight = page.getByRole("button", { name: "Choose this flight" }).first();
  await expect(firstFlight).toBeVisible({ timeout: 60_000 });
  await firstFlight.click();
  await page.getByRole("button", { name: "Review booking" }).click();
  await confirmDialog(page, "DEMO-FLT-");

  await expect(page.getByTestId("step-nav-hotel")).toHaveAttribute(
    "href",
    `/trips/${tripId}/hotel`,
  );
  await expect(page.getByTestId("step-nav-meals")).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("link", { name: "Continue to hotel selection" }).click();
  await expect(page).toHaveURL(/\/trips\/[0-9a-f-]+\/hotel$/, { timeout: 60_000 });
  const firstHotel = page.getByTestId("hotel-offer").first();
  await expect(firstHotel).toBeVisible({ timeout: 60_000 });
  await firstHotel.getByRole("button", { name: "Choose this hotel" }).click();
  await page.getByRole("button", { name: "Review booking" }).click();
  await confirmDialog(page, "DEMO-HTL-");

  await expect(page.getByTestId("step-nav-meals")).toHaveAttribute(
    "href",
    `/trips/${tripId}/meals`,
  );
  await expect(page.getByTestId("step-nav-activities")).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("link", { name: "Continue to meals" }).click();
  await expect(page).toHaveURL(/\/trips\/[0-9a-f-]+\/meals$/, { timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Plan your day" })).toBeVisible({
    timeout: 60_000,
  });
  // The step that needs the user next is marked.
  await expect(page.getByTestId("step-nav-meals")).toContainText("next");
  await page.getByRole("button", { name: "Save program" }).click();
  await expect(page.getByRole("heading", { name: "Meals" })).toBeVisible({
    timeout: 60_000,
  });

  // Saving the program unlocks the activities and the itinerary; planning then
  // starts and the approval on the itinerary needs the user next.
  await expect(page.getByTestId("step-nav-activities")).toHaveAttribute(
    "href",
    `/trips/${tripId}/activities`,
  );
  await expect(page.getByTestId("step-nav-itinerary")).toHaveAttribute(
    "href",
    `/trips/${tripId}/itinerary`,
  );
  await expect(page.getByTestId("step-nav-itinerary")).toContainText("next", {
    timeout: 60_000,
  });
});

test("meals and activities live on separate pages with per-meal tile sections", async ({ page }) => {
  const tripId = await createTrip(page);
  expect(tripId).not.toBe("");

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

  // Three meal sections, each with its own category select and offer tiles.
  await expect(page.getByRole("heading", { name: "Plan your day" })).toBeVisible({
    timeout: 60_000,
  });
  for (const meal of ["breakfast", "lunch"]) {
    await expect(page.getByTestId(`level-select-${meal}`)).toHaveValue("standard");
    await expect(page.getByTestId(`meal-offer-${meal}`).first()).toBeVisible();
  }
  // The one-night fixture return leaves at 21:00: dinner is excluded outright —
  // no tiles, no category select, only the prominent reason.
  await expect(page.getByTestId("meal-offer-dinner")).toHaveCount(0);
  await expect(page.getByTestId("level-select-dinner")).toHaveCount(0);
  await expect(page.getByTestId("dinner-not-included")).toContainText(
    "too early to finish dinner",
  );
  // No activities here: they live on their own step.
  await expect(page.getByLabel("Activity choices")).toHaveCount(0);

  // A different tile per section is a local selection; Save program applies it.
  await page
    .getByTestId("meal-offer-lunch")
    .nth(1)
    .getByRole("button", { name: "Choose this lunch" })
    .click();
  await page.getByRole("button", { name: "Save program" }).click();
  await expect(page.getByRole("heading", { name: "Meals" })).toBeVisible({ timeout: 60_000 });

  // The saved view lists the choices; per-meal category selects live only in the
  // program-choices view (a Change reopens them), never in the saved list.
  await expect(page.getByTestId("level-select-breakfast")).toHaveCount(0);
  await expect(page.getByTestId("level-select-lunch")).toHaveCount(0);

  // The activities page holds the activity choices and no meal selects.
  await page.getByRole("link", { name: "Go to activities" }).click();
  await expect(page).toHaveURL(/\/trips\/[0-9a-f-]+\/activities$/, { timeout: 60_000 });
  await expect(page.getByLabel("Activity choices")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("level-select-lunch")).toHaveCount(0);
});

test("self-arranged meals and activities hide their offers and appear in the itinerary", async ({
  page,
}) => {
  const tripId = await createTrip(page);
  expect(tripId).not.toBe("");

  await page.getByRole("button", { name: "Choose this flight" }).first().click();
  await page.getByRole("button", { name: "Review booking" }).click();
  await confirmDialog(page, "DEMO-FLT-");
  await page.getByRole("link", { name: "Continue to hotel selection" }).click();
  const firstHotel = page.getByTestId("hotel-offer").first();
  await expect(firstHotel).toBeVisible({ timeout: 90_000 });
  await firstHotel.getByRole("button", { name: "Choose this hotel" }).click();
  await page.getByRole("button", { name: "Review booking" }).click();
  await confirmDialog(page, "DEMO-HTL-");

  // Meals: mark breakfast as self-arranged; its category and offers disappear.
  await page.getByRole("link", { name: "Continue to meals" }).click();
  await expect(page.getByRole("heading", { name: "Plan your day" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("meal-offer-breakfast").first()).toBeVisible();
  await page.getByTestId("self-arranged-breakfast").check();
  await expect(page.getByTestId("meal-offer-breakfast")).toHaveCount(0);
  await expect(page.getByTestId("level-select-breakfast")).toHaveCount(0);
  await expect(page.getByTestId("self-arranged-note-breakfast")).toBeVisible();
  await page.getByRole("button", { name: "Save program" }).click();
  await expect(page.getByRole("heading", { name: "Meals" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("saved-self-arranged-breakfast")).toBeChecked();
  await expect(page.getByText("You arrange this yourself — not part of the plan.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reserve breakfast" })).toHaveCount(0);

  // The planned day lists the self-arranged breakfast and contains no breakfast
  // event; approving unlocks the activities step.
  await page.goto(`/trips/${tripId}/itinerary`);
  await expect(page.getByTestId("self-arranged-note")).toContainText("Breakfast", {
    timeout: 180_000,
  });
  await expect(page.locator('[data-event-kind="meal"]')).not.toHaveCount(0);
  const mealTexts = (
    await page.locator('[data-event-kind="meal"]').allTextContents()
  )
    .join(" ")
    .toLowerCase();
  expect(mealTexts).not.toContain("breakfast");
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

  // Activities: mark them self-arranged; the list disappears and the choice saves.
  await page.goto(`/trips/${tripId}/activities`);
  await expect(page.getByTestId("self-arranged-activities")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("self-arranged-activities").check();
  await expect(page.getByLabel("Activity choices")).toHaveCount(0);
  // The command must be admitted before leaving the page; then the durable state
  // is visible on a fresh projection (the replanned draft waits for approval).
  await Promise.all([
    page.waitForResponse(
      (response) => response.url().includes("/commands") && response.request().method() === "POST",
      { timeout: 60_000 },
    ),
    page.getByRole("button", { name: "Save plan" }).click(),
  ]);
  await expect(page.getByTestId("self-arranged-activities-note")).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("self-arranged-activities-note")).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 120_000, intervals: [1_000, 2_000, 3_000] });

  // The replanned itinerary names both self-arranged parts and plans no visits.
  await page.goto(`/trips/${tripId}/itinerary`);
  await expect(page.getByTestId("self-arranged-note")).toContainText("activities", {
    timeout: 180_000,
  });
  await expect(page.getByTestId("self-arranged-note")).toContainText("Breakfast");
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("itinerary-status")).toHaveText("Draft", { timeout: 10_000 });
    await expect(page.locator('[data-event-kind="activity"]')).toHaveCount(0);
  }).toPass({ timeout: 180_000, intervals: [2_000, 3_000, 5_000] });
});

test("declining the flight and hotel booking keeps them in the plan as Not booked", async ({
  page,
}) => {
  const tripId = await createTrip(page);
  expect(tripId).not.toBe("");

  // Choose a flight, then decline the simulated booking ("I don't want to
  // book"): the offer is kept as the selection and hotel selection unlocks.
  await page.getByRole("button", { name: "Choose this flight" }).first().click();
  await expect(page.getByRole("button", { name: "Review booking" })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByTestId("decline-flight-booking").click();
  await expect(page.getByTestId("flight-not-booked")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("step-nav-hotel")).toHaveAttribute(
    "href",
    `/trips/${tripId}/hotel`,
  );
  await page.getByRole("link", { name: "Continue to hotel selection" }).click();
  await expect(page).toHaveURL(/\/trips\/[0-9a-f-]+\/hotel$/, { timeout: 60_000 });

  // The same two options exist for the hotel: choosing stages the review, and
  // declining keeps it as the selection and continues to meals.
  await expect(page.getByTestId("hotel-offer").first()).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("hotel-offer").first().getByRole("button", { name: "Choose this hotel" }).click();
  await expect(page.getByRole("button", { name: "Review booking" })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByTestId("decline-hotel-booking").click();
  await expect(page.getByTestId("hotel-not-booked")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("step-nav-meals")).toHaveAttribute(
    "href",
    `/trips/${tripId}/meals`,
  );
  await page.getByRole("link", { name: "Continue to meals" }).click();
  await expect(page).toHaveURL(/\/trips\/[0-9a-f-]+\/meals$/, { timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Plan your day" })).toBeVisible({
    timeout: 90_000,
  });
  await page.getByRole("button", { name: "Save program" }).click();
  await expect(page.getByRole("heading", { name: "Meals" })).toBeVisible({ timeout: 60_000 });

  // The plan is built as if the flight and hotel existed, and both cost rows
  // are marked "Not booked".
  await page.goto(`/trips/${tripId}/itinerary`);
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("itinerary-status")).toHaveText("Draft", { timeout: 10_000 });
  }).toPass({ timeout: 180_000, intervals: [2_000, 3_000, 5_000] });
  await expect(page.getByTestId("not-booked-flights")).toBeVisible();
  await expect(page.getByTestId("not-booked-hotel")).toBeVisible();

  // The summary surfaces both as Not booked and offers a late booking; the
  // booking still goes through the ordinary review and confirmation dialog.
  await page.goto(`/trips/${tripId}/summary`);
  await expect(page.getByTestId("not-booked-section")).toBeVisible();
  await page.getByTestId("book-flights").click();
  await expect(page).toHaveURL(/\/trips\/[0-9a-f-]+\/flights$/, { timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Review booking" })).toBeVisible({
    timeout: 90_000,
  });
  await page.getByRole("button", { name: "Review booking" }).click();
  await confirmDialog(page, "DEMO-FLT-");
  await expect(page.getByTestId("flight-not-booked")).toHaveCount(0);
});

test("changes a settled hotel and meal from their steps", async ({ page }) => {
  // The spec already creates five trips; the per-IP trip-creation bucket (5/h)
  // would refuse this one without a fresh window.
  await resetRateLimits();
  const tripId = await createTrip(page);
  expect(tripId).not.toBe("");

  // Decline both bookings: the hotel is a kept selection and the meals are a
  // saved program — the state in which the change actions are needed.
  await page.getByRole("button", { name: "Choose this flight" }).first().click();
  await expect(page.getByTestId("decline-flight-booking")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("decline-flight-booking").click();
  await expect(page.getByTestId("flight-not-booked")).toBeVisible({ timeout: 90_000 });
  await page.getByRole("link", { name: "Continue to hotel selection" }).click();
  await expect(page.getByTestId("hotel-offer").first()).toBeVisible({ timeout: 90_000 });
  await page
    .getByTestId("hotel-offer")
    .first()
    .getByRole("button", { name: "Choose this hotel" })
    .click();
  await expect(page.getByTestId("decline-hotel-booking")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("decline-hotel-booking").click();
  await expect(page.getByTestId("hotel-not-booked")).toBeVisible({ timeout: 90_000 });

  // Saving the program starts the planning; the approval is pending exactly
  // when the user re-visits the steps.
  await page.getByRole("link", { name: "Continue to meals" }).click();
  await expect(page.getByRole("heading", { name: "Plan your day" })).toBeVisible({
    timeout: 90_000,
  });
  await page.getByRole("button", { name: "Save program" }).click();
  await expect(page.getByRole("heading", { name: "Meals" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("step-nav-itinerary")).toContainText("next", {
    timeout: 120_000,
  });

  // "Change hotel" stays editable while the itinerary approval is pending: it
  // re-opens the hotel choice, and choosing another offer goes through the
  // ordinary review. Declining it keeps the NEW hotel and replans the day.
  await page.goto(`/trips/${tripId}/hotel`);
  await expect(page.getByTestId("hotel-change-note")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("change-hotel").click();
  const otherHotel = page.getByTestId("hotel-offer").nth(1);
  await expect(otherHotel).toBeVisible({ timeout: 90_000 });
  const otherHotelName = (await otherHotel.getByRole("heading", { level: 3 }).textContent()) ?? "";
  await otherHotel.getByRole("button", { name: "Choose this hotel" }).click();
  await expect(page.getByTestId("decline-hotel-booking")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("decline-hotel-booking").click();
  await expect(page.getByTestId("hotel-not-booked")).toBeVisible({ timeout: 90_000 });
  await expect(
    page.getByTestId("selected-hotel-offer").getByRole("heading", { level: 3 }),
  ).toHaveText(otherHotelName);
  // The declined change replans the day: the itinerary gets a fresh draft that
  // asks for approval again.
  await page.goto(`/trips/${tripId}/itinerary`);
  await expect(page.getByTestId("itinerary-version")).toContainText("Version 2", {
    timeout: 180_000,
  });
  await expect(page.getByTestId("itinerary-status")).toHaveText("Draft");

  // A per-meal "Change" stays available while the approval is pending too: it
  // replaces the decision with the program choices, and the new selection
  // replans the day.
  await page.goto(`/trips/${tripId}/meals`);
  await expect(page.getByTestId("meals-change-note")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("change-lunch").click();
  await expect(page.getByRole("heading", { name: "Plan your day" })).toBeVisible({
    timeout: 90_000,
  });
  const otherLunch = page
    .getByTestId("meal-offer-lunch")
    .filter({ has: page.getByRole("button", { name: "Choose this lunch" }) })
    .first();
  await expect(otherLunch).toBeVisible();
  const otherLunchName = (await otherLunch.getByRole("heading", { level: 3 }).textContent()) ?? "";
  await otherLunch.getByRole("button", { name: "Choose this lunch" }).click();
  await page.getByRole("button", { name: "Save program" }).click();
  await expect(page.getByRole("heading", { name: "Meals" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("list", { name: "Saved meal choices" })).toContainText(otherLunchName);
});

test("an early return offers no dinner selection, only a clear warning", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Your name").fill("Grace Hopper");
  await selectCombobox(page, "Origin airport", "PRG");
  await page.getByLabel("Sightseeing date").fill("2026-10-31");
  await page.getByRole("button", { name: "Continue to destination" }).click();
  await selectCombobox(page, "Country", "Finland");
  // "Helsinki" also matches the district "East Helsinki": pick the city itself.
  await page.getByRole("combobox", { name: "City" }).fill("Helsinki");
  await page.getByRole("option", { name: "Helsinki", exact: true }).click();
  await page.getByRole("button", { name: "Create trip" }).click();
  await expect(page).toHaveURL(/\/trips\/[0-9a-f-]+\/flights$/, { timeout: 60_000 });
  await page.getByRole("button", { name: "Choose this flight" }).first().click();
  await page.getByRole("button", { name: "Review booking" }).click();
  await confirmDialog(page, "DEMO-FLT-");
  await page.getByRole("link", { name: "Continue to hotel selection" }).click();
  const firstHotel = page.getByTestId("hotel-offer").first();
  await expect(firstHotel).toBeVisible({ timeout: 90_000 });
  await firstHotel.getByRole("button", { name: "Choose this hotel" }).click();
  await page.getByRole("button", { name: "Review booking" }).click();
  await confirmDialog(page, "DEMO-HTL-");
  await page.getByRole("link", { name: "Continue to meals" }).click();

  // The return flight leaves at 21:00 local: dinner cannot fit, so it is neither
  // offered nor selectable — only the prominent reason is shown.
  await expect(page.getByRole("heading", { name: "Plan your day" })).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByTestId("meal-offer-breakfast").first()).toBeVisible();
  await expect(page.getByTestId("meal-offer-lunch").first()).toBeVisible();
  await expect(page.getByTestId("meal-offer-dinner")).toHaveCount(0);
  await expect(page.getByTestId("level-select-dinner")).toHaveCount(0);
  await expect(page.getByTestId("dinner-not-included")).toContainText(
    "too early to finish dinner",
  );

  // Saving without dinner works, and the saved state repeats the warning.
  await page.getByRole("button", { name: "Save program" }).click();
  await expect(page.getByRole("heading", { name: "Meals" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("dinner-not-included")).toContainText(
    "too early to finish dinner",
  );
  await expect(page.getByRole("button", { name: "Reserve dinner" })).toHaveCount(0);
});
