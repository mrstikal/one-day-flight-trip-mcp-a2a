import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getActiveReservation } from "@odft/persistence";
import type { BookingService } from "@odft/domain";
import { FIXTURE_HOTEL_OFFER, FIXTURE_HOTEL_OFFER_ALT } from "../../fixtures/offers.js";
import {
  createBookingFixture,
  createBookingService,
  createConfirmationDecision,
  createOperation,
  createTestPool,
  resetDatabase,
  type BookingFixture,
} from "./_setup.js";

/** AC-03-4: replacement supersedes before insert; one active reservation; decision required. */

const pool = createTestPool(6);
const FINGERPRINT = "b".repeat(64);

beforeAll(async () => {
  await resetDatabase(pool);
});
afterAll(async () => {
  await pool.end();
});

async function confirmOffer(
  service: BookingService,
  fixture: BookingFixture,
  offerId: string,
): Promise<{ reservationId: string; demoReference: string }> {
  const proposal = await service.propose({
    tripId: fixture.tripId,
    sessionId: fixture.sessionId,
    service: "hotel",
    offerId,
    operationId: fixture.operationId,
    sourceFingerprint: FINGERPRINT,
  });
  const decisionId = await createConfirmationDecision(pool, {
    tripId: fixture.tripId,
    proposalId: proposal.proposalId,
    sourceFingerprint: FINGERPRINT,
    allowedOfferIds: [offerId],
    revision: fixture.revision,
  });
  return service.confirm({
    tripId: fixture.tripId,
    sessionId: fixture.sessionId,
    proposalId: proposal.proposalId,
    decisionId,
    operationId: await createOperation(pool, fixture.tripId),
    acceptedRevision: fixture.revision,
    acceptedDemoDisclaimer: true,
    confirmationKey: randomUUID(),
  });
}

describe("replacement", () => {
  it("supersedes the old reservation and confirms the new one in one transaction", async () => {
    const fixture = await createBookingFixture(pool);
    const service = createBookingService(pool);
    const first = await confirmOffer(service, fixture, FIXTURE_HOTEL_OFFER);

    const proposal = await service.propose({
      tripId: fixture.tripId,
      sessionId: fixture.sessionId,
      service: "hotel",
      offerId: FIXTURE_HOTEL_OFFER_ALT,
      operationId: fixture.operationId,
      sourceFingerprint: FINGERPRINT,
    });
    const decisionId = await createConfirmationDecision(pool, {
      tripId: fixture.tripId,
      proposalId: proposal.proposalId,
      sourceFingerprint: FINGERPRINT,
      allowedOfferIds: [FIXTURE_HOTEL_OFFER_ALT],
      kind: "replacement_confirmation",
      revision: fixture.revision,
    });

    const replaced = await service.replaceConfirmed({
      tripId: fixture.tripId,
      sessionId: fixture.sessionId,
      proposalId: proposal.proposalId,
      decisionId,
      operationId: await createOperation(pool, fixture.tripId),
      acceptedRevision: fixture.revision,
      acceptedDemoDisclaimer: true,
      confirmationKey: randomUUID(),
      affectedReservationId: first.reservationId,
    });
    expect(replaced.reservationId).not.toBe(first.reservationId);

    const old = await pool.query<{ status: string }>(
      "SELECT status FROM odft_app.reservations WHERE id = $1",
      [first.reservationId],
    );
    expect(old.rows[0]?.status).toBe("superseded");

    const confirmed = await pool.query<{ id: string; c: number }>(
      "SELECT (SELECT count(*)::int FROM odft_app.reservations WHERE trip_id = $1 AND service_key = 'hotel' AND status = 'confirmed') AS c, (SELECT id FROM odft_app.reservations WHERE trip_id = $1 AND service_key = 'hotel' AND status = 'confirmed') AS id",
      [fixture.tripId],
    );
    expect(confirmed.rows[0]?.c).toBe(1);
    expect(confirmed.rows[0]?.id).toBe(replaced.reservationId);

    const active = await getActiveReservation(pool, fixture.tripId, "hotel");
    expect(active?.id).toBe(replaced.reservationId);
  });

  it("requires a replacement confirmation before replacing a different offer", async () => {
    const fixture = await createBookingFixture(pool);
    const service = createBookingService(pool);
    await confirmOffer(service, fixture, FIXTURE_HOTEL_OFFER);

    const proposal = await service.propose({
      tripId: fixture.tripId,
      sessionId: fixture.sessionId,
      service: "hotel",
      offerId: FIXTURE_HOTEL_OFFER_ALT,
      operationId: fixture.operationId,
      sourceFingerprint: FINGERPRINT,
    });
    const decisionId = await createConfirmationDecision(pool, {
      tripId: fixture.tripId,
      proposalId: proposal.proposalId,
      sourceFingerprint: FINGERPRINT,
      allowedOfferIds: [FIXTURE_HOTEL_OFFER_ALT],
      kind: "booking_confirmation",
      revision: fixture.revision,
    });

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
    ).rejects.toMatchObject({ code: "REPLACEMENT_CONFIRMATION_REQUIRED" });

    const rows = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM odft_app.reservations WHERE trip_id = $1",
      [fixture.tripId],
    );
    expect(rows.rows[0]?.c).toBe(1); // only the original
  });
});
