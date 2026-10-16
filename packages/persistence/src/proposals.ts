import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { BookableKey, InsertProposalInput, ProposalRecord, ProposalStatus } from "@odft/contracts";

type Queryable = Pick<PoolClient, "query">;

interface ProposalRow {
  id: string;
  trip_id: string;
  service_key: BookableKey;
  offer_id: string;
  snapshot_id: string;
  status: ProposalStatus;
  party_total_minor: number;
  expires_at: Date;
  source_fingerprint: string;
}

function toProposal(row: ProposalRow): ProposalRecord {
  return {
    id: row.id,
    tripId: row.trip_id,
    serviceKey: row.service_key,
    offerId: row.offer_id,
    snapshotId: row.snapshot_id,
    status: row.status,
    partyTotalMinor: row.party_total_minor,
    expiresAt: new Date(row.expires_at).toISOString(),
    sourceFingerprint: row.source_fingerprint,
  };
}

const PROPOSAL_COLUMNS =
  "id, trip_id, service_key, offer_id, snapshot_id, status, party_total_minor, expires_at, source_fingerprint";

export async function insertProposal(
  client: Queryable,
  input: InsertProposalInput,
): Promise<ProposalRecord> {
  const result = await client.query<ProposalRow>(
    `INSERT INTO odft_app.selection_proposals
       (id, trip_id, service_key, offer_id, snapshot_id, status, party_total_minor, expires_at,
        created_revision, source_fingerprint, impact)
     VALUES ($1, $2, $3, $4, $5, 'proposed', $6, $7,
        (SELECT revision FROM odft_app.trips WHERE id = $2), $8, '{}'::jsonb)
     RETURNING ${PROPOSAL_COLUMNS}`,
    [
      randomUUID(),
      input.tripId,
      input.serviceKey,
      input.offerId,
      input.snapshotId,
      input.partyTotalMinor,
      input.expiresAt,
      input.sourceFingerprint,
    ],
  );
  return toProposal(result.rows[0] as ProposalRow);
}

export async function getProposal(
  client: Queryable,
  tripId: string,
  proposalId: string,
): Promise<ProposalRecord | undefined> {
  const result = await client.query<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS} FROM odft_app.selection_proposals WHERE trip_id = $1 AND id = $2`,
    [tripId, proposalId],
  );
  const row = result.rows[0];
  return row ? toProposal(row) : undefined;
}

export async function markProposalResolved(
  client: Queryable,
  proposalId: string,
  status: ProposalStatus,
): Promise<void> {
  await client.query(
    `UPDATE odft_app.selection_proposals
        SET status = $2, resolved_at = now()
      WHERE id = $1 AND status = 'proposed'`,
    [proposalId, status],
  );
}
