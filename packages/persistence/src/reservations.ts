import type { PoolClient } from "pg";
import type { BookableKey, InsertReservationInput, ReservationRecord, ReservationStatus } from "@odft/contracts";

type Queryable = Pick<PoolClient, "query">;

interface ReservationRow {
  id: string;
  trip_id: string;
  service_key: BookableKey;
  offer_id: string;
  snapshot_id: string;
  status: ReservationStatus;
  demo_reference: string;
  confirmation_key: string;
  proposal_id: string;
  decision_id: string;
  terms_hash: string;
  party_total_minor: number;
}

const RESERVATION_COLUMNS =
  "id, trip_id, service_key, offer_id, snapshot_id, status, demo_reference, confirmation_key, proposal_id, decision_id, terms_hash, party_total_minor";

function toReservation(row: ReservationRow): ReservationRecord {
  return {
    id: row.id,
    tripId: row.trip_id,
    serviceKey: row.service_key,
    offerId: row.offer_id,
    snapshotId: row.snapshot_id,
    status: row.status,
    demoReference: row.demo_reference,
    confirmationKey: row.confirmation_key,
    proposalId: row.proposal_id,
    decisionId: row.decision_id,
    termsHash: row.terms_hash,
    partyTotalMinor: row.party_total_minor,
  };
}

/** Raised when bounded demo-reference generation cannot find a unique value. */
export class RefGenerationFailedError extends Error {
  readonly code = "REF_GENERATION_FAILED";
  constructor() {
    super("demo reference generation exhausted its attempts");
    this.name = "RefGenerationFailedError";
  }
}

export async function getActiveReservation(
  client: Queryable,
  tripId: string,
  serviceKey: BookableKey,
): Promise<ReservationRecord | undefined> {
  const result = await client.query<ReservationRow>(
    `SELECT ${RESERVATION_COLUMNS} FROM odft_app.reservations
      WHERE trip_id = $1 AND service_key = $2 AND status = 'confirmed'`,
    [tripId, serviceKey],
  );
  const row = result.rows[0];
  return row ? toReservation(row) : undefined;
}

export async function getReservationByConfirmationKey(
  client: Queryable,
  tripId: string,
  confirmationKey: string,
): Promise<ReservationRecord | undefined> {
  const result = await client.query<ReservationRow>(
    `SELECT ${RESERVATION_COLUMNS} FROM odft_app.reservations
      WHERE trip_id = $1 AND confirmation_key = $2`,
    [tripId, confirmationKey],
  );
  const row = result.rows[0];
  return row ? toReservation(row) : undefined;
}

export async function getReservationByReference(
  client: Queryable,
  demoReference: string,
): Promise<ReservationRecord | undefined> {
  const result = await client.query<ReservationRow>(
    `SELECT ${RESERVATION_COLUMNS} FROM odft_app.reservations WHERE demo_reference = $1`,
    [demoReference],
  );
  const row = result.rows[0];
  return row ? toReservation(row) : undefined;
}

export async function supersedeReservation(
  client: Queryable,
  reservationId: string,
  supersededBy?: string,
): Promise<void> {
  await client.query(
    `UPDATE odft_app.reservations
        SET status = 'superseded', superseded_by = $2, updated_at = now()
      WHERE id = $1 AND status = 'confirmed'`,
    [reservationId, supersededBy ?? null],
  );
}

function isReferenceUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === "23505" && candidate.constraint === "reservations_demo_reference_key";
}

/**
 * Insert a confirmed reservation, generating its demo reference inside a
 * SAVEPOINT and retrying only on a reference-specific unique violation. Other
 * unique violations propagate; exhaustion rolls back to the savepoint and
 * throws `RefGenerationFailedError`, leaving the outer transaction intact.
 */
export async function insertReservationWithGeneratedReference(
  client: Queryable,
  input: InsertReservationInput,
  generateReference: (service: BookableKey) => string,
  attempts: number,
): Promise<ReservationRecord> {
  const id = input.id;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const reference = generateReference(input.serviceKey);
    await client.query("SAVEPOINT ref_gen");
    try {
      const result = await client.query<ReservationRow>(
        `INSERT INTO odft_app.reservations
           (id, trip_id, service_key, offer_id, snapshot_id, status, demo_reference, confirmation_key,
            proposal_id, decision_id, terms_hash, terms, disclaimer_acknowledged, party_total_minor)
         VALUES ($1, $2, $3, $4, $5, 'confirmed', $6, $7, $8, $9, $10, $11::jsonb, true, $12)
         RETURNING ${RESERVATION_COLUMNS}`,
        [
          id,
          input.tripId,
          input.serviceKey,
          input.offerId,
          input.snapshotId,
          reference,
          input.confirmationKey,
          input.proposalId,
          input.decisionId,
          input.termsHash,
          JSON.stringify(input.terms),
          input.partyTotalMinor,
        ],
      );
      await client.query("RELEASE SAVEPOINT ref_gen");
      return toReservation(result.rows[0] as ReservationRow);
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT ref_gen");
      if (isReferenceUniqueViolation(error)) {
        continue;
      }
      throw error;
    }
  }
  throw new RefGenerationFailedError();
}
