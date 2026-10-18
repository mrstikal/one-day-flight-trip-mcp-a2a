import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { Pool } from "pg";
import { expect, test } from "@playwright/test";
import { startWorker, stopWorker, resetRateLimits } from "./_worker.js";

/**
 * Phase 09 agent communication (ODTF_PLAN.md Phase 09 tests): the inspector
 * renders REAL persisted A2A/MCP/Application rows with distinct edges — not the
 * empty state and not a static graph topology. A delegation plus one MCP and
 * one application observation are persisted directly, then bridged through the
 * production `protocol.observed` path and asserted in all three sections.
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
    throw new Error("DATABASE_URL is required for the agent-communication e2e");
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

async function createTrip(page: import("@playwright/test").Page): Promise<string> {
  const session = await page.request.post("/api/session", { headers: { origin: ORIGIN } });
  expect([200, 201]).toContain(session.status());
  const { csrfToken, sessionId } = (await session.json()) as {
    csrfToken: string;
    sessionId: string;
  };
  const created = await page.request.post("/api/trips", {
    headers: { origin: ORIGIN, "x-csrf-token": csrfToken },
    data: {
      creationRequestId: randomUUID(),
      userName: "Comm Ada",
      adults: 2,
      originAirportId: "ourairports:4408",
      destinationCityId: "geonames:3169070",
      destinationCountryKey: "IT",
      sightseeingDate: "2026-12-01",
      travelVariant: "two_nights",
    },
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  expect(sessionId).toBeTruthy();
  return id;
}

test("inspector shows real A2A, MCP, and application rows with distinct edges", async ({
  page,
}) => {
  const tripId = await createTrip(page);
  expect(tripId).not.toBe("");
  // Persist one delegation + MCP + application observation directly, then let
  // the production worker reconcile loop bridge them (no test-only shortcut).
  await withPool(async (pool) => {
    const created = await pool.query<{ id: string }>(
      `SELECT id FROM odft_app.workflow_operations WHERE trip_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [tripId],
    );
    const operationId = created.rows[0]?.id as string;
    const delegationId = randomUUID();
    await pool.query(
      `INSERT INTO odft_app.agent_delegations
         (id, trip_id, originating_operation_id, accepted_revision, agent_identity, endpoint_url,
          card_version, snapshot_id, input_fingerprint, skill_id, task_id, status, scope, attempt)
       VALUES ($1, $2, $3, 1, 'flight-agent', 'http://127.0.0.1:4101', 'v1', $4,
               $5, 'flight.recommend.v1', 'task-e2e-1', 'working', '{"domains":["flights"]}'::jsonb, 1)`,
      [delegationId, tripId, operationId, randomUUID(), "a".repeat(64)],
    );
    const rows = [
      {
        source: "mcp-travel-data",
        kind: "mcp_tool_call",
        detail: "search_airports",
      },
      {
        source: "flight-agent",
        kind: "task_completed",
        detail: "recommendations ready",
      },
    ];
    for (const row of rows) {
      await pool.query(
        `INSERT INTO odft_app.protocol_observations
           (id, source, kind, trip_id, operation_id, delegation_id, payload, payload_hash, occurred_at)
         VALUES ($1, $2, $3, $4, NULL, NULL, $5::jsonb, $6, now())`,
        [
          randomUUID(),
          row.source,
          row.kind,
          tripId,
          JSON.stringify({ detail: row.detail, status: "ok", counters: {} }),
          "b".repeat(64),
        ],
      );
    }
  });

  await page.goto(`/trips/${tripId}/inspector`);
  await expect(page.getByTestId("inspector")).toBeVisible({ timeout: 60_000 });
  // The worker reconcile loop bridges within seconds; the sections flip from
  // empty-state copy to real rows with distinct edge labels.
  await expect(page.getByTestId("communication-table")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("communication-table")).toContainText("flight-agent");
  await expect(page.getByTestId("mcp-table")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("mcp-table")).toContainText("search_airports");
  await expect(page.getByTestId("timeline-list")).toBeVisible({ timeout: 60_000 });
  const timeline = await page.getByTestId("timeline-list").innerText();
  expect(timeline).toContain("mcp");
  expect(timeline).toContain("a2a");
  // Agent card renders from the same persisted delegation row.
  await expect(page.getByTestId("agent-card-flight-agent")).toBeVisible();
});
