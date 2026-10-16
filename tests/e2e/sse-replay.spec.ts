import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { startWorker, stopWorker, resetRateLimits } from "./_worker.js";

/**
 * T-E2E-10 (Phase 11): the durable SSE stream is resumable by decimal cursor —
 * a reconnect with `after`/`Last-Event-ID` replays only what the client missed,
 * never a duplicate of an already applied event, and the stream carries safe
 * payloads only (no prompts, no raw provider data).
 */

const ORIGIN = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
test.use({ baseURL: ORIGIN });
test.setTimeout(180_000);

let worker: ChildProcess | undefined;

test.beforeAll(async () => {
  await resetRateLimits();
  worker = startWorker();
});

test.afterAll(async () => {
  await stopWorker(worker);
});

async function createTripViaApi(page: Page): Promise<{ tripId: string; csrfToken: string }> {
  const session = await page.request.post("/api/session", { headers: { origin: ORIGIN } });
  expect([200, 201]).toContain(session.status());
  const { csrfToken } = (await session.json()) as { csrfToken: string };
  const created = await page.request.post("/api/trips", {
    headers: { origin: ORIGIN, "x-csrf-token": csrfToken },
    data: {
      creationRequestId: randomUUID(),
      userName: "SSE Ada",
      adults: 2,
      originAirportId: "ourairports:4408",
      destinationCityId: "geonames:3169070",
      destinationCountryKey: "IT",
      sightseeingDate: "2026-12-01",
      travelVariant: "two_nights",
    },
  });
  expect(created.status()).toBe(201);
  return { tripId: ((await created.json()) as { tripId: string }).tripId, csrfToken };
}

interface StreamRead {
  readonly ids: number[];
  readonly types: string[];
  readonly payloads: string[];
  readonly sawRetry: boolean;
  readonly sawHeartbeat: boolean;
}

/** Read the event stream for a bounded window and parse ids/types/payloads. */
async function readStream(page: Page, url: string, windowMs = 4000): Promise<StreamRead> {
  return page.evaluate(
    async ({ target, windowMs: ms }) => {

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ms);
      const ids: number[] = [];
      const types: string[] = [];
      const payloads: string[] = [];
      let sawRetry = false;
      let sawHeartbeat = false;
      try {
        const response = await fetch(target, { signal: controller.signal, headers: { accept: "text/event-stream" } });
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const chunk = await reader?.read();
          if (!chunk || chunk.done) {
            break;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            if (block.startsWith("retry:")) {
              sawRetry = true;
            }
            if (block.startsWith(":") || block.includes(": connected")) {
              sawHeartbeat = true;
            }
            const id = /(?:^|\n)id: (\d+)/.exec(block)?.[1];
            const type = /(?:^|\n)event: ([^\n]+)/.exec(block)?.[1];
            const data = /(?:^|\n)data: ([^\n]+)/.exec(block)?.[1];
            if (id !== undefined) {
              ids.push(Number.parseInt(id, 10));
            }
            if (type !== undefined) {
              types.push(type);
            }
            if (data !== undefined) {
              payloads.push(data);
            }
          }
        }
      } catch {
        // The abort ends the bounded read; partial results are the point.
      } finally {
        clearTimeout(timer);
      }
      return { ids, types, payloads, sawRetry, sawHeartbeat };
    },
    { target: url, windowMs },
  );
}

test("replays only events after the cursor and never leaks raw payloads", async ({ page }) => {
  const { tripId, csrfToken } = await createTripViaApi(page);
  // The stream is read from the page context, so it must be same-origin.
  await page.goto(ORIGIN);
  // Wait until the creation run settled at its first decision (a command admitted
  // while another operation runs is rejected with 409 by contract).
  const revision = await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/trips/${tripId}`, {
          headers: { origin: ORIGIN },
        });
        const projection = (await response.json()) as {
          trip: { revision: number };
          pendingDecision: { kind: string } | null;
        };
        return projection.pendingDecision ? projection.trip.revision : null;
      },
      { timeout: 120_000, intervals: [1_000, 2_000, 3_000] },
    )
    .not.toBeNull()
    .then(async () => {
      const response = await page.request.get(`/api/trips/${tripId}`, {
        headers: { origin: ORIGIN },
      });
      return ((await response.json()) as { trip: { revision: number } }).trip.revision;
    });
  // Generate real events: an admitted command plus the worker's run.
  const submitted = await page.request.post(`/api/trips/${tripId}/commands`, {
    headers: { origin: ORIGIN, "x-csrf-token": csrfToken },
    data: { requestId: randomUUID(), expectedRevision: revision, chat: "Make the day less exhausting" },
  });
  expect([200, 201, 202]).toContain(submitted.status());
  await page.waitForTimeout(6_000);

  const full = await readStream(page, `${ORIGIN}/api/trips/${tripId}/events`);
  expect(full.sawRetry).toBe(true);
  expect(full.ids.length).toBeGreaterThan(0);
  expect(full.types).toContain("operation.admitted");
  // Safe payloads only: no prompts, no provider payloads, no secrets.
  for (const payload of full.payloads) {
    expect(payload).not.toMatch(/prompt|chainOfThought|apiKey|secret/i);
  }

  const maxId = Math.max(...full.ids);
  const minId = Math.min(...full.ids);
  // Reconnecting after the last applied id replays nothing older.
  const resumed = await readStream(page, `${ORIGIN}/api/trips/${tripId}/events?after=${maxId}`, 2500);
  expect(resumed.ids.every((id) => id > maxId)).toBe(true);
  // Reconnecting after an earlier id replays exactly the missed window.
  const missed = await readStream(page, `${ORIGIN}/api/trips/${tripId}/events?after=${minId}`, 2500);
  expect(missed.ids.length).toBeGreaterThan(0);
  expect(missed.ids.every((id) => id > minId)).toBe(true);
  // An invalid cursor is normalized to the beginning: the replay starts at the
  // first stored event, never at an arbitrary offset.
  const invalid = await readStream(page, `${ORIGIN}/api/trips/${tripId}/events?after=not-a-number`, 2500);
  expect(invalid.ids[0]).toBe(minId);
});
