import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, test } from "@playwright/test";
import { resetRateLimits } from "./_worker.js";
import {
  databaseUrlOrThrow,
  pendingDecision,
  seedCoordinatorTrip,
  startE2eServices,
  waitForDb,
  type E2eServices,
} from "./_services.js";

/**
 * Phase 10 protocol failures (ODTF_PLAN.md Phase 10 e2e): a real City Guide
 * process crashes AFTER durable admission; the coordinator keeps the completed
 * hotel, the restarted agent reconciles the orphaned task to AGENT_RESTARTED,
 * and the browser shows the hotel choice plus the failure evidence in the
 * inspector.
 */

const ORIGIN = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
test.use({ baseURL: ORIGIN });
test.setTimeout(300_000);

let services: E2eServices;
let pool: Pool;

test.beforeAll(async () => {
  await resetRateLimits();
  services = await startE2eServices({ crashingCityGuide: true });
  pool = new Pool({ connectionString: databaseUrlOrThrow(), max: 2 });
});

test.afterAll(async () => {
  await pool.end();
  await services.stop();
});

test("a crashed City Guide keeps the hotel choice and records AGENT_RESTARTED", async ({
  page,
}) => {
  const request = page.request;
  const session = await request.post("/api/session", { headers: { origin: ORIGIN } });
  expect([200, 201]).toContain(session.status());
  const { sessionId, csrfToken } = (await session.json()) as {
    sessionId: string;
    csrfToken: string;
  };
  const { tripId } = await seedCoordinatorTrip(pool, sessionId);

  const flightChoice = await waitForDb(
    () => pendingDecision(pool, tripId),
    90_000,
    "the flight choice",
  );
  expect(flightChoice.kind).toBe("flight_choice");
  const choose = await request.post(`/api/trips/${tripId}/resume`, {
    headers: { origin: ORIGIN, "x-csrf-token": csrfToken },
    data: {
      requestId: randomUUID(),
      decisionId: flightChoice.id,
      expectedRevision: 1,
      response: { action: "choose_offer", offerId: flightChoice.allowedOfferIds[0] },
    },
  });
  expect(choose.status()).toBe(202);

  const booking = await waitForDb(
    async () => {
      const decision = await pendingDecision(pool, tripId);
      return decision?.kind === "booking_confirmation" ? decision : undefined;
    },
    90_000,
    "the booking confirmation",
  );
  const confirm = await request.post(`/api/trips/${tripId}/resume`, {
    headers: { origin: ORIGIN, "x-csrf-token": csrfToken },
    data: {
      requestId: randomUUID(),
      decisionId: booking.id,
      expectedRevision: 1,
      response: {
        action: "confirm_booking",
        proposalId: booking.proposalId,
        acceptedDemoDisclaimer: true,
      },
    },
  });
  expect(confirm.status()).toBe(202);

  // The crash process admitted the City Guide task and exited; restarting the
  // same identity reconciles the orphan to AGENT_RESTARTED. The coordinator
  // re-delivers the SAME message id and binds the canonical failed task.
  await services.waitForCityGuideExit();
  await services.restartCityGuideHealthy();

  const hotelChoice = await waitForDb(
    async () => {
      const decision = await pendingDecision(pool, tripId);
      return decision?.kind === "hotel_choice" ? decision : undefined;
    },
    120_000,
    "the hotel choice after the City Guide failure",
  );
  expect(hotelChoice.allowedOfferIds.length).toBeGreaterThan(0);

  // The browser can still choose a hotel: the completed hotel was not discarded.
  await page.goto(`/trips/${tripId}/hotel`);
  await expect(page.getByRole("heading", { name: "Choose your hotel" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("hotel-offer").first()).toBeVisible({ timeout: 60_000 });

  // The inspector shows the safe restart category, not a provider stack.
  await page.goto(`/trips/${tripId}/inspector`);
  await expect(page.getByTestId("inspector")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("event-list")).toContainText("AGENT_RESTARTED", {
    timeout: 60_000,
  });
});
