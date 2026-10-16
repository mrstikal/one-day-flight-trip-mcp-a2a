import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admitOperation } from "@odft/persistence";
import { FIXTURE_HOTEL_OFFER } from "../../fixtures/offers.js";
import {
  createBookingFixture,
  createBookingService,
  createConfirmationDecision,
  createOperation,
  createTestPool,
  resetDatabase,
} from "./_setup.js";

/** T-IT-CONC-01: two real, independent connections; one reservation, one result. */

const poolA = createTestPool(4);
const poolB = createTestPool(4);
const FINGERPRINT = "b".repeat(64);

beforeAll(async () => {
  await resetDatabase(poolA);
});
afterAll(async () => {
  await poolA.end();
  await poolB.end();
});

describe("concurrency", () => {
  it("concurrent duplicate confirmation produces one reservation and one stored result", async () => {
    const fixture = await createBookingFixture(poolA);
    const serviceA = createBookingService(poolA);
    const serviceB = createBookingService(poolB);
    const proposal = await serviceA.propose({
      tripId: fixture.tripId,
      sessionId: fixture.sessionId,
      service: "hotel",
      offerId: FIXTURE_HOTEL_OFFER,
      operationId: fixture.operationId,
      sourceFingerprint: FINGERPRINT,
    });
    const decisionId = await createConfirmationDecision(poolA, {
      tripId: fixture.tripId,
      proposalId: proposal.proposalId,
      sourceFingerprint: FINGERPRINT,
      allowedOfferIds: [FIXTURE_HOTEL_OFFER],
      revision: fixture.revision,
    });

    const base = {
      tripId: fixture.tripId,
      sessionId: fixture.sessionId,
      proposalId: proposal.proposalId,
      decisionId,
      operationId: await createOperation(poolA, fixture.tripId),
      acceptedRevision: fixture.revision,
      acceptedDemoDisclaimer: true as const,
      confirmationKey: randomUUID(),
    };

    const [a, b] = await Promise.all([
      serviceA.confirm(base),
      serviceB.confirm(base),
    ]);
    expect(a.reservationId).toBe(b.reservationId);
    expect(a.demoReference).toBe(b.demoReference);

    const reservations = await poolA.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM odft_app.reservations WHERE trip_id = $1",
      [fixture.tripId],
    );
    expect(reservations.rows[0]?.c).toBe(1);
    const effects = await poolA.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM odft_app.workflow_effects WHERE node_name = 'commit_booking'",
    );
    expect(effects.rows[0]?.c).toBe(1);
  });

  it("concurrent duplicate admission returns the stored operation for both", async () => {
    const fixture = await createBookingFixture(poolA);
    const request = {
      requestId: randomUUID(),
      expectedRevision: fixture.revision,
      command: { type: "build_itinerary" as const },
    };
    const [a, b] = await Promise.all([
      admitOperation(poolA, { tripId: fixture.tripId, sessionId: fixture.sessionId, request }),
      admitOperation(poolB, { tripId: fixture.tripId, sessionId: fixture.sessionId, request }),
    ]);
    if (!("status" in a) || !("status" in b)) {
      throw new Error("expected both admissions to be accepted");
    }
    expect(a.status).toBe("accepted");
    expect(b.status).toBe("accepted");
    expect(a.operationId).toBe(b.operationId);
    const count = await poolA.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM odft_app.workflow_operations WHERE trip_id = $1 AND request_id = $2",
      [fixture.tripId, request.requestId],
    );
    expect(count.rows[0]?.c).toBe(1);
  });

  it("concurrent commands at the same revision have one winner", async () => {
    const fixture = await createBookingFixture(poolA);
    const request = {
      requestId: randomUUID(),
      expectedRevision: fixture.revision,
      command: { type: "build_itinerary" as const },
    };
    const [a, b] = await Promise.all([
      admitOperation(poolA, { tripId: fixture.tripId, sessionId: fixture.sessionId, request }),
      admitOperation(poolB, {
        tripId: fixture.tripId,
        sessionId: fixture.sessionId,
        request: { ...request, requestId: randomUUID() },
      }),
    ]);
    const results = [a, b];
    const accepted = results.filter((result) => "status" in result && result.status === "accepted");
    const rejected = results.filter((result) => "code" in result);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const trip = await poolA.query<{ revision: number }>(
      "SELECT revision FROM odft_app.trips WHERE id = $1",
      [fixture.tripId],
    );
    expect(trip.rows[0]?.revision).toBe(fixture.revision + 1);
  });
});
