import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { OperationRecord, OperationRef, OperationStatus } from "@odft/contracts";

type Queryable = Pick<PoolClient, "query">;

interface OperationRow {
  id: string;
  trip_id: string;
  request_id: string;
  payload_hash: string;
  accepted_revision: number;
  status: OperationStatus;
  attempts: number;
}

function toOperationRecord(row: OperationRow): OperationRecord {
  return {
    id: row.id,
    tripId: row.trip_id,
    requestId: row.request_id,
    payloadHash: row.payload_hash,
    acceptedRevision: row.accepted_revision,
    status: row.status,
    attempts: row.attempts,
  };
}

export interface InsertOperationInput {
  readonly tripId: string;
  readonly requestId: string;
  readonly payloadHash: string;
  readonly acceptedRevision: number;
  readonly kind: "command" | "creation" | "decision";
  readonly payload: unknown;
  readonly id?: string;
  readonly status?: OperationStatus;
}

export async function insertOperation(
  client: Queryable,
  input: InsertOperationInput,
): Promise<OperationRecord> {
  const result = await client.query<OperationRow>(
    `INSERT INTO odft_app.workflow_operations
       (id, trip_id, request_id, payload_hash, accepted_revision, status, kind, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING id, trip_id, request_id, payload_hash, accepted_revision, status, attempts`,
    [
      input.id ?? randomUUID(),
      input.tripId,
      input.requestId,
      input.payloadHash,
      input.acceptedRevision,
      input.status ?? "queued",
      input.kind,
      JSON.stringify(input.payload),
    ],
  );
  return toOperationRecord(result.rows[0] as OperationRow);
}

export interface StoredOperation {
  readonly record: OperationRecord;
  readonly payload: unknown;
  readonly result: unknown;
}

export async function getOperationByRequestId(
  client: Queryable,
  tripId: string,
  requestId: string,
): Promise<StoredOperation | undefined> {
  const result = await client.query<OperationRow & { payload: unknown; result: unknown }>(
    `SELECT id, trip_id, request_id, payload_hash, accepted_revision, status, attempts, payload, result
       FROM odft_app.workflow_operations WHERE trip_id = $1 AND request_id = $2`,
    [tripId, requestId],
  );
  const row = result.rows[0];
  return row ? { record: toOperationRecord(row), payload: row.payload, result: row.result } : undefined;
}

export async function getActiveOperation(
  client: Queryable,
  tripId: string,
): Promise<OperationRecord | undefined> {
  const result = await client.query<OperationRow>(
    `SELECT id, trip_id, request_id, payload_hash, accepted_revision, status, attempts
       FROM odft_app.workflow_operations
      WHERE trip_id = $1 AND status IN ('queued', 'running')`,
    [tripId],
  );
  const row = result.rows[0];
  return row ? toOperationRecord(row) : undefined;
}

export async function setOperationStatus(
  client: Queryable,
  operationId: string,
  status: OperationStatus,
  result?: unknown,
): Promise<void> {
  await client.query(
    `UPDATE odft_app.workflow_operations
        SET status = $2, result = $3::jsonb, updated_at = now()
      WHERE id = $1`,
    [operationId, status, result === undefined ? null : JSON.stringify(result)],
  );
}

/** Load an operation by id for confirmation fencing checks. */
export async function loadOperationById(
  client: Queryable,
  operationId: string,
): Promise<OperationRef | undefined> {
  const result = await client.query<{
    id: string;
    trip_id: string;
    status: string;
    accepted_revision: number;
  }>(
    `SELECT id, trip_id, status, accepted_revision FROM odft_app.workflow_operations WHERE id = $1`,
    [operationId],
  );
  const row = result.rows[0];
  return row
    ? { id: row.id, tripId: row.trip_id, status: row.status, acceptedRevision: row.accepted_revision }
    : undefined;
}

/** The admitted payload of an operation (used by the internal `modify` branch). */
export async function getOperationPayload(
  client: Queryable,
  operationId: string,
): Promise<unknown | undefined> {
  const result = await client.query<{ payload: unknown }>(
    `SELECT payload FROM odft_app.workflow_operations WHERE id = $1`,
    [operationId],
  );
  return result.rows[0]?.payload;
}
