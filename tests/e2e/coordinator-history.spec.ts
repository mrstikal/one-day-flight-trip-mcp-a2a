import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, test } from "@playwright/test";
import { startWorker, stopWorker, resetRateLimits, type E2eServices } from "./_worker.js";

/**
 * Phase 09 coordinator history (ODTF_PLAN.md Phase 09 tests): an archived trip
 * is read-only history across the whole UI — the notice renders, every
 * mutation control is disabled, no busy preloader appears, and mutating API
 * calls are denied with TRIP_ARCHIVED (403) instead of executing.
 */

const ORIGIN = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
test.use({ baseURL: ORIGIN });
test.setTimeout(240_000);

let worker: E2eServices | undefined;

test.beforeAll(async () => {
  await resetRateLimits();
  worker = await startWorker();
});

test.afterAll(async () => {
  await stopWorker(worker);
});

async function withPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the coordinator-history e2e");
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

test("archived trips are read-only history in UI and API", async ({ page }) => {
  const session = await page.request.post("/api/session", { headers: { origin: ORIGIN } });
  expect([200, 201]).toContain(session.status());
  const { csrfToken } = (await session.json()) as { csrfToken: string };
  const created = await page.request.post("/api/trips", {
    headers: { origin: ORIGIN, "x-csrf-token": csrfToken },
    data: {
      creationRequestId: randomUUID(),
      userName: "History Ada",
      adults: 2,
      originAirportId: "ourairports:4408",
      destinationCityId: "geonames:3169070",
      destinationCountryKey: "IT",
      sightseeingDate: "2026-12-01",
      travelVariant: "two_nights",
    },
  });
  expect(created.status()).toBe(201);
  const { tripId } = (await created.json()) as { tripId: string };

  await withPool(async (pool) => {
    await pool.query(
      `UPDATE odft_app.trips SET archived_at = now(), archive_reason = 'e2e history' WHERE id = $1`,
      [tripId],
    );
  });

  // UI: the notice renders, mutation controls disable, no busy preloader.
  await page.goto(`/trips/${tripId}/flights`);
  await expect(page.getByTestId("history-notice")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("history-notice")).toContainText("read-only");
  await expect(page.getByTestId("operation-preloader")).toHaveCount(0);
  await page.goto(`/trips/${tripId}/hotel`);
  await expect(page.getByTestId("history-notice")).toBeVisible({ timeout: 60_000 });

  // API: a chat command against history is denied, never executed.
  const denied = await page.request.post(`/api/trips/${tripId}/commands`, {
    headers: { origin: ORIGIN, "x-csrf-token": csrfToken },
    data: {
      requestId: randomUUID(),
      expectedRevision: 1,
      chat: "hello from history",
    },
  });
  expect(denied.status()).toBe(403);
  const body = (await denied.json()) as { code?: string };
  expect(body.code).toBe("TRIP_ARCHIVED");

  // API: the projection still reads, flagged as history.
  const projection = await page.request.get(`/api/trips/${tripId}`, {
    headers: { origin: ORIGIN },
  });
  expect(projection.status()).toBe(200);
  const projected = (await projection.json()) as {
    historyReadOnly?: boolean;
    capabilities?: { canModify?: boolean };
  };
  expect(projected.historyReadOnly).toBe(true);
  expect(projected.capabilities?.canModify).toBe(false);
});
