import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { CostStatus, VoiceKind, VoiceUnitKind } from "@odft/contracts";
import { formatUsdAmount, parseUsdAmount, usdFromDb } from "./usd.js";

/**
 * Durable voice-call ledger (VOICE_CONTROLL.md section 9).
 *
 * One reservation per `(trip_id, request_id)` under a short trip lock BEFORE any
 * transport, a conservative reservation that is never released as zero, and a
 * settlement that records authoritative (or verified estimated) billing. An
 * uncertain charge stays reserved until explicit operator reconciliation.
 * Fixture mode never calls this repository (no billable rows).
 */

export type VoiceCallStatus =
  "reserved" | "succeeded" | "failed" | "unknown_reserved" | "reconciled";

export interface ReserveVoiceCallInput {
  readonly tripId: string;
  /** Client idempotency key; reused ids never call the provider again. */
  readonly requestId: string;
  /** Hash over kind/model/input identity; a mismatch on reuse is a conflict. */
  readonly requestFingerprint: string;
  readonly kind: VoiceKind;
  readonly model: string;
  readonly providerRestriction?: string | null;
  readonly pricingVersion?: string | null;
  readonly normalizationVersion?: string | null;
  /** Required for TTS: the authoritative message and its settled operation. */
  readonly operationId?: string | null;
  readonly messageId?: string | null;
  /** Expected billing units (STT audio seconds / TTS characters) when known. */
  readonly unitKind?: VoiceUnitKind | null;
  readonly inputUnits?: number | null;
  /** Worst-case cost of this single call, as a USD decimal string. */
  readonly reservedCostUsd: string;
  /** Per-call ceiling from the voice profile. */
  readonly maxCallCostUsd: string;
  readonly maxCallsPerTrip: number;
  readonly maxCostUsdPerTrip: string;
}

export type ReserveVoiceCallOutcome =
  | { readonly ok: true; readonly callId: string }
  | {
      readonly ok: false;
      readonly code:
        | "CONFLICT"
        | "VOICE_REQUEST_IN_PROGRESS"
        | "VOICE_RESULT_EXPIRED"
        | "VOICE_BUDGET_EXCEEDED"
        | "VOICE_CAPABILITY_UNKNOWN";
      readonly message: string;
    };

export interface SettleVoiceCallInput {
  readonly costStatus: "actual" | "estimated";
  /** Authoritative cost, or the verified conservative estimate. */
  readonly costUsd: string;
  readonly latencyMs: number;
  readonly inputUnits?: number;
  readonly unitKind?: VoiceUnitKind;
  readonly servingProviderId?: string | null;
  readonly generationId?: string | null;
}

export interface VoiceCallFailureInput {
  readonly errorCode: string;
  readonly latencyMs?: number;
  readonly servingProviderId?: string | null;
}

export interface VoiceCallRecord {
  readonly id: string;
  readonly tripId: string;
  readonly requestId: string;
  readonly requestFingerprint: string;
  readonly kind: VoiceKind;
  readonly model: string;
  readonly gateway: string;
  readonly providerRestriction: string | null;
  readonly servingProvider: string | null;
  readonly operationId: string | null;
  readonly messageId: string | null;
  readonly pricingVersion: string | null;
  readonly normalizationVersion: string | null;
  readonly unitKind: VoiceUnitKind | null;
  readonly inputUnits: number | null;
  readonly reservedCostUsd: string;
  readonly actualCostUsd: string | null;
  readonly latencyMs: number | null;
  readonly generationId: string | null;
  readonly errorCode: string | null;
  readonly status: VoiceCallStatus;
  readonly costStatus: CostStatus | null;
  readonly createdAt: string;
  readonly settledAt: string | null;
  readonly reconciledAt: string | null;
}

interface VoiceCallRow {
  id: string;
  trip_id: string;
  request_id: string;
  request_fingerprint: string;
  kind: string;
  model: string;
  gateway: string;
  provider_restriction: string | null;
  serving_provider: string | null;
  operation_id: string | null;
  message_id: string | null;
  pricing_version: string | null;
  normalization_version: string | null;
  unit_kind: string | null;
  input_units: string | null;
  reserved_cost_usd: string;
  actual_cost_usd: string | null;
  latency_ms: number | null;
  generation_id: string | null;
  error_code: string | null;
  status: string;
  cost_status: string | null;
  created_at: string;
  settled_at: string | null;
  reconciled_at: string | null;
}

const CALL_COLUMNS =
  "id, trip_id, request_id, request_fingerprint, kind, model, gateway, provider_restriction, " +
  "serving_provider, operation_id, message_id, pricing_version, normalization_version, unit_kind, " +
  "input_units::text AS input_units, reserved_cost_usd::text AS reserved_cost_usd, " +
  "actual_cost_usd::text AS actual_cost_usd, latency_ms, generation_id, error_code, status, " +
  "cost_status, created_at::text AS created_at, settled_at::text AS settled_at, " +
  "reconciled_at::text AS reconciled_at";

function toRecord(row: VoiceCallRow): VoiceCallRecord {
  return {
    id: row.id,
    tripId: row.trip_id,
    requestId: row.request_id,
    requestFingerprint: row.request_fingerprint,
    kind: row.kind === "tts" ? "tts" : "stt",
    model: row.model,
    gateway: row.gateway,
    providerRestriction: row.provider_restriction,
    servingProvider: row.serving_provider,
    operationId: row.operation_id,
    messageId: row.message_id,
    pricingVersion: row.pricing_version,
    normalizationVersion: row.normalization_version,
    unitKind:
      row.unit_kind === "characters"
        ? "characters"
        : row.unit_kind === "audio_seconds"
          ? "audio_seconds"
          : null,
    inputUnits: row.input_units === null ? null : Number(row.input_units),
    reservedCostUsd: formatUsdAmount(usdFromDb(row.reserved_cost_usd)),
    actualCostUsd:
      row.actual_cost_usd === null ? null : formatUsdAmount(usdFromDb(row.actual_cost_usd)),
    latencyMs: row.latency_ms,
    generationId: row.generation_id,
    errorCode: row.error_code,
    status: row.status as VoiceCallStatus,
    costStatus: (row.cost_status as CostStatus | null) ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    settledAt: row.settled_at === null ? null : new Date(row.settled_at).toISOString(),
    reconciledAt: row.reconciled_at === null ? null : new Date(row.reconciled_at).toISOString(),
  };
}

type Queryable = Pick<PoolClient, "query">;

/** Attempted voice calls for a trip (every reservation counts, retries included). */
export async function countTripVoiceCalls(client: Queryable, tripId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM odft_app.voice_calls WHERE trip_id = $1`,
    [tripId],
  );
  return Number.parseInt(result.rows[0]?.count ?? "0", 10);
}

/**
 * Reserved + actual USD for a trip: an actual amount replaces the reservation;
 * unresolved/failed/uncertain reservations count at their reserved worst case
 * until explicitly reconciled. This is the conservative budget sum.
 */
export async function sumTripVoiceCostUsd(client: Queryable, tripId: string): Promise<bigint> {
  const result = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(
              CASE WHEN actual_cost_usd IS NOT NULL THEN actual_cost_usd
                   ELSE reserved_cost_usd END
            ), 0)::text AS total
       FROM odft_app.voice_calls WHERE trip_id = $1`,
    [tripId],
  );
  return usdFromDb(result.rows[0]?.total ?? "0");
}

/**
 * Reserve one voice attempt. Refuses without writing a row when the request key
 * conflicts, the request is still in progress, or the trip budget/ceiling would
 * be exceeded. TTS reservations must carry their message/operation links.
 */
export async function reserveVoiceCall(
  pool: Pool,
  input: ReserveVoiceCallInput,
): Promise<ReserveVoiceCallOutcome> {
  if (input.kind === "tts" && (!input.operationId || !input.messageId)) {
    throw new TypeError("a tts reservation requires the message and operation links");
  }
  const hasUnits = input.inputUnits !== undefined && input.inputUnits !== null;
  const hasKind = input.unitKind !== undefined && input.unitKind !== null;
  if (hasUnits !== hasKind) {
    throw new TypeError("voice units and their kind must be provided together");
  }
  let reserved: bigint;
  try {
    reserved = parseUsdAmount(input.reservedCostUsd);
  } catch {
    return {
      ok: false,
      code: "VOICE_CAPABILITY_UNKNOWN",
      message: "the reserved voice cost is not a valid USD amount",
    };
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Short per-trip lock serializes concurrent budget checks.
    await client.query(`SELECT id FROM odft_app.trips WHERE id = $1 FOR UPDATE`, [input.tripId]);

    const existing = await client.query<{
      id: string;
      kind: string;
      request_fingerprint: string;
      status: string;
    }>(
      `SELECT id, kind, request_fingerprint, status FROM odft_app.voice_calls
        WHERE trip_id = $1 AND request_id = $2`,
      [input.tripId, input.requestId],
    );
    const prior = existing.rows[0];
    if (prior) {
      await client.query("ROLLBACK");
      if (prior.kind !== input.kind || prior.request_fingerprint !== input.requestFingerprint) {
        return {
          ok: false,
          code: "CONFLICT",
          message: "the voice request id was already used with a different request",
        };
      }
      if (prior.status === "reserved" || prior.status === "unknown_reserved") {
        return {
          ok: false,
          code: "VOICE_REQUEST_IN_PROGRESS",
          message: "the voice request is still in progress",
        };
      }
      // Finished: the provider is never called again, and no durable result
      // cache exists — the browser must start a new request.
      return {
        ok: false,
        code: "VOICE_RESULT_EXPIRED",
        message:
          "the voice request already finished; its result is not retained — start a new request",
      };
    }

    const ceiling = parseUsdAmount(input.maxCallCostUsd);
    if (reserved > ceiling) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        code: "VOICE_BUDGET_EXCEEDED",
        message: "the worst-case cost of this voice call exceeds the per-call ceiling",
      };
    }
    const attempted = await countTripVoiceCalls(client, input.tripId);
    if (attempted + 1 > input.maxCallsPerTrip) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        code: "VOICE_BUDGET_EXCEEDED",
        message: "the per-trip voice call budget is exhausted",
      };
    }
    const spent = await sumTripVoiceCostUsd(client, input.tripId);
    if (spent + reserved > parseUsdAmount(input.maxCostUsdPerTrip)) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        code: "VOICE_BUDGET_EXCEEDED",
        message: "the per-trip voice cost budget is exhausted",
      };
    }

    const callId = randomUUID();
    await client.query(
      `INSERT INTO odft_app.voice_calls
         (id, trip_id, request_id, request_fingerprint, kind, model, provider_restriction,
          operation_id, message_id, pricing_version, normalization_version, unit_kind,
          input_units, reserved_cost_usd, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::numeric, $14::numeric, 'reserved')`,
      [
        callId,
        input.tripId,
        input.requestId,
        input.requestFingerprint,
        input.kind,
        input.model,
        input.providerRestriction ?? null,
        input.operationId ?? null,
        input.messageId ?? null,
        input.pricingVersion ?? null,
        input.normalizationVersion ?? null,
        input.unitKind ?? null,
        input.inputUnits ?? null,
        input.reservedCostUsd,
      ],
    );
    await client.query("COMMIT");
    return { ok: true, callId };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failures; the original error matters.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Settle a succeeded call with authoritative cost or the verified estimate. */
export async function settleVoiceCallSuccess(
  pool: Pool,
  callId: string,
  input: SettleVoiceCallInput,
): Promise<void> {
  const hasUnits = input.inputUnits !== undefined;
  const hasKind = input.unitKind !== undefined;
  if (hasUnits !== hasKind) {
    throw new TypeError("voice units and their kind must be provided together");
  }
  // Only a live reservation can be settled: terminal rows are never rewritten.
  const result = await pool.query(
    `UPDATE odft_app.voice_calls
        SET status = 'succeeded',
            cost_status = $2,
            actual_cost_usd = $3::numeric,
            latency_ms = $4,
            unit_kind = COALESCE($5, unit_kind),
            input_units = COALESCE($6::numeric, input_units),
            serving_provider = COALESCE($7, serving_provider),
            generation_id = COALESCE($8, generation_id),
            settled_at = now()
      WHERE id = $1 AND status = 'reserved'`,
    [
      callId,
      input.costStatus,
      input.costUsd,
      input.latencyMs,
      input.unitKind ?? null,
      input.inputUnits ?? null,
      input.servingProviderId ?? null,
      input.generationId ?? null,
    ],
  );
  if (result.rowCount === 0) {
    throw new Error("the voice call is not in a settleable state");
  }
}

/**
 * Mark an observed failure. The reservation is RETAINED (actual stays null), so
 * an uncertain upstream charge can never be silently zeroed; only explicit
 * reconciliation with billing evidence can settle the amount.
 */
export async function markVoiceCallFailed(
  pool: Pool,
  callId: string,
  input: VoiceCallFailureInput,
): Promise<void> {
  const result = await pool.query(
    `UPDATE odft_app.voice_calls
        SET status = 'failed',
            error_code = $2,
            latency_ms = COALESCE($3, latency_ms),
            serving_provider = COALESCE($4, serving_provider),
            settled_at = now()
      WHERE id = $1 AND status IN ('reserved', 'unknown_reserved')`,
    [callId, input.errorCode, input.latencyMs ?? null, input.servingProviderId ?? null],
  );
  if (result.rowCount === 0) {
    throw new Error("the voice call is not in a failure-markable state");
  }
}

/** Mark an uncertain outcome (timeout/disconnect/crash): reservation retained. */
export async function markVoiceCallUnknown(
  pool: Pool,
  callId: string,
  input: VoiceCallFailureInput,
): Promise<void> {
  const result = await pool.query(
    `UPDATE odft_app.voice_calls
        SET status = 'unknown_reserved',
            cost_status = 'unknown_reserved',
            error_code = $2,
            latency_ms = COALESCE($3, latency_ms),
            serving_provider = COALESCE($4, serving_provider),
            settled_at = now()
      WHERE id = $1 AND status IN ('reserved', 'unknown_reserved')`,
    [callId, input.errorCode, input.latencyMs ?? null, input.servingProviderId ?? null],
  );
  if (result.rowCount === 0) {
    throw new Error("the voice call is not in an uncertainty-markable state");
  }
}

/**
 * Explicit operator reconciliation of an uncertain charge using verified
 * billing evidence (never an automatic zero or reset). Requires the evidence
 * itself and never overwrites an already recorded reconciliation.
 */
export async function reconcileVoiceCallBilling(
  pool: Pool,
  callId: string,
  resolution: { readonly actualCostUsd?: string; readonly costStatus?: CostStatus },
): Promise<void> {
  if (resolution.actualCostUsd === undefined && resolution.costStatus === undefined) {
    throw new TypeError("reconciliation requires verified billing evidence");
  }
  if (resolution.costStatus === "actual" && resolution.actualCostUsd === undefined) {
    throw new TypeError("an actual cost status requires the actual USD amount");
  }
  const result = await pool.query(
    `UPDATE odft_app.voice_calls
        SET actual_cost_usd = CASE WHEN $2::text IS NULL THEN actual_cost_usd ELSE $2::numeric END,
            cost_status = COALESCE($3, cost_status, 'actual'),
            status = 'reconciled', reconciled_at = now()
      WHERE id = $1 AND status <> 'reconciled'`,
    [callId, resolution.actualCostUsd ?? null, resolution.costStatus ?? null],
  );
  if (result.rowCount === 0) {
    throw new Error("the voice call billing was already reconciled or the call does not exist");
  }
}

export async function getVoiceCall(
  client: Pool | PoolClient,
  callId: string,
): Promise<VoiceCallRecord | undefined> {
  const result = await client.query<VoiceCallRow>(
    `SELECT ${CALL_COLUMNS} FROM odft_app.voice_calls WHERE id = $1`,
    [callId],
  );
  const row = result.rows[0];
  return row ? toRecord(row) : undefined;
}

/** Safe ledger rows for the inspector (never audio/transcripts/keys). */
export async function listTripVoiceCalls(
  client: Pool | PoolClient,
  tripId: string,
  limit = 50,
): Promise<VoiceCallRecord[]> {
  const result = await client.query<VoiceCallRow>(
    `SELECT ${CALL_COLUMNS} FROM odft_app.voice_calls
      WHERE trip_id = $1 ORDER BY created_at ASC LIMIT $2`,
    [tripId, Math.max(1, Math.min(limit, 200))],
  );
  return result.rows.map(toRecord);
}
