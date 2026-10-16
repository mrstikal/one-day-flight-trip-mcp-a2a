import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { DecisionBindingRecord, DecisionKind } from "@odft/contracts";

type Queryable = Pick<PoolClient, "query">;

interface DecisionRow {
  id: string;
  trip_id: string;
  kind: DecisionKind;
  proposal_id: string | null;
  status: "pending" | "resolved" | "cancelled";
  source_fingerprint: string;
  allowed_offer_ids: unknown;
  allowed_option_ids?: unknown;
}

export async function loadDecision(
  client: Queryable,
  decisionId: string,
): Promise<DecisionBindingRecord | undefined> {
  const result = await client.query<DecisionRow>(
    `SELECT id, trip_id, kind, proposal_id, status, source_fingerprint, allowed_offer_ids, allowed_option_ids
       FROM odft_app.pending_decisions WHERE id = $1`,
    [decisionId],
  );
  const row = result.rows[0];
  if (!row) {
    return undefined;
  }
  return {
    id: row.id,
    tripId: row.trip_id,
    kind: row.kind,
    ...(row.proposal_id ? { proposalId: row.proposal_id } : {}),
    status: row.status,
    sourceFingerprint: row.source_fingerprint,
    allowedOfferIds: Array.isArray(row.allowed_offer_ids) ? (row.allowed_offer_ids as string[]) : [],
    allowedOptionIds: Array.isArray(row.allowed_option_ids)
      ? (row.allowed_option_ids as string[])
      : [],
  };
}

export interface InsertDecisionInput {
  readonly id?: string;
  readonly tripId: string;
  readonly kind: DecisionKind;
  readonly threadId: string;
  readonly graphVersion: string;
  readonly createdRevision: number;
  readonly sourceFingerprint: string;
  readonly payloadHash: string;
  readonly proposalId?: string;
  readonly allowedOfferIds?: string[];
  readonly allowedOptionIds?: string[];
  readonly status?: "pending" | "resolved" | "cancelled";
}

export async function insertDecision(client: Queryable, input: InsertDecisionInput): Promise<string> {
  const id = input.id ?? randomUUID();
  await client.query(
    `INSERT INTO odft_app.pending_decisions
       (id, trip_id, kind, thread_id, graph_version, created_revision, source_fingerprint, proposal_id,
        allowed_offer_ids, allowed_option_ids, payload_hash, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12)`,
    [
      id,
      input.tripId,
      input.kind,
      input.threadId,
      input.graphVersion,
      input.createdRevision,
      input.sourceFingerprint,
      input.proposalId ?? null,
      JSON.stringify(input.allowedOfferIds ?? []),
      JSON.stringify(input.allowedOptionIds ?? []),
      input.payloadHash,
      input.status ?? "pending",
    ],
  );
  return id;
}

export async function resolveDecision(
  client: Queryable,
  decisionId: string,
  status: "resolved" | "cancelled",
): Promise<void> {
  await client.query(
    `UPDATE odft_app.pending_decisions SET status = $2, resolved_at = now() WHERE id = $1`,
    [decisionId, status],
  );
}

/** The single current pending decision for a trip, if any. */
export async function getPendingDecisionForTrip(
  client: Queryable,
  tripId: string,
): Promise<DecisionBindingRecord | undefined> {
  const result = await client.query<DecisionRow>(
    `SELECT id, trip_id, kind, proposal_id, status, source_fingerprint, allowed_offer_ids, allowed_option_ids
       FROM odft_app.pending_decisions
      WHERE trip_id = $1 AND status = 'pending'
      LIMIT 1`,
    [tripId],
  );
  const row = result.rows[0];
  if (!row) {
    return undefined;
  }
  return {
    id: row.id,
    tripId: row.trip_id,
    kind: row.kind,
    ...(row.proposal_id ? { proposalId: row.proposal_id } : {}),
    status: row.status,
    sourceFingerprint: row.source_fingerprint,
    allowedOfferIds: Array.isArray(row.allowed_offer_ids) ? (row.allowed_offer_ids as string[]) : [],
    allowedOptionIds: Array.isArray(row.allowed_option_ids)
      ? (row.allowed_option_ids as string[])
      : [],
  };
}
