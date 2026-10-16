import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RefGenerationFailedError,
  getActiveReservation,
  insertReservationWithGeneratedReference,
} from "@odft/persistence";
import { DEMO_REFERENCE_PATTERN, type BookingService } from "@odft/domain";
import { FIXTURE_HOTEL_OFFER } from "../../fixtures/offers.js";
import {
  createBookingFixture,
  createBookingService,
  createConfirmationDecision,
  createOperation,
  createTestPool,
  resetDatabase,
  type BookingFixture,
} from "./_setup.js";

/** AC-03-1..04: confirmation, idempotency, one-active-reservation, collisions. */

const pool = createTestPool(6);
const FINGERPRINT = "b".repeat(64);

beforeAll(async () => {
  await resetDatabase(pool);
});
afterAll(async () => {
  await pool.end();
});

async function proposeHotel(service: BookingService, fixture: BookingFixture) {
  return service.propose({
    tripId: fixture.tripId,
    sessionId: fixture.sessionId,
    service: "hotel",
    offerId: FIXTURE_HOTEL_OFFER,
    operationId: fixture.operationId,
    sourceFingerprint: FINGERPRINT,
  });
}

async function decision(fixture: BookingFixture, proposalId: string): Promise<string> {
  return createConfirmationDecision(pool, {
    tripId: fixture.tripId,
    proposalId,
    sourceFingerprint: FINGERPRINT,
    allowedOfferIds: [FIXTURE_HOTEL_OFFER],
    revision: fixture.revision,
  });
}

describe("confirmation", () => {
  it("confirms a proposal and returns a formatted demo reference", async () => {
    const fixture = await createBookingFixture(pool);
    const service = createBookingService(pool);
    const proposal = await proposeHotel(service, fixture);
    const decisionId = await decision(fixture, proposal.proposalId);

    const result = await service.confirm({
      tripId: fixture.tripId,
      sessionId: fixture.sessionId,
      proposalId: proposal.proposalId,
      decisionId,
      operationId: await createOperation(pool, fixture.tripId),
      acceptedRevision: fixture.revision,
      acceptedDemoDisclaimer: true,
      confirmationKey: randomUUID(),
    });
    expect(result.status).toBe("confirmed");
    expect(result.idempotent).toBe(false);
    expect(result.demoReference).toMatch(DEMO_REFERENCE_PATTERN);
    expect(result.demoReference).toMatch(/^DEMO-HTL-/);

    const active = await getActiveReservation(pool, fixture.tripId, "hotel");
    expect(active?.id).toBe(result.reservationId);

    const confirmed = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM odft_app.reservations WHERE trip_id = $1 AND service_key = 'hotel' AND status = 'confirmed'",
      [fixture.tripId],
    );
    expect(confirmed.rows[0]?.c).toBe(1);
  });

  it("returns the existing active reservation for the same offer with a new key", async () => {
    const fixture = await createBookingFixture(pool);
    const service = createBookingService(pool);
    const proposal = await proposeHotel(service, fixture);
    const decisionId = await decision(fixture, proposal.proposalId);

    const first = await service.confirm({
      tripId: fixture.tripId,
      sessionId: fixture.sessionId,
      proposalId: proposal.proposalId,
      decisionId,
      operationId: await createOperation(pool, fixture.tripId),
      acceptedRevision: fixture.revision,
      acceptedDemoDisclaimer: true,
      confirmationKey: randomUUID(),
    });
    const secondDecisionId = await decision(fixture, proposal.proposalId);
    const second = await service.confirm({
      tripId: fixture.tripId,
      sessionId: fixture.sessionId,
      proposalId: proposal.proposalId,
      decisionId: secondDecisionId,
      operationId: await createOperation(pool, fixture.tripId),
      acceptedRevision: fixture.revision,
      acceptedDemoDisclaimer: true,
      confirmationKey: randomUUID(),
    });
    expect(second.reservationId).toBe(first.reservationId);
    expect(second.demoReference).toBe(first.demoReference);
    expect(second.idempotent).toBe(true);

    const rows = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM odft_app.reservations WHERE trip_id = $1",
      [fixture.tripId],
    );
    expect(rows.rows[0]?.c).toBe(1);
  });

  it("withdraws an expired proposal instead of leaving it proposed", async () => {
    const fixture = await createBookingFixture(pool);
    const service = createBookingService(pool);
    const proposal = await service.propose({
      tripId: fixture.tripId,
      sessionId: fixture.sessionId,
      service: "hotel",
      offerId: FIXTURE_HOTEL_OFFER,
      operationId: fixture.operationId,
      sourceFingerprint: FINGERPRINT,
      expiresInMs: -1000,
    });
    const decisionId = await decision(fixture, proposal.proposalId);

    await expect(
      service.confirm({
        tripId: fixture.tripId,
        sessionId: fixture.sessionId,
        proposalId: proposal.proposalId,
        decisionId,
        operationId: await createOperation(pool, fixture.tripId),
        acceptedRevision: fixture.revision,
        acceptedDemoDisclaimer: true,
        confirmationKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "PROPOSAL_EXPIRED" });

    const status = await pool.query<{ status: string }>(
      "SELECT status FROM odft_app.selection_proposals WHERE id = $1",
      [proposal.proposalId],
    );
    expect(status.rows[0]?.status).toBe("expired");
    const rows = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM odft_app.reservations WHERE trip_id = $1",
      [fixture.tripId],
    );
    expect(rows.rows[0]?.c).toBe(0);
  });

  it("retries a forced reference collision at most three times without leaving a reservation", async () => {
    const fixture = await createBookingFixture(pool);
    const service = createBookingService(pool);
    const fixed = `DEMO-RST-${"A".repeat(20)}`;
    const terms = {
      snapshotId: fixture.snapshotId,
      offerContentHash: "c".repeat(64),
      sightseeingDate: "2026-12-01",
      travelVariant: "two_nights" as const,
      nights: 2,
      adults: 2,
      demoLabels: ["Demo offer"],
      disclaimerAcknowledged: true as const,
    };

    // Commit a lunch reservation holding the fixed reference.
    const lunchProposal = await service.propose({
      tripId: fixture.tripId,
      sessionId: fixture.sessionId,
      service: "lunch",
      offerId: "DEMO-LUNCH-1",
      operationId: fixture.operationId,
      sourceFingerprint: FINGERPRINT,
    });
    const setupClient = await pool.connect();
    try {
      await setupClient.query("BEGIN");
      await insertReservationWithGeneratedReference(
        setupClient,
        {
          id: randomUUID(),
          tripId: fixture.tripId,
          serviceKey: "lunch",
          offerId: "DEMO-LUNCH-1",
          snapshotId: fixture.snapshotId,
          proposalId: lunchProposal.proposalId,
          decisionId: randomUUID(),
          confirmationKey: randomUUID(),
          termsHash: "c".repeat(64),
          terms: { ...terms, serviceKey: "lunch", partyTotalMinor: 5000 },
          partyTotalMinor: 5000,
        },
        () => fixed,
        3,
      );
      await setupClient.query("COMMIT");
    } finally {
      setupClient.release();
    }

    // A different service (shared RST prefix) must collide and give up after 3 attempts.
    const dinnerProposal = await service.propose({
      tripId: fixture.tripId,
      sessionId: fixture.sessionId,
      service: "dinner",
      offerId: "DEMO-DINNER-1",
      operationId: fixture.operationId,
      sourceFingerprint: FINGERPRINT,
    });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await expect(
        insertReservationWithGeneratedReference(
          client,
          {
            id: randomUUID(),
            tripId: fixture.tripId,
            serviceKey: "dinner",
            offerId: "DEMO-DINNER-1",
            snapshotId: fixture.snapshotId,
            proposalId: dinnerProposal.proposalId,
            decisionId: randomUUID(),
            confirmationKey: randomUUID(),
            termsHash: "c".repeat(64),
            terms: { ...terms, serviceKey: "dinner", partyTotalMinor: 8000 },
            partyTotalMinor: 8000,
          },
          () => fixed,
          3,
        ),
      ).rejects.toBeInstanceOf(RefGenerationFailedError);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const dinner = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM odft_app.reservations WHERE trip_id = $1 AND service_key = 'dinner'",
      [fixture.tripId],
    );
    expect(dinner.rows[0]?.c).toBe(0);
    const lunch = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM odft_app.reservations WHERE trip_id = $1 AND service_key = 'lunch'",
      [fixture.tripId],
    );
    expect(lunch.rows[0]?.c).toBe(1);
  });
});
