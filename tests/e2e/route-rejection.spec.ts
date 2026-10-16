import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { startWorker, stopWorker, resetRateLimits } from "./_worker.js";

/**
 * AC-06-3: PRG -> Ceske Budejovice is INFEASIBLE (ground travel preferred).
 * The UI shows the reason and alternatives and offers no flight cards.
 */

const ORIGIN = process.env.PUBLIC_BASE_URL ?? "http://127.0.0.1:3000";
const ORIGIN_AIRPORT = "ourairports:4408"; // PRG
const DESTINATION_CITY = "geonames:3077916"; // Ceske Budejovice
const DESTINATION_COUNTRY = "CZ";

let worker: ChildProcess | undefined;

test.beforeAll(async () => {
  await resetRateLimits();
  worker = startWorker();
});

test.afterAll(async () => {
  await stopWorker(worker);
});

test("shows the route reason and no offers for the rejected ground route", async ({ page }) => {
  const sessionRes = await page.request.post("/api/session", { headers: { origin: ORIGIN } });
  expect([200, 201]).toContain(sessionRes.status());
  const session = (await sessionRes.json()) as { csrfToken: string };

  const created = await page.request.post("/api/trips", {
    headers: { origin: ORIGIN, "x-csrf-token": session.csrfToken },
    data: {
      creationRequestId: randomUUID(),
      userName: "E2E Traveller",
      adults: 1,
      originAirportId: ORIGIN_AIRPORT,
      destinationCityId: DESTINATION_CITY,
      destinationCountryKey: DESTINATION_COUNTRY,
      sightseeingDate: "2026-12-01",
      travelVariant: "one_night",
    },
  });
  expect(created.status()).toBe(201);
  const trip = (await created.json()) as { tripId: string };

  await page.goto(`/trips/${trip.tripId}/flights`);

  await expect(page.getByRole("heading", { name: "No feasible flight for this route" })).toBeVisible(
    { timeout: 60_000 },
  );
  await expect(page.getByText("GROUND_TRAVEL_PREFERRED").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose this flight" })).toHaveCount(0);
});
