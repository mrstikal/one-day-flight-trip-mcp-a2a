import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { delegationScopeSchema, type DelegationStatus, type OutboundDeliveryState } from "@odft/contracts";

type Queryable = Pick<PoolClient, "query">;

/**
 * Phase 03 delegation/outbound-message repository (plan §3.6/§3.7).
 *
 * Transaction/fence ownership: functions run on the caller's client and open no
 * transaction. The coordinator persists a delegation and its outbound message
 * BEFORE the first HTTP request in one short transaction; this repository only
 * reads/writes the rows.
 */

export interface AgentDelegationRecord {
  readonly id: string;
  readonly tripId: string;
  readonly originatingOperationId: string;
  readonly currentOperationId: string | null;
  readonly acceptedRevision: number;
  readonly skillId: string;
  readonly agentIdentity: string;
  readonly endpointUrl: string;
  readonly cardVersion: string | null;
  readonly snapshotId: string;
  readonly inputFingerprint: string;
  readonly scope: unknown;
  readonly taskId: string | null;
  readonly contextId: string | null;
  readonly status: DelegationStatus;
  readonly deadlineAt: string | null;
  readonly attempt: number;
  readonly revokedAt: string | null;
  readonly revokeReason: string | null;
  readonly acceptedArtifactHash: string | null;
  readonly cancellationRequestedAt: string | null;
  readonly cancellationState: "pending" | "acknowledged" | "failed" | null;
  /** Phase 09 cancel outbox: SDK cancel attempts so far (bounded retries). */
  readonly cancellationAttempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface DelegationRow {
  id: string;
  trip_id: string;
  originating_operation_id: string;
  current_operation_id: string | null;
  accepted_revision: number;
  skill_id: string;
  agent_identity: string;
  endpoint_url: string;
  card_version: string | null;
  snapshot_id: string;
  input_fingerprint: string;
  scope: unknown;
  task_id: string | null;
  context_id: string | null;
  status: DelegationStatus;
  deadline_at: Date | null;
  attempt: number;
  revoked_at: Date | null;
  revoke_reason: string | null;
  accepted_artifact_hash: string | null;
  cancellation_requested_at: Date | null;
  cancellation_state: "pending" | "acknowledged" | "failed" | null;
  cancellation_attempts: number;
  created_at: Date;
  updated_at: Date;
}

const DELEGATION_COLUMNS =
  "id, trip_id, originating_operation_id, current_operation_id, accepted_revision, skill_id, agent_identity, " +
  "endpoint_url, card_version, snapshot_id, input_fingerprint, scope, task_id, context_id, status, deadline_at, " +
  "attempt, revoked_at, revoke_reason, accepted_artifact_hash, cancellation_requested_at, cancellation_state, " +
  "cancellation_attempts, " +
  "created_at, updated_at";

function toRecord(row: DelegationRow): AgentDelegationRecord {
  return {
    id: row.id,
    tripId: row.trip_id,
    originatingOperationId: row.originating_operation_id,
    currentOperationId: row.current_operation_id,
    acceptedRevision: row.accepted_revision,
    skillId: row.skill_id,
    agentIdentity: row.agent_identity,
    endpointUrl: row.endpoint_url,
    cardVersion: row.card_version,
    snapshotId: row.snapshot_id,
    inputFingerprint: row.input_fingerprint,
    scope: row.scope,
    taskId: row.task_id,
    contextId: row.context_id,
    status: row.status,
    deadlineAt: row.deadline_at ? row.deadline_at.toISOString() : null,
    attempt: row.attempt,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
    revokeReason: row.revoke_reason,
    acceptedArtifactHash: row.accepted_artifact_hash,
    cancellationRequestedAt: row.cancellation_requested_at
      ? row.cancellation_requested_at.toISOString()
      : null,
    cancellationState: row.cancellation_state,
    cancellationAttempts: row.cancellation_attempts ?? 0,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface InsertDelegationInput {
  readonly id?: string;
  readonly tripId: string;
  readonly originatingOperationId: string;
  readonly acceptedRevision: number;
  readonly skillId: string;
  readonly agentIdentity: string;
  readonly endpointUrl: string;
  readonly cardVersion?: string;
  readonly snapshotId: string;
  readonly inputFingerprint: string;
  readonly scope: unknown;
  readonly deadlineAt?: string;
  readonly attempt?: number;
}

export async function insertAgentDelegation(
  client: Queryable,
  input: InsertDelegationInput,
): Promise<AgentDelegationRecord> {
  // A malformed scope must fail at write time, not later as an MCP argument
  // error: the persisted scope is the delegation's authority.
  const scope = delegationScopeSchema.parse(input.scope ?? {});
  const result = await client.query<DelegationRow>(
    `INSERT INTO odft_app.agent_delegations
       (id, trip_id, originating_operation_id, accepted_revision, skill_id, agent_identity, endpoint_url,
        card_version, snapshot_id, input_fingerprint, scope, deadline_at, attempt)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
     RETURNING ${DELEGATION_COLUMNS}`,
    [
      input.id ?? randomUUID(),
      input.tripId,
      input.originatingOperationId,
      input.acceptedRevision,
      input.skillId,
      input.agentIdentity,
      input.endpointUrl,
      input.cardVersion ?? null,
      input.snapshotId,
      input.inputFingerprint,
      JSON.stringify(scope),
      input.deadlineAt ?? null,
      input.attempt ?? 1,
    ],
  );
  return toRecord(result.rows[0] as DelegationRow);
}

export async function getAgentDelegation(
  client: Queryable,
  delegationId: string,
): Promise<AgentDelegationRecord | undefined> {
  const result = await client.query<DelegationRow>(
    `SELECT ${DELEGATION_COLUMNS} FROM odft_app.agent_delegations WHERE id = $1`,
    [delegationId],
  );
  const row = result.rows[0];
  return row ? toRecord(row) : undefined;
}

export async function listOutstandingDelegations(
  client: Queryable,
  tripId: string,
): Promise<AgentDelegationRecord[]> {
  const result = await client.query<DelegationRow>(
    `SELECT ${DELEGATION_COLUMNS} FROM odft_app.agent_delegations
      WHERE trip_id = $1 AND status IN ('pending','dispatched','working','input_required')
      ORDER BY created_at`,
    [tripId],
  );
  return result.rows.map(toRecord);
}

/** Persist the canonical SDK task/context mapping of a dispatched delegation. */
/** Mark a completed artifact accepted without ever resurrecting terminal rows. */
export async function acceptDelegationArtifact(
  client: Queryable,
  input: { delegationId: string; artifactHash: string },
): Promise<boolean> {
  const result = await client.query(
    `UPDATE odft_app.agent_delegations
        SET status = 'completed', accepted_artifact_hash = $2, updated_at = now()
      WHERE id = $1 AND status NOT IN ('revoked','failed','cancelled')`,
    [input.delegationId, input.artifactHash],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function bindDelegationTask(
  client: Queryable,
  input: { delegationId: string; taskId: string; contextId: string; status?: DelegationStatus },
): Promise<void> {
  await client.query(
    `UPDATE odft_app.agent_delegations
        SET task_id = COALESCE(task_id, $2),
            context_id = COALESCE(context_id, $3),
            status = CASE
              WHEN status IN ('revoked','failed','cancelled','completed') THEN status
              ELSE COALESCE($4, 'working')
            END,
            updated_at = now()
      WHERE id = $1`,
    [input.delegationId, input.taskId, input.contextId, input.status ?? null],
  );
}

export async function revokeDelegation(
  client: Queryable,
  input: { delegationId: string; reason: string },
): Promise<void> {
  await client.query(
    `UPDATE odft_app.agent_delegations
        SET status = 'revoked', revoked_at = now(), revoke_reason = $2, updated_at = now()
      WHERE id = $1 AND status NOT IN ('completed','cancelled','revoked')`,
    [input.delegationId, input.reason],
  );
}

/** Durable remote-cancel intent; the SDK cancellation happens after commit. */
export async function requestDelegationCancellation(
  client: Queryable,
  delegationId: string,
): Promise<void> {
  await client.query(
    `UPDATE odft_app.agent_delegations
        SET cancellation_requested_at = COALESCE(cancellation_requested_at, now()),
            cancellation_state = COALESCE(cancellation_state, 'pending'),
            updated_at = now()
      WHERE id = $1`,
    [delegationId],
  );
}

export interface PendingDelegationCancel {
  readonly delegationId: string;
  readonly agentIdentity: string;
  readonly tripId: string;
  readonly taskId: string | null;
  readonly contextId: string | null;
  readonly attempts: number;
}

/**
 * Phase 09 cancel outbox: delegations whose remote SDK cancellation was
 * persisted as an intent but never reconciled. The reconciler processes them
 * independently of the (already cancelled) operation claim with bounded
 * retries; the final outcome (`acknowledged`/`failed`) is rendered in the
 * inspector.
 */
export async function listPendingDelegationCancels(
  client: Queryable,
  limit = 50,
): Promise<PendingDelegationCancel[]> {
  const result = await client.query<{
    id: string;
    agent_identity: string;
    trip_id: string;
    task_id: string | null;
    context_id: string | null;
    cancellation_attempts: number;
  }>(
    `SELECT id, agent_identity, trip_id, task_id, context_id, cancellation_attempts
       FROM odft_app.agent_delegations
      WHERE cancellation_state = 'pending'
      ORDER BY cancellation_attempts ASC, cancellation_requested_at NULLS LAST, created_at
      LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    delegationId: row.id,
    agentIdentity: row.agent_identity,
    tripId: row.trip_id,
    taskId: row.task_id,
    contextId: row.context_id,
    attempts: row.cancellation_attempts ?? 0,
  }));
}

/** Record one failed SDK cancel attempt (bounded retries stay `pending`). */
export async function noteDelegationCancelAttempt(
  client: Queryable,
  delegationId: string,
): Promise<void> {
  await client.query(
    `UPDATE odft_app.agent_delegations
        SET cancellation_attempts = cancellation_attempts + 1, updated_at = now()
      WHERE id = $1 AND cancellation_state = 'pending'`,
    [delegationId],
  );
}

/**
 * Claim one pending cancel intent for this reconciler before dispatching the
 * SDK call: the guarded UPDATE returns false when a concurrent reconciler
 * already claimed (or settled) the intent, so the loser skips the transport
 * call instead of double-dispatching `cancelTask` and double-counting.
 */
export async function claimDelegationCancel(
  client: Queryable,
  delegationId: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE odft_app.agent_delegations
        SET cancellation_attempts = cancellation_attempts + 1, updated_at = now()
      WHERE id = $1 AND cancellation_state = 'pending'
      RETURNING id`,
    [delegationId],
  );
  return (result.rowCount ?? 0) === 1;
}

/** Record the reconciled remote-cancel outcome (inspector evidence). */
export async function resolveDelegationCancellation(
  client: Queryable,
  input: { delegationId: string; state: "acknowledged" | "failed" },
): Promise<void> {
  await client.query(
    `UPDATE odft_app.agent_delegations
        SET cancellation_state = $2, updated_at = now()
      WHERE id = $1 AND cancellation_state = 'pending'`,
    [input.delegationId, input.state],
  );
}

/* ---- Durable outbound messages ------------------------------------------------ */

export interface OutboundMessageRecord {
  readonly id: string;
  readonly delegationId: string;
  readonly messageId: string;
  readonly payloadHash: string;
  readonly payload: unknown;
  readonly deliveryState: OutboundDeliveryState;
  readonly continuationGeneration: number;
  readonly attempt: number;
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
}

interface OutboundRow {
  id: string;
  delegation_id: string;
  message_id: string;
  payload_hash: string;
  payload: unknown;
  delivery_state: OutboundDeliveryState;
  continuation_generation: number;
  attempt: number;
  last_error_code: string | null;
  created_at: Date;
  delivered_at: Date | null;
}

const OUTBOUND_COLUMNS =
  "id, delegation_id, message_id, payload_hash, payload, delivery_state, continuation_generation, " +
  "attempt, last_error_code, created_at, delivered_at";

function toOutboundRecord(row: OutboundRow): OutboundMessageRecord {
  return {
    id: row.id,
    delegationId: row.delegation_id,
    messageId: row.message_id,
    payloadHash: row.payload_hash,
    payload: row.payload,
    deliveryState: row.delivery_state,
    continuationGeneration: row.continuation_generation,
    attempt: row.attempt,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at.toISOString(),
    deliveredAt: row.delivered_at ? row.delivered_at.toISOString() : null,
  };
}

export interface InsertOutboundMessageInput {
  readonly id?: string;
  readonly delegationId: string;
  readonly messageId: string;
  readonly payloadHash: string;
  readonly payload: unknown;
  readonly continuationGeneration?: number;
  readonly attempt?: number;
}

/**
 * Persist an outbound message before its first HTTP request. A repeated
 * `(delegationId, messageId)` with a different payload hash is a conflict and
 * must never be sent.
 */
export async function insertOutboundMessage(
  client: Queryable,
  input: InsertOutboundMessageInput,
): Promise<{ record: OutboundMessageRecord; conflict: boolean }> {
  // ON CONFLICT DO NOTHING + re-select: two concurrent inserts of the same
  // (delegation, message) resolve to the stored row instead of a unique error.
  const inserted = await client.query<OutboundRow>(
    `INSERT INTO odft_app.protocol_outbound_messages
       (id, delegation_id, message_id, payload_hash, payload, continuation_generation, attempt)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     ON CONFLICT (delegation_id, message_id) DO NOTHING
     RETURNING ${OUTBOUND_COLUMNS}`,
    [
      input.id ?? randomUUID(),
      input.delegationId,
      input.messageId,
      input.payloadHash,
      JSON.stringify(input.payload),
      input.continuationGeneration ?? 1,
      input.attempt ?? 1,
    ],
  );
  if (inserted.rows[0]) {
    return { record: toOutboundRecord(inserted.rows[0]), conflict: false };
  }
  const existing = await client.query<OutboundRow>(
    `SELECT ${OUTBOUND_COLUMNS} FROM odft_app.protocol_outbound_messages
      WHERE delegation_id = $1 AND message_id = $2`,
    [input.delegationId, input.messageId],
  );
  const row = existing.rows[0];
  if (!row) {
    throw new Error(
      `outbound message ${input.messageId} vanished between insert and re-read`,
    );
  }
  return { record: toOutboundRecord(row), conflict: row.payload_hash !== input.payloadHash };
}

export async function getOutboundMessage(
  client: Queryable,
  delegationId: string,
  messageId: string,
): Promise<OutboundMessageRecord | undefined> {
  const result = await client.query<OutboundRow>(
    `SELECT ${OUTBOUND_COLUMNS} FROM odft_app.protocol_outbound_messages
      WHERE delegation_id = $1 AND message_id = $2`,
    [delegationId, messageId],
  );
  const row = result.rows[0];
  return row ? toOutboundRecord(row) : undefined;
}

export async function markOutboundDelivery(
  client: Queryable,
  input: {
    delegationId: string;
    messageId: string;
    state: OutboundDeliveryState;
    errorCode?: string;
  },
): Promise<void> {
  await client.query(
    `UPDATE odft_app.protocol_outbound_messages
        SET delivery_state = $3,
            delivered_at = CASE WHEN $3 IN ('delivered','acknowledged') THEN COALESCE(delivered_at, now()) ELSE delivered_at END,
            last_error_code = $4
      WHERE delegation_id = $1 AND message_id = $2`,
    [input.delegationId, input.messageId, input.state, input.errorCode ?? null],
  );
}

/** Newest active delegation of an identity for one frozen snapshot (Phase 04). */
export async function findActiveDelegationForSnapshot(
  client: Queryable,
  input: { agentIdentity: string; snapshotId: string },
): Promise<string | undefined> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM odft_app.agent_delegations
      WHERE agent_identity = $1 AND snapshot_id = $2
        AND status NOT IN ('revoked','cancelled','failed')
      ORDER BY created_at DESC LIMIT 1`,
    [input.agentIdentity, input.snapshotId],
  );
  return result.rows[0]?.id;
}
