import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_HOTEL_OFFER } from "../../fixtures/offers.js";
import {
  createBookingFixture,
  createBookingService,
  createConfirmationDecision,
  createOperation,
  createTestPool,
  resetDatabase,
} from "./_setup.js";

/** AC-03-2 / AC-03-7: duplicate confirmation dedupe and effect replay. */

const pool = createTestPool(6);
const FINGERPRINT = "b".repeat(64);

beforeAll(async () => {
  await resetDatabase(pool);
});
afterAll(async () => {
  await pool.end();
});

async function setupWithProposal() {
  const fixture = await createBookingFixture(pool);
  const service = createBookingService(pool);
  const proposal = await service.propose({
    tripId: fixture.tripId,
    sessionId: fixture.sessionId,
    service: "hotel",
    offerId: FIXTURE_HOTEL_OFFER,
    operationId: fixture.operationId,
    sourceFingerprint: FINGERPRINT,
  });
  const decisionId = await createConfirmationDecision(pool, {
    tripId: fixture.tripId,
    proposalId: proposal.proposalId,
    sourceFingerprint: FINGERPRINT,
    allowedOfferIds: [FIXTURE_HOTEL_OFFER],
    revision: fixture.revision,
  });
  return { fixture, service, proposal, decisionId };
}

describe("confirmation idempotency", () => {
  it("replays the stored effect for the same operation without re-executing", async () => {
    const { fixture, service, proposal, decisionId } = await setupWithProposal();
    const operationId = await createOperation(pool, fixture.tripId);
    const base = {
      tripId: fixture.tripId,
      sessionId: fixture.sessionId,
      proposalId: proposal.proposalId,
      decisionId,
      operationId,
      acceptedRevision: fixture.revision,
      acceptedDemoDisclaimer: true as const,
    };
    const first = await service.confirm({ ...base, confirmationKey: randomUUID() });
    const replay = await service.confirm({ ...base, confirmationKey: randomUUID() });
    expect(replay.reservationId).toBe(first.reservationId);
    expect(replay.idempotent).toBe(true);

    const reservations = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM odft_app.reservations WHERE trip_id = $1",
      [fixture.tripId],
    );
    expect(reservations.rows[0]?.c).toBe(1);
    const effects = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM odft_app.workflow_effects WHERE node_name = 'commit_booking'",
    );
    expect(effects.rows[0]?.c).toBe(1);
  });

  it("returns the existing reservation for the same confirmation key with a new operation", async () => {
    const { fixture, service, proposal, decisionId } = await setupWithProposal();
    const confirmationKey = randomUUID();
    const first = await service.confirm({
      tripId: fixture.tripId,
      sessionId: fixture.sessionId,
      proposalId: proposal.proposalId,
      decisionId,
      operationId: await createOperation(pool, fixture.tripId),
      acceptedRevision: fixture.revision,
      acceptedDemoDisclaimer: true,
      confirmationKey,
    });
    const secondDecisionId = await createConfirmationDecision(pool, {
      tripId: fixture.tripId,
      proposalId: proposal.proposalId,
      sourceFingerprint: FINGERPRINT,
      allowedOfferIds: [FIXTURE_HOTEL_OFFER],
      revision: fixture.revision,
    });
    const second = await service.confirm({
      tripId: fixture.tripId,
      sessionId: fixture.sessionId,
      proposalId: proposal.proposalId,
      decisionId: secondDecisionId,
      operationId: await createOperation(pool, fixture.tripId),
      acceptedRevision: fixture.revision,
      acceptedDemoDisclaimer: true,
      confirmationKey,
    });
    expect(second.reservationId).toBe(first.reservationId);
    const rows = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM odft_app.reservations WHERE trip_id = $1",
      [fixture.tripId],
    );
    expect(rows.rows[0]?.c).toBe(1);

    // No decision is left dangling by the idempotent path.
    const pending = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM odft_app.pending_decisions WHERE trip_id = $1 AND status = 'pending'",
      [fixture.tripId],
    );
    expect(pending.rows[0]?.c).toBe(0);

    // A subsequent decision for the trip is therefore accepted (no raw 23505).
    await expect(
      createConfirmationDecision(pool, {
        tripId: fixture.tripId,
        proposalId: proposal.proposalId,
        sourceFingerprint: FINGERPRINT,
        allowedOfferIds: [FIXTURE_HOTEL_OFFER],
        revision: fixture.revision,
      }),
    ).resolves.toEqual(expect.any(String));
  });

  it("allows the same confirmation key on a different trip", async () => {
    const fixtureA = await createBookingFixture(pool);
    const fixtureB = await createBookingFixture(pool);
    const key = randomUUID();
    const confirmOn = async (fixture: typeof fixtureA) => {
      const service = createBookingService(pool);
      const proposal = await service.propose({
        tripId: fixture.tripId,
        sessionId: fixture.sessionId,
        service: "hotel",
        offerId: FIXTURE_HOTEL_OFFER,
        operationId: fixture.operationId,
        sourceFingerprint: FINGERPRINT,
      });
      const decisionId = await createConfirmationDecision(pool, {
        tripId: fixture.tripId,
        proposalId: proposal.proposalId,
        sourceFingerprint: FINGERPRINT,
        allowedOfferIds: [FIXTURE_HOTEL_OFFER],
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
        confirmationKey: key,
      });
    };
    const a = await confirmOn(fixtureA);
    const b = await confirmOn(fixtureB);
    expect(a.reservationId).not.toBe(b.reservationId);
  });
});
