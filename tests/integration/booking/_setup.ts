import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { BookingService } from "@odft/domain";
import {
  PostgresBookingStore,
  createTrip,
  insertDecision,
  insertOperation,
  loadReferenceData,
  runMigrations,
} from "@odft/persistence";
import { createFixtureSession } from "../../fixtures/session.js";
import { fixtureCreationInput } from "../../fixtures/trip.js";
import { insertFixtureSnapshot } from "../../fixtures/snapshot.js";
import { insertFeasibleRoute, insertValidSchedule } from "../../fixtures/approvals.js";

/** Shared real-PostgreSQL setup for Phase 03 booking integration tests. */

export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is required for integration tests. Start PostgreSQL " +
        "(docker compose up -d postgres) and provide TEST_DATABASE_URL.",
    );
  }
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
    throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL.");
  }
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to run destructive tests against non-test database "${name}".`);
  }
  return url;
}

export function createTestPool(max = 8): Pool {
  return new Pool({ connectionString: requireTestDatabaseUrl(), max });
}

export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS odft_app CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS odft_checkpoint CASCADE");
  await runMigrations(pool);
  // createTrip validates geographic references, so booking tests need the
  // committed reference data loaded.
  await loadReferenceData(pool);
}

export interface BookingFixture {
  readonly sessionId: string;
  readonly tripId: string;
  readonly operationId: string;
  readonly snapshotId: string;
  readonly routeValidationId: string;
  readonly scheduleValidationId: string;
  readonly revision: number;
}

export async function createBookingFixture(pool: Pool): Promise<BookingFixture> {
  const sessionClient = await pool.connect();
  let sessionId: string;
  try {
    sessionId = await createFixtureSession(sessionClient);
  } finally {
    sessionClient.release();
  }

  const created = await createTrip(pool, { sessionId, input: fixtureCreationInput() });
  if (!("tripId" in created)) {
    throw new Error(`fixture createTrip failed: ${created.code}`);
  }
  const tripId = created.tripId;

  const client = await pool.connect();
  try {
    // Simulate the worker finishing the trip initialization operation so new
    // commands are not blocked by the one-active-operation index.
    await client.query(
      `UPDATE odft_app.workflow_operations SET status = 'succeeded'
        WHERE trip_id = $1 AND status IN ('queued', 'running')`,
      [tripId],
    );
    const snapshotId = await insertFixtureSnapshot(client, { tripId });
    const routeValidationId = await insertFeasibleRoute(client, tripId);
    const scheduleValidationId = await insertValidSchedule(client, {
      tripId,
      routeValidationId,
      snapshotId,
    });
    const operationId = await createOperation(pool, tripId);
    return { sessionId, tripId, operationId, snapshotId, routeValidationId, scheduleValidationId, revision: 1 };
  } finally {
    client.release();
  }
}

/** A deterministic service with a fixed clock so proposals never expire mid-test. */
export function createBookingService(pool: Pool, now = new Date("2026-12-01T12:00:00.000Z")): BookingService {
  return new BookingService(new PostgresBookingStore(pool), { now: () => now });
}

/** Persist a real (non-active) operation row so confirmation can write an effect. */
export async function createOperation(pool: Pool, tripId: string, revision = 1): Promise<string> {
  const client = await pool.connect();
  try {
    const operation = await insertOperation(client, {
      tripId,
      requestId: randomUUID(),
      payloadHash: "e".repeat(64),
      acceptedRevision: revision,
      kind: "command",
      status: "succeeded",
      payload: {},
    });
    return operation.id;
  } finally {
    client.release();
  }
}

export interface DecisionFixtureInput {
  readonly tripId: string;
  readonly proposalId: string;
  readonly sourceFingerprint: string;
  readonly allowedOfferIds: string[];
  readonly kind?: "booking_confirmation" | "replacement_confirmation" | "flight_choice";
  readonly revision?: number;
}

export async function createConfirmationDecision(
  pool: Pool,
  input: DecisionFixtureInput,
): Promise<string> {
  const client = await pool.connect();
  try {
    // Only one pending decision may exist per trip; retire any previous one.
    await client.query(
      `UPDATE odft_app.pending_decisions SET status = 'cancelled', resolved_at = now()
        WHERE trip_id = $1 AND status = 'pending'`,
      [input.tripId],
    );
    return await insertDecision(client, {
      tripId: input.tripId,
      kind: input.kind ?? "booking_confirmation",
      threadId: input.tripId,
      graphVersion: "graph-v0",
      createdRevision: input.revision ?? 1,
      sourceFingerprint: input.sourceFingerprint,
      proposalId: input.proposalId,
      allowedOfferIds: input.allowedOfferIds,
      payloadHash: input.sourceFingerprint,
    });
  } finally {
    client.release();
  }
}
