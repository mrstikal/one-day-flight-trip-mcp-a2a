import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admitOperation, admitResume, createTrip, insertDecision } from "@odft/persistence";
import { createFixtureSession } from "../../fixtures/session.js";
import { fixtureCreationInput } from "../../fixtures/trip.js";
import { createTestPool, resetDatabase } from "./_setup.js";

/** AC-03-6/AC-03-9: trip creation dedupe and single revision increment. */

const pool = createTestPool(4);

beforeAll(async () => {
  await resetDatabase(pool);
});
afterAll(async () => {
  await pool.end();
});

async function newSession(): Promise<string> {
  const client = await pool.connect();
  try {
    return await createFixtureSession(client);
  } finally {
    client.release();
  }
}

describe("trip creation and admission", () => {
  it("dedupes identical creation requests to one trip and operation", async () => {
    const sessionId = await newSession();
    const input = fixtureCreationInput();
    const first = await createTrip(pool, { sessionId, input });
    const second = await createTrip(pool, { sessionId, input });
    if (!("tripId" in first) || !("tripId" in second)) {
      throw new Error("creation unexpectedly failed");
    }
    expect(second.tripId).toBe(first.tripId);
    expect(second.operationId).toBe(first.operationId);
    const count = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM odft_app.trips WHERE session_id = $1",
      [sessionId],
    );
    expect(count.rows[0]?.c).toBe(1);
  });

  it("concurrent identical creation requests return one trip", async () => {
    const sessionId = await newSession();
    const input = fixtureCreationInput();
    const [a, b] = await Promise.all([
      createTrip(pool, { sessionId, input }),
      createTrip(pool, { sessionId, input }),
    ]);
    if (!("tripId" in a) || !("tripId" in b)) {
      throw new Error("concurrent creation unexpectedly failed");
    }
    expect(a.tripId).toBe(b.tripId);
    const count = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM odft_app.trips WHERE session_id = $1",
      [sessionId],
    );
    expect(count.rows[0]?.c).toBe(1);
  });

  it("rejects a changed payload under the same creation request id", async () => {
    const sessionId = await newSession();
    const input = fixtureCreationInput();
    await createTrip(pool, { sessionId, input });
    const result = await createTrip(pool, { sessionId, input: { ...input, adults: 5 } });
    expect("code" in result ? result.code : undefined).toBe("CREATION_CONFLICT");
  });

  it("increments revision exactly once per admitted request and dedupes replays", async () => {
    const sessionId = await newSession();
    const created = await createTrip(pool, { sessionId, input: fixtureCreationInput() });
    if (!("tripId" in created)) {
      throw new Error("creation failed");
    }
    // Simulate the worker completing the initialization operation before a new command.
    await pool.query(
      "UPDATE odft_app.workflow_operations SET status = 'succeeded' WHERE trip_id = $1 AND status IN ('queued','running')",
      [created.tripId],
    );
    const request = {
      requestId: randomUUID(),
      expectedRevision: 1,
      command: { type: "build_itinerary" as const },
    };
    const accepted = await admitOperation(pool, { tripId: created.tripId, sessionId, request });
    expect(accepted).toMatchObject({ status: "accepted", revision: 2, deduped: false });

    const deduped = await admitOperation(pool, { tripId: created.tripId, sessionId, request });
    expect(deduped).toMatchObject({ status: "accepted", revision: 2, deduped: true });

    const trip = await pool.query<{ revision: number }>(
      "SELECT revision FROM odft_app.trips WHERE id = $1",
      [created.tripId],
    );
    expect(trip.rows[0]?.revision).toBe(2);

    const sameKeyDifferentPayload = await admitOperation(pool, {
      tripId: created.tripId,
      sessionId,
      request: { ...request, command: { type: "set_activity_pace", pace: "relaxed" } },
    });
    expect("code" in sameKeyDifferentPayload ? sameKeyDifferentPayload.code : undefined).toBe(
      "CONFLICT",
    );
  });

  it("rejects a stale revision without changing state", async () => {
    const sessionId = await newSession();
    const created = await createTrip(pool, { sessionId, input: fixtureCreationInput() });
    if (!("tripId" in created)) {
      throw new Error("creation failed");
    }
    const result = await admitOperation(pool, {
      tripId: created.tripId,
      sessionId,
      request: { requestId: randomUUID(), expectedRevision: 99, command: { type: "build_itinerary" } },
    });
    expect("code" in result ? result.code : undefined).toBe("STALE_REVISION");
    const trip = await pool.query<{ revision: number }>(
      "SELECT revision FROM odft_app.trips WHERE id = $1",
      [created.tripId],
    );
    expect(trip.rows[0]?.revision).toBe(1);
  });

  it("rejects geographic references that are not admitted", async () => {
    const bad = await createTrip(pool, {
      sessionId: await newSession(),
      input: fixtureCreationInput({ originAirportId: "ourairports:99999999" }),
    });
    expect("code" in bad ? bad.code : undefined).toBe("VALIDATION_FAILED");

    const mismatched = await createTrip(pool, {
      sessionId: await newSession(),
      input: fixtureCreationInput({ destinationCountryKey: "FR" }),
    });
    expect("code" in mismatched ? mismatched.code : undefined).toBe("VALIDATION_FAILED");
  });

  it("rejects an expired session", async () => {
    const client = await pool.connect();
    const sessionId = randomUUID();
    try {
      await client.query(
        `INSERT INTO odft_app.anonymous_sessions (id, token_hash, csrf_token_hash, expires_at)
         VALUES ($1, $2, $3, now() - interval '1 hour')`,
        [sessionId, randomUUID().replace(/-/g, "").repeat(2), "f".repeat(64)],
      );
    } finally {
      client.release();
    }
    const result = await createTrip(pool, { sessionId, input: fixtureCreationInput() });
    expect("code" in result ? result.code : undefined).toBe("FORBIDDEN");
  });

  it("rejects a no-op set_route command", async () => {
    const sessionId = await newSession();
    const created = await createTrip(pool, { sessionId, input: fixtureCreationInput() });
    if (!("tripId" in created)) {
      throw new Error("creation failed");
    }
    await pool.query(
      "UPDATE odft_app.workflow_operations SET status = 'succeeded' WHERE trip_id = $1 AND status IN ('queued','running')",
      [created.tripId],
    );
    const result = await admitOperation(pool, {
      tripId: created.tripId,
      sessionId,
      request: { requestId: randomUUID(), expectedRevision: 1, command: { type: "set_route" } },
    });
    expect("code" in result ? result.code : undefined).toBe("VALIDATION_FAILED");
  });

  it("admits a decision resume without incrementing revision", async () => {
    const sessionId = await newSession();
    const created = await createTrip(pool, { sessionId, input: fixtureCreationInput() });
    if (!("tripId" in created)) {
      throw new Error("creation failed");
    }
    await pool.query(
      "UPDATE odft_app.workflow_operations SET status = 'succeeded' WHERE trip_id = $1 AND status IN ('queued','running')",
      [created.tripId],
    );
    const client = await pool.connect();
    let decisionId: string;
    try {
      decisionId = await insertDecision(client, {
        tripId: created.tripId,
        kind: "itinerary_approval",
        threadId: created.tripId,
        graphVersion: "graph-v0",
        createdRevision: 1,
        sourceFingerprint: "a".repeat(64),
        payloadHash: "a".repeat(64),
      });
    } finally {
      client.release();
    }

    const accepted = await admitResume(pool, {
      tripId: created.tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: 1,
        decisionId,
        response: { action: "approve_itinerary", itineraryId: randomUUID() },
      },
    });
    expect(accepted).toMatchObject({ status: "accepted", revision: 1, deduped: false });

    await pool.query(
      "UPDATE odft_app.workflow_operations SET status = 'succeeded' WHERE trip_id = $1 AND status IN ('queued','running')",
      [created.tripId],
    );
    const mismatched = await admitResume(pool, {
      tripId: created.tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: 1,
        decisionId,
        response: { action: "choose_option", optionId: "x" },
      },
    });
    expect("code" in mismatched ? mismatched.code : undefined).toBe("STALE_DECISION");

    const trip = await pool.query<{ revision: number }>(
      "SELECT revision FROM odft_app.trips WHERE id = $1",
      [created.tripId],
    );
    expect(trip.rows[0]?.revision).toBe(1);
  });
});
