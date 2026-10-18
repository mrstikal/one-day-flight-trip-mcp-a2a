import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { z } from "zod";
import {
  coordinatorRunDataSchema,
  type CoordinatorRunData,
  type CoordinatorRunStatus,
  type CoordinatorStep,
  type CoordinatorWaitReason,
} from "@odft/contracts";
import { lockOperationFence, type OperationFencingContext } from "./operations/fencing.js";

/** Accepted (pre-default) run-data shape; the schema fills the defaults. */
export type CoordinatorRunDataInput = z.input<typeof coordinatorRunDataSchema>;

type Queryable = Pick<PoolClient, "query">;

/**
 * Phase 03 coordinator-run repository (plan §3.6/§3.8).
 *
 * Transaction/fence ownership: every function runs on the caller's client and
 * opens no transaction of its own. The coordinator driver owns the short fenced
 * transaction that persists a cursor together with the decision/operation it
 * belongs to; this repository only reads/writes the run row.
 */

export interface CoordinatorRunRecord {
  readonly id: string;
  readonly tripId: string;
  readonly operationId: string | null;
  readonly coordinatorVersion: string;
  readonly acceptedRevision: number;
  readonly step: CoordinatorStep;
  readonly waitReason: CoordinatorWaitReason | null;
  readonly status: CoordinatorRunStatus;
  readonly stateVersion: number;
  readonly runData: CoordinatorRunData;
  readonly failureCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface CoordinatorRunRow {
  id: string;
  trip_id: string;
  operation_id: string | null;
  coordinator_version: string;
  accepted_revision: number;
  step: CoordinatorStep;
  wait_reason: CoordinatorWaitReason | null;
  status: CoordinatorRunStatus;
  state_version: number;
  run_data: unknown;
  failure_code: string | null;
  created_at: Date;
  updated_at: Date;
}

const RUN_COLUMNS =
  "id, trip_id, operation_id, coordinator_version, accepted_revision, step, wait_reason, status, " +
  "state_version, run_data, failure_code, created_at, updated_at";

function toRecord(row: CoordinatorRunRow): CoordinatorRunRecord {
  return {
    id: row.id,
    tripId: row.trip_id,
    operationId: row.operation_id,
    coordinatorVersion: row.coordinator_version,
    acceptedRevision: row.accepted_revision,
    step: row.step,
    waitReason: row.wait_reason,
    status: row.status,
    stateVersion: row.state_version,
    runData: coordinatorRunDataSchema.parse(row.run_data),
    failureCode: row.failure_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface InsertCoordinatorRunInput {
  readonly id?: string;
  readonly tripId: string;
  readonly operationId?: string;
  readonly acceptedRevision: number;
  readonly step: CoordinatorStep;
  readonly status?: CoordinatorRunStatus;
  readonly waitReason?: CoordinatorWaitReason;
  readonly runData: CoordinatorRunDataInput;
}

export async function insertCoordinatorRun(
  client: Queryable,
  input: InsertCoordinatorRunInput,
): Promise<CoordinatorRunRecord> {
  const runData = coordinatorRunDataSchema.parse(input.runData);
  const result = await client.query<CoordinatorRunRow>(
    `INSERT INTO odft_app.coordinator_runs
       (id, trip_id, operation_id, coordinator_version, accepted_revision, step, status, wait_reason, run_data)
     VALUES ($1, $2, $3, 'coordinator-v1', $4, $5, $6, $7, $8::jsonb)
     RETURNING ${RUN_COLUMNS}`,
    [
      input.id ?? randomUUID(),
      input.tripId,
      input.operationId ?? null,
      input.acceptedRevision,
      input.step,
      input.status ?? "running",
      input.waitReason ?? null,
      JSON.stringify(runData),
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`coordinator run for trip ${input.tripId} was not inserted`);
  }
  return toRecord(row);
}

/**
 * Fenced insert in its own transaction: `FOR SHARE` on the operation row blocks
 * a concurrent cancellation/token rotation until the run write commits.
 */
export async function insertCoordinatorRunFenced(
  pool: Pool,
  input: InsertCoordinatorRunInput,
  fence: OperationFencingContext,
): Promise<CoordinatorRunRecord> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockOperationFence(client, fence);
    const run = await insertCoordinatorRun(client, input);
    await client.query("COMMIT");
    return run;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getCoordinatorRun(
  client: Queryable,
  runId: string,
): Promise<CoordinatorRunRecord | undefined> {
  const result = await client.query<CoordinatorRunRow>(
    `SELECT ${RUN_COLUMNS} FROM odft_app.coordinator_runs WHERE id = $1`,
    [runId],
  );
  const row = result.rows[0];
  return row ? toRecord(row) : undefined;
}

/** The single active (running or waiting) run of a trip, if any. */
export async function getActiveCoordinatorRun(
  client: Queryable,
  tripId: string,
): Promise<CoordinatorRunRecord | undefined> {
  const result = await client.query<CoordinatorRunRow>(
    `SELECT ${RUN_COLUMNS} FROM odft_app.coordinator_runs
      WHERE trip_id = $1 AND status IN ('running','waiting')
      ORDER BY created_at DESC LIMIT 1`,
    [tripId],
  );
  const row = result.rows[0];
  return row ? toRecord(row) : undefined;
}

export interface UpdateCoordinatorRunInput {
  readonly runId: string;
  readonly operationId?: string | null;
  readonly step: CoordinatorStep;
  readonly waitReason?: CoordinatorWaitReason | null;
  readonly status: CoordinatorRunStatus;
  readonly runData: CoordinatorRunDataInput;
  readonly failureCode?: string | null;
}

/** Persist the next cursor (step + typed run data) with a state-version bump. */
export async function updateCoordinatorRun(
  client: Queryable,
  input: UpdateCoordinatorRunInput,
): Promise<CoordinatorRunRecord> {
  const runData = coordinatorRunDataSchema.parse(input.runData);
  const result = await client.query<CoordinatorRunRow>(
    `UPDATE odft_app.coordinator_runs
        SET operation_id = COALESCE($2, operation_id),
            step = $3,
            wait_reason = $4,
            status = $5,
            run_data = $6::jsonb,
            failure_code = $7,
            state_version = state_version + 1,
            updated_at = now()
      WHERE id = $1
      RETURNING ${RUN_COLUMNS}`,
    [
      input.runId,
      input.operationId ?? null,
      input.step,
      input.waitReason ?? null,
      input.status,
      JSON.stringify(runData),
      input.failureCode ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`coordinator run ${input.runId} not found`);
  }
  return toRecord(row);
}

/**
 * Fenced cursor update in its own transaction. The `FOR SHARE` lock is what
 * makes the ownership check atomic with the write: cancellation's token
 * rotation waits for this commit instead of interleaving between check and
 * update.
 */
export async function updateCoordinatorRunFenced(
  pool: Pool,
  input: UpdateCoordinatorRunInput,
  fence: OperationFencingContext,
  extraWrites?: (client: Pick<PoolClient, "query">) => Promise<void>,
): Promise<CoordinatorRunRecord> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockOperationFence(client, fence);
    const run = await updateCoordinatorRun(client, input);
    if (extraWrites) {
      await extraWrites(client);
    }
    await client.query("COMMIT");
    return run;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
