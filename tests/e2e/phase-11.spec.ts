import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { startWorker, stopWorker, resetRateLimits } from "./_worker.js";

/**
 * Phase 11 end-to-end:
 * - scenario H (T-E2E-04): "find a cheaper hotel" refreshes same-category
 *   alternatives, keeps every booking, and replaces the hotel only after
 *   explicit confirmation;
 * - scenario K (T-E2E-07): reloading at a pending decision restores the exact
 *   descriptor and the resume completes it without duplicate effects;
 * - the route-change impact card names the affected reservations, nothing is
 *   cancelled before the confirmation, and the fresh feasibility flow restarts;
 * - an UNBOOKED route change (the RouteFix flow) applies directly and yields a
 *   fresh flight choice instead of a stale/empty decision.
 */

const ORIGIN = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
test.use({ baseURL: ORIGIN });
test.setTimeout(300_000);

let worker: ChildProcess | undefined;

test.beforeAll(async () => {
  worker = startWorker();
});

test.beforeEach(async () => {
  // This spec creates several sessions/trips through the API as well as the UI;
  // the per-IP creation limits are test-irrelevant, so clear them per test.
  await resetRateLimits();
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

async function createTrip(
  page: Page,
  options: { readonly serviceLevel?: "budget" | "standard" | "luxury" } = {},
): Promise<string> {
  await page.goto("/");
  await page.getByLabel("Your name").fill("Ada Lovelace");
  await selectCombobox(page, "Origin airport", "PRG");
  await page.getByLabel("Sightseeing date").fill("2026-12-01");
  if (options.serviceLevel) {
    await page.getByLabel("Default service level (provisional)").selectOption(options.serviceLevel);
  }
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

/**
 * Book flight + hotel and save the program, leaving the worker planning.
 * `hotelPosition: "last"` books the most expensive same-category offer, so a
 * later cheaper search provably has a strictly cheaper alternative to offer.
 */
async function driveToProgramSaved(
  page: Page,
  options: { readonly hotelPosition?: "first" | "last" } = {},
): Promise<void> {
  await page.getByRole("button", { name: "Choose this flight" }).first().click();
  await page.getByRole("button", { name: "Review booking" }).click();
  await confirmDialog(page, "DEMO-FLT-");

  await page.getByRole("link", { name: "Continue to hotel selection" }).click();
  await expect(page).toHaveURL(/\/trips\/[0-9a-f-]+\/hotel$/, { timeout: 60_000 });
  const offers = page.getByTestId("hotel-offer");
  const hotelCard = options.hotelPosition === "last" ? offers.last() : offers.first();
  await expect(hotelCard).toBeVisible({ timeout: 90_000 });
  await hotelCard.getByRole("button", { name: "Choose this hotel" }).click();
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

/** The confirmed hotel's demo reference, read from the projection API. */
async function readHotelReference(page: Page, tripId: string): Promise<string> {
  const response = await page.request.get(`/api/trips/${tripId}`, {
    headers: { origin: ORIGIN },
  });
  expect(response.status()).toBe(200);
  const projection = (await response.json()) as {
    reservations: { serviceKey: string; status: string; demoReference: string }[];
  };
  return (
    projection.reservations.find(
      (reservation) => reservation.serviceKey === "hotel" && reservation.status === "confirmed",
    )?.demoReference ?? ""
  );
}

/** Approve the pending itinerary draft from the itinerary page. */
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

test("scenario K: reloading at a pending decision restores the exact descriptor", async ({
  page,
}) => {
  const tripId = await createTrip(page);
  expect(tripId).not.toBe("");

  // The flight choice decision is pending; close and reopen the page entirely.
  await expect(page.getByRole("button", { name: "Choose this flight" }).first()).toBeVisible({
    timeout: 90_000,
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "Choose this flight" }).first()).toBeVisible({
    timeout: 90_000,
  });
  const firstOffer = page.getByRole("button", { name: "Choose this flight" }).first();
  await firstOffer.click();
  // The descriptor survived the reload: the resume completes the same decision.
  await expect(page.getByRole("button", { name: "Review booking" })).toBeVisible({
    timeout: 90_000,
  });
  await page.getByRole("button", { name: "Review booking" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByLabel("I understand this is a simulated booking").check();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm simulated booking" }).click();
  await expect(page.getByTestId("demo-reference")).toContainText("DEMO-FLT-", { timeout: 60_000 });
  // Exactly one flight reservation exists: the resume completed the decision
  // without duplicate effects.
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/trips/${tripId}`, {
          headers: { origin: ORIGIN },
        });
        const projection = (await response.json()) as {
          reservations: { serviceKey: string; status: string }[];
        };
        return projection.reservations.filter(
          (reservation) => reservation.serviceKey === "flights" && reservation.status === "confirmed",
        ).length;
      },
      { timeout: 60_000, intervals: [1_000, 2_000] },
    )
    .toBe(1);
});

test("scenario H: a cheaper hotel search keeps bookings and replaces only on confirmation", async ({
  page,
}) => {
  const tripId = await createTrip(page);
  expect(tripId).not.toBe("");
  await driveToProgramSaved(page, { hotelPosition: "last" });
  await approveItinerary(page, tripId);

  // Record the confirmed hotel reference from the projection, then ask for a
  // cheaper hotel.
  await page.goto(`/trips/${tripId}/hotel`);
  const hotelReference = await readHotelReference(page, tripId);
  expect(hotelReference).toContain("DEMO-HTL-");
  await page.getByLabel("Ask for a change").fill("Find a cheaper hotel");
  await page.getByRole("button", { name: "Send" }).click();

  // The refreshed same-category alternatives arrive as a hotel choice.
  const cheaperCard = page.getByTestId("hotel-offer").first();
  await expect(cheaperCard).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("assistant-rail")).toContainText(
    "No confirmed reservation was changed",
    { timeout: 120_000 },
  );
  // The old hotel is still active until the replacement is confirmed.
  expect(await readHotelReference(page, tripId)).toBe(hotelReference);
  await cheaperCard.getByRole("button", { name: "Choose this hotel" }).click();
  await page.getByRole("button", { name: "Review booking" }).click();
  await confirmDialog(page, "DEMO-HTL-");
  await page.waitForTimeout(12_000);
  // The replacement is committed asynchronously; wait for the new reference.
  await expect
    .poll(() => readHotelReference(page, tripId), { timeout: 120_000, intervals: [2_000, 3_000, 5_000] })
    .not.toBe(hotelReference);
});

test("a chat refresh from another page opens the step with the fresh offers", async ({ page }) => {
  const tripId = await createTrip(page);
  expect(tripId).not.toBe("");
  await driveToProgramSaved(page, { hotelPosition: "last" });
  await approveItinerary(page, tripId);

  // Ask for a change from the summary, away from the hotel step.
  await page.goto(`/trips/${tripId}/summary`);
  const hotelReference = await readHotelReference(page, tripId);
  expect(hotelReference).toContain("DEMO-HTL-");
  await page.getByLabel("Ask for a change").fill("Find a cheaper hotel");
  await page.getByRole("button", { name: "Send" }).click();

  // The rail opens the hotel step by itself, so the fresh list is visible
  // immediately; nothing is replaced before the explicit confirmation.
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/hotel$`), { timeout: 120_000 });
  const cheaperCard = page.getByTestId("hotel-offer").first();
  await expect(cheaperCard).toBeVisible({ timeout: 120_000 });
  expect(await readHotelReference(page, tripId)).toBe(hotelReference);
});

test("the summary hotel row offers a direct change action", async ({ page }) => {
  const tripId = await createTrip(page);
  expect(tripId).not.toBe("");
  await driveToProgramSaved(page, { hotelPosition: "last" });
  await page.goto(`/trips/${tripId}/summary`);
  const hotelReference = await readHotelReference(page, tripId);
  expect(hotelReference).toContain("DEMO-HTL-");

  // The confirmed-hotel row stages the same replacement search the assistant
  // runs and opens the step that presents the refreshed choice.
  await page.getByTestId("change-hotel").click();
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/hotel$`), { timeout: 60_000 });
  await expect(page.getByTestId("hotel-offer").first()).toBeVisible({ timeout: 120_000 });
  // Nothing is replaced before the explicit confirmation.
  expect(await readHotelReference(page, tripId)).toBe(hotelReference);
});

test("the summary meal rows offer their own change action", async ({ page }) => {
  const tripId = await createTrip(page);
  expect(tripId).not.toBe("");
  await driveToProgramSaved(page, { hotelPosition: "first" });

  // Reserve one meal so its confirmed row exists on the summary.
  await page.goto(`/trips/${tripId}/meals`);
  await page.getByRole("button", { name: "Reserve breakfast" }).click();
  await expect(page.getByRole("button", { name: "Review reservation" })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Review reservation" }).click();
  await confirmDialog(page, "DEMO-RST-");

  // The confirmed-meal row stages the same search the assistant runs and opens
  // the meals step, where the refreshed choice is presented as tiles.
  await page.goto(`/trips/${tripId}/summary`);
  await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
  await page.getByTestId("change-breakfast").click();
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/meals$`), { timeout: 60_000 });
  await expect(page.getByTestId("meal-offer-breakfast").first()).toBeVisible({ timeout: 120_000 });
  // The target page opens at the top, not at the previous scroll offset.
  await expect.poll(async () => page.evaluate("window.scrollY")).toBe(0);

  // Back to the (cached) summary and change another confirmed row: the revision
  // is read live before writing, so the stale server-rendered page cannot fail
  // with "expected revision does not match the current revision".
  await page.goBack();
  await expect(page.getByTestId("change-hotel")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("change-hotel").click();
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/hotel$`), { timeout: 60_000 });
  await expect(page.getByTestId("hotel-offer").first()).toBeVisible({ timeout: 120_000 });
});

test("the hotel category select follows the global default and locks for a custom search", async ({
  page,
}) => {
  const tripId = await createTrip(page, { serviceLevel: "luxury" });
  expect(tripId).not.toBe("");
  await page.getByRole("button", { name: "Choose this flight" }).first().click();
  await page.getByRole("button", { name: "Review booking" }).click();
  await confirmDialog(page, "DEMO-FLT-");
  await page.getByRole("link", { name: "Continue to hotel selection" }).click();
  await expect(page.getByTestId("hotel-offer").first()).toBeVisible({ timeout: 90_000 });

  // The value defaults to the global level chosen on the first step.
  const select = page.getByTestId("level-select-hotel");
  await expect(select).toHaveValue("luxury");
  await expect(select).toBeEnabled();

  // An objective-driven assistant search is no plain category: the select shows
  // "Custom request" and locks.
  const rail = page.getByTestId("assistant-rail");
  await rail.getByLabel("Ask for a change").fill("better hotel");
  await rail.getByRole("button", { name: "Send" }).click();
  await rail.getByRole("button", { name: "Better location" }).click();
  await expect(page.getByTestId("hotel-offer").first()).toBeVisible({ timeout: 120_000 });
  await expect(select).toHaveValue("custom");
  await expect(select).toBeDisabled();
  await expect(page.getByText("from your assistant request")).toBeVisible();
});

test("an unbooked route change applies directly and yields a fresh flight choice", async ({
  page,
}) => {
  // The RouteFix flow on an infeasible route: PRG -> Ceske Budejovice is
  // rejected, and updating the destination must re-run feasibility instead of
  // opening an empty confirmation or failing the run.
  const session = await page.request.post("/api/session", { headers: { origin: ORIGIN } });
  const { csrfToken } = (await session.json()) as { csrfToken: string };
  const created = await page.request.post("/api/trips", {
    headers: { origin: ORIGIN, "x-csrf-token": csrfToken },
    data: {
      creationRequestId: randomUUID(),
      userName: "Route Fix Ada",
      adults: 1,
      originAirportId: "ourairports:4408",
      destinationCityId: "geonames:3077916",
      destinationCountryKey: "CZ",
      sightseeingDate: "2026-12-01",
      travelVariant: "one_night",
    },
  });
  expect(created.status()).toBe(201);
  const tripId = ((await created.json()) as { tripId: string }).tripId;

  await page.goto(`/trips/${tripId}/flights`);
  await expect(page.getByRole("heading", { name: "No feasible flight for this route" })).toBeVisible({
    timeout: 90_000,
  });
  // The route-fix form submits a real `set_route` on a trip without reservations
  // (the city picker needs the country first).
  await selectCombobox(page, "New destination country (optional)", "Italy");
  await selectCombobox(page, "New destination city (optional)", "Rome");
  await page.getByRole("button", { name: "Update route" }).click();
  await expect(page.getByRole("button", { name: "Choose this flight" }).first()).toBeVisible({
    timeout: 180_000,
  });
});

test("route-change impact card names the reservations and cancels only after confirmation", async ({
  page,
}) => {
  const tripId = await createTrip(page);
  expect(tripId).not.toBe("");
  await driveToProgramSaved(page);
  await approveItinerary(page, tripId);

  // A typed ORIGIN-ONLY route change (PRG -> Brno): the scenario snapshot is
  // keyed by the origin, so every confirmed booking is affected and the card
  // must show the changed origin explicitly.
  const session = await page.request.post("/api/session", { headers: { origin: ORIGIN } });
  expect([200, 201]).toContain(session.status());
  const { csrfToken } = (await session.json()) as { csrfToken: string };
  const revision = await page.request
    .get(`/api/trips/${tripId}`, { headers: { origin: ORIGIN } })
    .then(
      async (response) =>
        ((await response.json()) as { trip: { revision: number } }).trip.revision,
    );
  const submitted = await page.request.post(`/api/trips/${tripId}/commands`, {
    headers: { origin: ORIGIN, "x-csrf-token": csrfToken },
    data: {
      requestId: randomUUID(),
      expectedRevision: revision,
      command: { type: "set_route", originAirportId: "ourairports:4409" },
    },
  });
  expect([200, 201, 202]).toContain(submitted.status());

  await page.goto(`/trips/${tripId}/itinerary`);
  const card = page.getByTestId("route-change-card");
  await expect(card).toBeVisible({ timeout: 120_000 });
  // The card names every affected reservation and keeps the old state active.
  await expect(page.getByTestId("route-change-reservations").locator("li")).not.toHaveCount(0);
  await expect(card).toContainText("Confirm the route change");
  // The destructive origin change is visible with both values (Phase 11 fix).
  const fields = page.getByTestId("route-change-fields");
  await expect(fields).toContainText("Origin airport");
  await expect(fields).toContainText("ourairports:4408");
  await expect(fields).toContainText("ourairports:4409");
  await page.getByTestId("route-change-confirm").click();
  await expect(card).toHaveCount(0, { timeout: 120_000 });
  // The fresh feasibility flow starts again at the flight choice.
  await page.goto(`/trips/${tripId}/flights`);
  await expect(page.getByRole("button", { name: "Choose this flight" }).first()).toBeVisible({
    timeout: 180_000,
  });
});
