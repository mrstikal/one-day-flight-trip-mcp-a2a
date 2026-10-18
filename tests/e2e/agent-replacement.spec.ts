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
 * Phase 10 compatible agent replacement (ODTF_PLAN.md Phase 10 e2e): the SAME
 * coordinator worker runs with Accommodation Agent B after the trusted registry
 * switches the accommodation skill binding. The inspector shows B's identity
 * and never A's for the new trip.
 */

const ORIGIN = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
test.use({ baseURL: ORIGIN });
test.setTimeout(300_000);

let services: E2eServices;
let pool: Pool;

test.beforeAll(async () => {
  await resetRateLimits();
  services = await startE2eServices({ registry: "replacement" });
  pool = new Pool({ connectionString: databaseUrlOrThrow(), max: 2 });
});

test.afterAll(async () => {
  await pool.end();
  await services.stop();
});

test("a new trip uses Accommodation Agent B without coordinator changes", async ({ page }) => {
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

  const hotelChoice = await waitForDb(
    async () => {
      const decision = await pendingDecision(pool, tripId);
      return decision?.kind === "hotel_choice" ? decision : undefined;
    },
    120_000,
    "the hotel choice from Agent B",
  );
  expect(hotelChoice.allowedOfferIds.length).toBeGreaterThan(0);

  const delegation = await pool.query<{ agent_identity: string; endpoint_url: string }>(
    `SELECT agent_identity, endpoint_url FROM odft_app.agent_delegations
      WHERE trip_id = $1 AND skill_id = 'accommodation.recommend.v1'
      ORDER BY created_at DESC LIMIT 1`,
    [tripId],
  );
  expect(delegation.rows[0]).toMatchObject({
    agent_identity: "accommodation-agent-alt",
    endpoint_url: "http://127.0.0.1:4434",
  });

  await page.goto(`/trips/${tripId}/inspector`);
  await expect(page.getByTestId("inspector")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("agent-card-accommodation-agent-alt")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("agent-card-accommodation-agent")).toHaveCount(0);

  await page.goto(`/trips/${tripId}/hotel`);
  await expect(page.getByRole("heading", { name: "Choose your hotel" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("hotel-offer").first()).toBeVisible({ timeout: 60_000 });
});
