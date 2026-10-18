import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { DecisionBindingRecord, DecisionKind, Engine } from "@odft/contracts";

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
  option_payload?: unknown;
  engine?: Engine;
  coordinator_run_id?: string | null;
}

export async function loadDecision(
  client: Queryable,
  decisionId: string,
): Promise<DecisionBindingRecord | undefined> {
  const result = await client.query<DecisionRow>(
    `SELECT id, trip_id, kind, proposal_id, status, source_fingerprint, allowed_offer_ids, allowed_option_ids,
            option_payload, engine, coordinator_run_id
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
    allowedOfferIds: Array.isArray(row.allowed_offer_ids)
      ? (row.allowed_offer_ids as string[])
      : [],
    allowedOptionIds: Array.isArray(row.allowed_option_ids)
      ? (row.allowed_option_ids as string[])
      : [],
    ...(row.option_payload !== undefined && row.option_payload !== null
      ? { optionPayload: row.option_payload }
      : {}),
    ...(row.engine ? { engine: row.engine } : {}),
    ...(row.coordinator_run_id ? { coordinatorRunId: row.coordinator_run_id } : {}),
  };
}

export interface InsertDecisionInput {
  readonly id?: string;
  readonly tripId: string;
  readonly kind: DecisionKind;
  /** Phase 03: engine binding; graph decisions require threadId/graphVersion. */
  readonly engine?: Engine;
  readonly threadId?: string;
  readonly graphVersion?: string;
  readonly coordinatorRunId?: string;
  readonly createdRevision: number;
  readonly sourceFingerprint: string;
  readonly payloadHash: string;
  readonly proposalId?: string;
  readonly allowedOfferIds?: string[];
  readonly allowedOptionIds?: string[];
  /** Persisted option payload (e.g. the `agent_input` question contract). */
  readonly optionPayload?: unknown;
  readonly status?: "pending" | "resolved" | "cancelled";
}

export async function insertDecision(
  client: Queryable,
  input: InsertDecisionInput,
): Promise<string> {
  const id = input.id ?? randomUUID();
  await client.query(
    `INSERT INTO odft_app.pending_decisions
       (id, trip_id, kind, engine, thread_id, graph_version, coordinator_run_id, created_revision,
        source_fingerprint, proposal_id, allowed_offer_ids, allowed_option_ids, option_payload, payload_hash, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15)`,
    [
      id,
      input.tripId,
      input.kind,
      input.engine ?? "coordinator-v1",
      input.threadId ?? null,
      input.graphVersion ?? null,
      input.coordinatorRunId ?? null,
      input.createdRevision,
      input.sourceFingerprint,
      input.proposalId ?? null,
      JSON.stringify(input.allowedOfferIds ?? []),
      JSON.stringify(input.allowedOptionIds ?? []),
      input.optionPayload === undefined ? JSON.stringify([]) : JSON.stringify(input.optionPayload),
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
    `SELECT id, trip_id, kind, proposal_id, status, source_fingerprint, allowed_offer_ids, allowed_option_ids,
            engine, coordinator_run_id
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
    allowedOfferIds: Array.isArray(row.allowed_offer_ids)
      ? (row.allowed_offer_ids as string[])
      : [],
    allowedOptionIds: Array.isArray(row.allowed_option_ids)
      ? (row.allowed_option_ids as string[])
      : [],
    ...(row.option_payload !== undefined && row.option_payload !== null
      ? { optionPayload: row.option_payload }
      : {}),
    ...(row.engine ? { engine: row.engine } : {}),
    ...(row.coordinator_run_id ? { coordinatorRunId: row.coordinator_run_id } : {}),
  };
}
