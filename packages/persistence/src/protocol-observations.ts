import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { protocolObservationSchema, type ProtocolObservation } from "@odft/contracts";

type Queryable = Pick<PoolClient, "query">;

/**
 * Phase 03 safe protocol-observation repository (plan §3.6).
 *
 * Transaction/fence ownership: functions run on the caller's client and open no
 * transaction. Observations are append-only safe records; the optional
 * `application_event_id` link is unique, so bridging an observation to an
 * execution event is idempotent under SSE reconnects.
 */

export interface ProtocolObservationRecord extends ProtocolObservation {
  readonly applicationEventId: string | null;
}

interface ObservationRow {
  id: string;
  source: string;
  kind: string;
  trip_id: string | null;
  operation_id: string | null;
  delegation_id: string | null;
  task_id: string | null;
  context_id: string | null;
  trace_id: string | null;
  payload: unknown;
  payload_hash: string;
  occurred_at: Date;
  application_event_id: string | null;
}

function toRecord(row: ObservationRow): ProtocolObservationRecord {
  const parsed = protocolObservationSchema.parse({
    id: row.id,
    source: row.source,
    kind: row.kind,
    correlation: {
      tripId: row.trip_id,
      operationId: row.operation_id,
      delegationId: row.delegation_id,
      taskId: row.task_id,
      contextId: row.context_id,
      traceId: row.trace_id,
    },
    payload: row.payload,
    occurredAt: row.occurred_at.toISOString(),
    payloadHash: row.payload_hash,
  });
  return { ...parsed, applicationEventId: row.application_event_id };
}

const OBSERVATION_COLUMNS =
  "id, source, kind, trip_id, operation_id, delegation_id, task_id, context_id, trace_id, payload, " +
  "payload_hash, occurred_at, application_event_id";

export async function insertProtocolObservation(
  client: Queryable,
  observation: ProtocolObservation,
): Promise<ProtocolObservationRecord> {
  const parsed = protocolObservationSchema.parse(observation);
  const result = await client.query<ObservationRow>(
    `INSERT INTO odft_app.protocol_observations
       (id, source, kind, trip_id, operation_id, delegation_id, task_id, context_id, trace_id,
        payload, payload_hash, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
     RETURNING ${OBSERVATION_COLUMNS}`,
    [
      parsed.id ?? randomUUID(),
      parsed.source,
      parsed.kind,
      parsed.correlation.tripId,
      parsed.correlation.operationId,
      parsed.correlation.delegationId,
      parsed.correlation.taskId,
      parsed.correlation.contextId,
      parsed.correlation.traceId,
      JSON.stringify(parsed.payload),
      parsed.payloadHash,
      parsed.occurredAt,
    ],
  );
  return toRecord(result.rows[0] as ObservationRow);
}

/**
 * Idempotent observation→application-event link (unique constraint). Linking
 * the same observation to a DIFFERENT event is a programming error and fails
 * loudly instead of silently keeping the old link.
 */
export async function linkObservationToEvent(
  client: Queryable,
  input: { observationId: string; applicationEventId: string },
): Promise<void> {
  const existing = await client.query<{ application_event_id: string | null }>(
    `SELECT application_event_id FROM odft_app.protocol_observations WHERE id = $1`,
    [input.observationId],
  );
  const current = existing.rows[0]?.application_event_id;
  if (current !== null && current !== undefined) {
    if (current !== input.applicationEventId) {
      throw new Error(
        `observation ${input.observationId} is already linked to event ${current}`,
      );
    }
    return;
  }
  const updated = await client.query(
    `UPDATE odft_app.protocol_observations
        SET application_event_id = $2
      WHERE id = $1 AND application_event_id IS NULL`,
    [input.observationId, input.applicationEventId],
  );
  if (updated.rowCount === 0) {
    // Lost a race against a concurrent link: the first link wins, and a
    // different one is an error, never a silent no-op.
    const after = await client.query<{ application_event_id: string | null }>(
      `SELECT application_event_id FROM odft_app.protocol_observations WHERE id = $1`,
      [input.observationId],
    );
    const linked = after.rows[0]?.application_event_id;
    if (linked !== input.applicationEventId) {
      throw new Error(
        `observation ${input.observationId} is already linked to event ${linked ?? "(none)"}`,
      );
    }
  }
}

export async function listUnlinkedObservations(
  client: Queryable,
  limit = 100,
): Promise<ProtocolObservationRecord[]> {
  const result = await client.query<ObservationRow>(
    `SELECT ${OBSERVATION_COLUMNS} FROM odft_app.protocol_observations
      WHERE application_event_id IS NULL
      ORDER BY occurred_at, id
      LIMIT $1`,
    [limit],
  );
  return result.rows.map(toRecord);
}

export async function listObservationsForTrip(
  client: Queryable,
  tripId: string,
  limit = 200,
): Promise<ProtocolObservationRecord[]> {
  const result = await client.query<ObservationRow>(
    `SELECT ${OBSERVATION_COLUMNS} FROM odft_app.protocol_observations
      WHERE trip_id = $1
      ORDER BY occurred_at, id
      LIMIT $2`,
    [tripId, limit],
  );
  return result.rows.map(toRecord);
}
