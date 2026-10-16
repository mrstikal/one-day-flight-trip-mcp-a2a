import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDecision } from "@odft/persistence";
import type { BookingService } from "@odft/domain";
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

/** AC-03-5 / AC-03-8: typed conflicts with no side effects; no payment surface. */

const pool = createTestPool(6);
const FINGERPRINT = "b".repeat(64);

beforeAll(async () => {
  await resetDatabase(pool);
});
afterAll(async () => {
  await pool.end();
});

async function proposalFor(service: BookingService, fixture: BookingFixture, offerId = FIXTURE_HOTEL_OFFER) {
  return service.propose({
    tripId: fixture.tripId,
    sessionId: fixture.sessionId,
    service: "hotel",
    offerId,
    operationId: fixture.operationId,
    sourceFingerprint: FINGERPRINT,
  });
}

async function confirmArgs(fixture: BookingFixture, proposalId: string, decisionId: string) {
  return {
    tripId: fixture.tripId,
    sessionId: fixture.sessionId,
    proposalId,
    decisionId,
    operationId: await createOperation(pool, fixture.tripId),
    acceptedRevision: fixture.revision,
    acceptedDemoDisclaimer: true as const,
    confirmationKey: randomUUID(),
  };
}

async function reservationCount(tripId: string): Promise<number> {
  const result = await pool.query<{ c: number }>(
    "SELECT count(*)::int AS c FROM odft_app.reservations WHERE trip_id = $1",
    [tripId],
  );
  return result.rows[0]?.c ?? -1;
}

describe("confirmation authorization", () => {
  it("rejects a foreign session", async () => {
    const fixture = await createBookingFixture(pool);
    const service = createBookingService(pool);
    const proposal = await proposalFor(service, fixture);
    const decisionId = await createConfirmationDecision(pool, {
      tripId: fixture.tripId,
      proposalId: proposal.proposalId,
      sourceFingerprint: FINGERPRINT,
      allowedOfferIds: [FIXTURE_HOTEL_OFFER],
      revision: fixture.revision,
    });
    await expect(
      service.confirm({ ...(await confirmArgs(fixture, proposal.proposalId, decisionId)), sessionId: randomUUID() }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await reservationCount(fixture.tripId)).toBe(0);
  });

  it("rejects a resolved decision", async () => {
    const fixture = await createBookingFixture(pool);
    const service = createBookingService(pool);
    const proposal = await proposalFor(service, fixture);
    const decisionId = await createConfirmationDecision(pool, {
      tripId: fixture.tripId,
      proposalId: proposal.proposalId,
      sourceFingerprint: FINGERPRINT,
      allowedOfferIds: [FIXTURE_HOTEL_OFFER],
      revision: fixture.revision,
    });
    await resolveDecision(pool, decisionId, "resolved");
    await expect(
      service.confirm(await confirmArgs(fixture, proposal.proposalId, decisionId)),
    ).rejects.toMatchObject({ code: "STALE_DECISION" });
    expect(await reservationCount(fixture.tripId)).toBe(0);
  });

  it("rejects a wrong decision kind", async () => {
    const fixture = await createBookingFixture(pool);
    const service = createBookingService(pool);
    const proposal = await proposalFor(service, fixture);
    const decisionId = await createConfirmationDecision(pool, {
      tripId: fixture.tripId,
      proposalId: proposal.proposalId,
      sourceFingerprint: FINGERPRINT,
      allowedOfferIds: [FIXTURE_HOTEL_OFFER],
      kind: "flight_choice",
      revision: fixture.revision,
    });
    await expect(
      service.confirm(await confirmArgs(fixture, proposal.proposalId, decisionId)),
    ).rejects.toMatchObject({ code: "STALE_DECISION" });
    expect(await reservationCount(fixture.tripId)).toBe(0);
  });

  it("rejects a stale decision fingerprint", async () => {
    const fixture = await createBookingFixture(pool);
    const service = createBookingService(pool);
    const proposal = await proposalFor(service, fixture);
    const decisionId = await createConfirmationDecision(pool, {
      tripId: fixture.tripId,
      proposalId: proposal.proposalId,
      sourceFingerprint: "d".repeat(64),
      allowedOfferIds: [FIXTURE_HOTEL_OFFER],
      revision: fixture.revision,
    });
    await expect(
      service.confirm(await confirmArgs(fixture, proposal.proposalId, decisionId)),
    ).rejects.toMatchObject({ code: "STALE_DECISION" });
    expect(await reservationCount(fixture.tripId)).toBe(0);
  });

  it("rejects an offer that is not in the snapshot", async () => {
    const fixture = await createBookingFixture(pool);
    const service = createBookingService(pool);
    await expect(proposalFor(service, fixture, "DEMO-HOTEL-UNKNOWN")).rejects.toMatchObject({
      code: "OFFER_UNAVAILABLE",
    });
    expect(await reservationCount(fixture.tripId)).toBe(0);
  });

  it("rejects a wrong revision", async () => {
    const fixture = await createBookingFixture(pool);
    const service = createBookingService(pool);
    const proposal = await proposalFor(service, fixture);
    const decisionId = await createConfirmationDecision(pool, {
      tripId: fixture.tripId,
      proposalId: proposal.proposalId,
      sourceFingerprint: FINGERPRINT,
      allowedOfferIds: [FIXTURE_HOTEL_OFFER],
      revision: fixture.revision,
    });
    await expect(
      service.confirm({ ...(await confirmArgs(fixture, proposal.proposalId, decisionId)), acceptedRevision: 99 }),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });
    expect(await reservationCount(fixture.tripId)).toBe(0);
  });

  it("requires the disclaimer acknowledgement", async () => {
    const fixture = await createBookingFixture(pool);
    const service = createBookingService(pool);
    const proposal = await proposalFor(service, fixture);
    const decisionId = await createConfirmationDecision(pool, {
      tripId: fixture.tripId,
      proposalId: proposal.proposalId,
      sourceFingerprint: FINGERPRINT,
      allowedOfferIds: [FIXTURE_HOTEL_OFFER],
      revision: fixture.revision,
    });
    await expect(
      service.confirm({
        ...(await confirmArgs(fixture, proposal.proposalId, decisionId)),
        acceptedDemoDisclaimer: false as unknown as true,
      }),
    ).rejects.toMatchObject({ code: "DISCLAIMER_REQUIRED" });
    expect(await reservationCount(fixture.tripId)).toBe(0);
  });

  it("rejects an offer that is not among the decision's allowed offers", async () => {
    const fixture = await createBookingFixture(pool);
    const service = createBookingService(pool);
    const proposal = await proposalFor(service, fixture);
    const decisionId = await createConfirmationDecision(pool, {
      tripId: fixture.tripId,
      proposalId: proposal.proposalId,
      sourceFingerprint: FINGERPRINT,
      allowedOfferIds: ["DEMO-HOTEL-2"],
      revision: fixture.revision,
    });
    await expect(
      service.confirm(await confirmArgs(fixture, proposal.proposalId, decisionId)),
    ).rejects.toMatchObject({ code: "STALE_DECISION" });
    expect(await reservationCount(fixture.tripId)).toBe(0);
  });

  it("rejects confirmation for a failed operation", async () => {
    const fixture = await createBookingFixture(pool);
    const service = createBookingService(pool);
    const proposal = await proposalFor(service, fixture);
    const decisionId = await createConfirmationDecision(pool, {
      tripId: fixture.tripId,
      proposalId: proposal.proposalId,
      sourceFingerprint: FINGERPRINT,
      allowedOfferIds: [FIXTURE_HOTEL_OFFER],
      revision: fixture.revision,
    });
    const operationId = await createOperation(pool, fixture.tripId);
    await pool.query("UPDATE odft_app.workflow_operations SET status = 'failed' WHERE id = $1", [
      operationId,
    ]);
    await expect(
      service.confirm({
        tripId: fixture.tripId,
        sessionId: fixture.sessionId,
        proposalId: proposal.proposalId,
        decisionId,
        operationId,
        acceptedRevision: fixture.revision,
        acceptedDemoDisclaimer: true,
        confirmationKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await reservationCount(fixture.tripId)).toBe(0);
  });

  it("has no payment columns or payment-intent code", async () => {
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'odft_app'
          AND (column_name ~* '(payment|card|cvv|iban|billing)')`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([]);

    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const violations: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next") continue;
          await walk(full);
        } else if (full.endsWith(".ts")) {
          const content = await readFile(full, "utf8");
          if (/payment_?intent|stripe|braintree|adyen|paypal/i.test(content)) {
            violations.push(full);
          }
        }
      }
    }
    for (const packageDir of ["packages", "apps"]) {
      await walk(`${repoRoot}${packageDir}`);
    }
    expect(violations).toEqual([]);
  });
});
