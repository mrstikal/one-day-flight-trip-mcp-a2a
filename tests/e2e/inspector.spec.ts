import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { Pool } from "pg";
import { expect, test } from "@playwright/test";
import { startWorker, stopWorker, resetRateLimits } from "./_worker.js";

/**
 * Phase 11 execution inspector (08-frontend-ux.md section 10):
 * - the graph renders from the persisted `graph.initialized` definition with the
 *   real node statuses, operations, checkpoints, and LLM cost rows;
 * - prompts and unknown payload fields are never stored, so they cannot be
 *   rendered even when a row is inserted directly;
 * - faults are labeled `Simulated failure`;
 * - the scenario controls are owner/flag protected and submit real commands.
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

async function withPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the inspector e2e");
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

async function createTripViaApi(page: import("@playwright/test").Page): Promise<string> {
  const session = await page.request.post("/api/session", { headers: { origin: ORIGIN } });
  expect([200, 201]).toContain(session.status());
  const { csrfToken } = (await session.json()) as { csrfToken: string };
  const created = await page.request.post("/api/trips", {
    headers: { origin: ORIGIN, "x-csrf-token": csrfToken },
    data: {
      creationRequestId: randomUUID(),
      userName: "Inspector Ada",
      adults: 2,
      originAirportId: "ourairports:4408",
      destinationCityId: "geonames:3169070",
      destinationCountryKey: "IT",
      sightseeingDate: "2026-12-01",
      travelVariant: "two_nights",
    },
  });
  expect(created.status()).toBe(201);
  return ((await created.json()) as { tripId: string }).tripId;
}

test("renders the real graph, nodes, operations, checkpoints, and LLM rows", async ({ page }) => {
  const tripId = await createTripViaApi(page);
  await page.goto(`/trips/${tripId}/flights`);
  await expect(page.getByRole("button", { name: "Choose this flight" }).first()).toBeVisible({
    timeout: 90_000,
  });

  await page.goto(`/trips/${tripId}/inspector`);
  await expect(page.getByTestId("inspector")).toBeVisible({ timeout: 30_000 });
  // "Back to the trip" tracks the trip's current step (no flight confirmed yet).
  await expect(page.getByRole("link", { name: "Back to the trip" })).toHaveAttribute(
    "href",
    `/trips/${tripId}/flights`,
  );
  // The graph is the persisted definition from the worker registry.
  await expect(page.getByTestId("execution-graph")).toBeVisible();
  const nodeTable = page.getByTestId("node-table");
  await expect(nodeTable).toContainText("load_context");
  await expect(nodeTable).toContainText("apply_commands");
  await expect(nodeTable).toContainText("await_decision");
  // Real operation/checkpoint telemetry, never a client-side graph call.
  await expect(page.getByTestId("operation-table")).toContainText("creation");
  await expect(page.getByTestId("checkpoint-table")).toContainText("flight_choice");
  await expect(page.getByTestId("event-list")).toContainText("node.updated");
  await expect(page.getByTestId("llm-table")).toBeVisible();
});

test("never reveals prompts or unknown payload fields", async ({ page }) => {
  const tripId = await createTripViaApi(page);
  const secret = `SECRET-PROMPT-${randomUUID()}`;
  await withPool(async (pool) => {
    // A direct insert bypasses the write-time allowlist: the reader must still
    // only render allowlisted fields and reviewed summaries.
    await pool.query(
      `INSERT INTO odft_app.execution_events (trip_id, operation_id, type, payload)
       VALUES ($1, NULL, 'research.domain_finished', $2::jsonb),
              ($1, NULL, 'unknown.future.type', $3::jsonb)`,
      [
        tripId,
        JSON.stringify({
          domain: "hotel",
          status: "ok",
          prompt: secret,
          chainOfThought: secret,
          rawProviderPayload: { secret },
        }),
        JSON.stringify({ prompt: secret, anything: secret }),
      ],
    );
  });

  await page.goto(`/trips/${tripId}/inspector`);
  await expect(page.getByTestId("inspector")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("event-list")).toContainText("research hotel ok");
  const body = await page.locator("body").innerText();
  expect(body).not.toContain(secret);
  expect(body).not.toContain("chainOfThought");
  expect(body).not.toContain("rawProviderPayload");
});

test("labels faults and submits owner-protected scenario controls", async ({ page }) => {
  const tripId = await createTripViaApi(page);
  await page.goto(`/trips/${tripId}/inspector`);
  await expect(page.getByTestId("inspector")).toBeVisible({ timeout: 30_000 });
  // Wait until the creation run settled at its first decision: a command admitted
  // while another operation is queued/running is rejected with 409 by contract.
  await expect(page.getByTestId("checkpoint-table")).toContainText("flight_choice", {
    timeout: 120_000,
  });
  await expect(page.getByTestId("no-faults")).toBeVisible();
  await expect(page.getByTestId("scenario-mode")).toHaveText("normal");

  const controls = page.getByTestId("simulation-controls");
  await expect(controls).toBeVisible();
  // The control submits a real `set_simulation` command; the worker arms the
  // overlay and the fault panel labels it exactly `Simulated failure`.
  await controls.getByRole("button", { name: "Invalid itinerary (first attempt)" }).click();

  // The overlay is armed by the worker and persisted; the API projection proves
  // the labeled fault row exists before the UI refresh is asserted.
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/trips/${tripId}`, {
          headers: { origin: ORIGIN },
        });
        const projection = (await response.json()) as {
          inspector: { faults: { label: string; mode: string }[]; scenarioMode: string } | null;
        };
        return projection.inspector?.faults.map((fault) => `${fault.label}:${fault.mode}`).join(",") ?? "";
      },
      { timeout: 120_000, intervals: [2_000, 3_000, 5_000] },
    )
    .toContain("Simulated failure:invalid_itinerary");
  await expect(page.getByTestId("fault-list")).toContainText("Simulated failure", {
    timeout: 120_000,
  });
  await expect(page.getByTestId("scenario-mode")).not.toHaveText("normal");
  await expect(page.getByTestId("fault-list")).toContainText("invalid_itinerary");
});
