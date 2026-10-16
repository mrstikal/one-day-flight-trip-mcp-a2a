import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { startWorker, stopWorker, resetRateLimits } from "./_worker.js";

/**
 * Production worker end-to-end: session issuance, a trip the real worker drives
 * through route feasibility, flight generation, and schedule validation to the
 * flight-choice interrupt, live SSE, and the flight-choice resume. The SIGKILL
 * restart recipe is covered by the integration worker restart test.
 */

const ORIGIN = process.env.PUBLIC_BASE_URL ?? "http://127.0.0.1:3000";
const ORIGIN_AIRPORT = "ourairports:4408"; // PRG
const DESTINATION_CITY = "geonames:3169070"; // Rome
const DESTINATION_COUNTRY = "IT";

let worker: ChildProcess | undefined;

test.beforeAll(async () => {
  await resetRateLimits();
  worker = startWorker();
});

test.afterAll(async () => {
  await stopWorker(worker);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("worker drives PRG -> Rome to a flight choice and the resume is admitted", async ({
  request,
  baseURL,
}) => {
  const sessionRes = await request.post("/api/session", { headers: { origin: ORIGIN } });
  expect([200, 201]).toContain(sessionRes.status());
  const session = (await sessionRes.json()) as { sessionId: string; csrfToken: string };
  const cookie = sessionRes.headers()["set-cookie"]?.split(";")[0] ?? "";

  const created = await request.post("/api/trips", {
    headers: { origin: ORIGIN, "x-csrf-token": session.csrfToken },
    data: {
      creationRequestId: randomUUID(),
      userName: "E2E Traveller",
      adults: 2,
      originAirportId: ORIGIN_AIRPORT,
      destinationCityId: DESTINATION_CITY,
      destinationCountryKey: DESTINATION_COUNTRY,
      sightseeingDate: "2026-12-01",
      travelVariant: "two_nights",
    },
  });
  expect(created.status()).toBe(201);
  const trip = (await created.json()) as { tripId: string; operationId: string };

  let status = "";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const operationStatus = (await (
      await request.get(`/api/trips/${trip.tripId}/operations/${trip.operationId}`)
    ).json()) as { status: string };
    status = operationStatus.status;
    if (status === "waiting" || status === "succeeded") {
      break;
    }
    await sleep(250);
  }
  expect(status).toBe("waiting");

  const projection = (await (
    await request.get(`/api/trips/${trip.tripId}`, { headers: { cookie } })
  ).json()) as {
    flights: { routeStatus: string; scheduleStatus: string; offers: Array<{ id: string }> };
    pendingDecision: { id: string; kind: string } | null;
  };
  expect(projection.flights.routeStatus).toBe("FEASIBLE");
  expect(projection.flights.scheduleStatus).toBe("VALID");
  expect(projection.flights.offers.length).toBeGreaterThanOrEqual(1);
  expect(projection.pendingDecision?.kind).toBe("flight_choice");

  const controller = new AbortController();
  const streamRes = await fetch(`${baseURL}/api/trips/${trip.tripId}/events`, {
    headers: { cookie },
    signal: controller.signal,
  });
  expect(streamRes.headers.get("content-type")).toContain("text/event-stream");
  const reader = streamRes.body?.getReader();
  const first = await reader?.read();
  controller.abort();
  expect(new TextDecoder().decode(first?.value)).toContain("connected");

  const resumed = await request.post(`/api/trips/${trip.tripId}/resume`, {
    headers: { origin: ORIGIN, "x-csrf-token": session.csrfToken },
    data: {
      expectedRevision: 1,
      decisionId: projection.pendingDecision?.id,
      response: {
        action: "choose_offer",
        offerId: projection.flights.offers[0]?.id,
      },
    },
  });
  expect(resumed.status()).toBe(202);
});
