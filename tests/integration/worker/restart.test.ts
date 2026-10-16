import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admitResume, getPendingDecisionForTrip } from "@odft/persistence";
import {
  createGraphTestPool,
  createHarnessTrip,
  createWorkerPools,
  endWorkerPools,
  readTravelState,
  requireTestDatabaseUrl,
  resetGraphDatabase,
  type WorkerPools,
} from "../graph/_setup.js";

/**
 * T-IT-FLT-05: a real new OS process continues the production travel-graph
 * thread across a SIGKILL without duplicating business effects. The thread is
 * durable in the official checkpointer; the fenced worker is only an executor.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX = `${REPO_ROOT}/node_modules/.bin/tsx`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for worker progress");
    }
    await sleep(200);
  }
}

function spawnWorker(): ChildProcess {
  const env = {
    ...process.env,
    DATABASE_URL: requireTestDatabaseUrl(),
    TEST_DATABASE_URL: requireTestDatabaseUrl(),
    PUBLIC_BASE_URL: "http://localhost:3000",
    SESSION_HMAC_KEY: "integration-test-session-hmac-key-0123456789",
    AI_MODE: "fixture",
    WORKER_CONCURRENCY: "1",
  };
  return spawn(TSX, ["--tsconfig", "tsconfig.json", "apps/worker/src/main.ts"], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
}

async function killWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    if (child.pid) {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    child.kill("SIGKILL");
  }
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function waitForDecisionKind(
  pools: WorkerPools,
  tripId: string,
  kind: string,
): Promise<string> {
  return waitFor(async () => {
    const decision = await getPendingDecisionForTrip(pools.operations, tripId);
    return decision && decision.kind === kind ? decision.id : undefined;
  });
}

describe("worker restart across processes (travel graph)", () => {
  let pool: Pool;
  let pools: WorkerPools;

  beforeAll(async () => {
    pool = createGraphTestPool();
    pools = createWorkerPools();
    await resetGraphDatabase(pool);
  });

  afterAll(async () => {
    await endWorkerPools(pools);
    await pool.end();
  });

  it(
    "continues a travel-graph thread in new processes without duplicating the reservation",
    async () => {
      const { tripId, sessionId } = await createHarnessTrip(pool);

      // First process: drive the creation to the flight-choice interrupt, then SIGKILL.
      const first = spawnWorker();
      try {
        await waitForDecisionKind(pools, tripId, "flight_choice");
      } finally {
        await killWorker(first);
      }

      const decision = await getPendingDecisionForTrip(pools.operations, tripId);
      expect(decision?.allowedOfferIds.length).toBeGreaterThanOrEqual(1);
      const offerId = decision?.allowedOfferIds[0] as string;

      const chosen = await admitResume(pool, {
        tripId,
        sessionId,
        request: {
          requestId: randomUUID(),
          expectedRevision: 1,
          decisionId: decision?.id ?? "",
          response: { action: "choose_offer", offerId },
        },
      });
      expect("operationId" in chosen).toBe(true);

      // Second process: stage the proposal and stop at the booking confirmation.
      const second = spawnWorker();
      try {
        await waitForDecisionKind(pools, tripId, "booking_confirmation");
      } finally {
        await killWorker(second);
      }

      const confirmation = await getPendingDecisionForTrip(pools.operations, tripId);
      const confirmed = await admitResume(pool, {
        tripId,
        sessionId,
        request: {
          requestId: randomUUID(),
          expectedRevision: 1,
          decisionId: confirmation?.id ?? "",
          response: {
            action: "confirm_booking",
            proposalId: confirmation?.proposalId as string,
            acceptedDemoDisclaimer: true,
          },
        },
      });
      expect("operationId" in confirmed).toBe(true);

      // Third process: commit the booking and continue into Phase 07 hotel
      // research, stopping at the hotel-choice interrupt.
      const third = spawnWorker();
      try {
        await waitForDecisionKind(pools, tripId, "hotel_choice");
      } finally {
        await killWorker(third);
      }

      const finalState = await readTravelState(pools, tripId);
      expect(finalState.values.gate).toBe("hotels_ready");

      const reservations = await pools.operations.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM odft_app.reservations
          WHERE trip_id = $1 AND status = 'confirmed'`,
        [tripId],
      );
      expect(reservations.rows[0]?.count).toBe("1");
    },
    90_000,
  );
});
