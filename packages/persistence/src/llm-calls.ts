import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AIRole, CostStatus, LlmCallStatus } from "@odft/contracts";
import { assertOperationFence } from "./effects.js";
import {
  countTripLlmCalls,
  formatUsdAmount,
  parseUsdAmount,
  sumTripLlmCostUsd,
  usdFromDb,
} from "./usd.js";

/**
 * Durable AI call governance (06-ai-agent-design.md section 8).
 *
 * Every attempt — retries included — is reserved under a short SQL lock BEFORE
 * transport, refused when the trip/role ceiling would be exceeded, and settled
 * with actual/estimated/unknown billing afterwards. An uncertain charge stays
 * reserved until explicit reconciliation and is never released as zero.
 */

export interface ReserveCallInput {
  readonly tripId: string;
  readonly operationId: string;
  /** Fencing token of the claiming worker; verified inside the reserve transaction. */
  readonly fencingToken?: string;
  readonly role: AIRole;
  readonly model: string;
  readonly provider: string;
  readonly promptVersion: string;
  readonly mode: "fixture" | "openrouter";
  readonly effectScope: string;
  readonly pricingVersion: string;
  readonly reservedTokens: number;
  /** Worst-case cost of this single attempt, as a USD decimal string. */
  readonly reservedCostUsd: string;
  /** Role per-call ceiling. */
  readonly maxCallCostUsd: string;
  readonly maxCallsPerTrip: number;
  readonly maxCostUsdPerTrip: string;
  /** Hard cap of attempts for this operation+effect scope (durable across restarts). */
  readonly maxAttemptsPerScope: number;
}

export type ReserveCallOutcome =
  | { readonly ok: true; readonly callId: string }
  | {
      readonly ok: false;
      readonly code: "AI_BUDGET_EXCEEDED" | "AI_PRICING_UNKNOWN";
      readonly message: string;
    };

export interface RecordCallResultInput {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly costUsd?: string;
  readonly costStatus: CostStatus;
  readonly latencyMs: number;
  readonly finishReason?: string;
  readonly attempts: number;
  readonly validationStatus: "valid" | "invalid";
  readonly errorCode?: string;
}

export interface LlmCallRecord {
  readonly id: string;
  readonly tripId: string | null;
  readonly operationId: string | null;
  readonly role: AIRole;
  readonly model: string;
  readonly provider: string | null;
  readonly promptVersion: string;
  readonly mode: "fixture" | "openrouter";
  readonly effectScope: string | null;
  readonly pricingVersion: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly reasoningOutputTokens: number | null;
  readonly latencyMs: number | null;
  readonly costStatus: CostStatus | null;
  readonly costUsd: string;
  readonly attempts: number;
  readonly validationStatus: "valid" | "invalid" | "pending" | null;
  readonly status: LlmCallStatus;
  readonly finishReason: string | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
}

interface LlmCallRow {
  id: string;
  trip_id: string | null;
  operation_id: string | null;
  role: AIRole;
  model: string;
  provider: string | null;
  prompt_version: string;
  mode: string;
  effect_scope: string | null;
  pricing_version: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_output_tokens: number | null;
  latency_ms: number | null;
  cost_status: string | null;
  reserved_cost_usd: string;
  actual_cost_usd: string | null;
  attempts: number;
  validation_status: string | null;
  status: string;
  finish_reason: string | null;
  error_code: string | null;
  created_at: string;
}

function toRecord(row: LlmCallRow): LlmCallRecord {
  const cost = row.actual_cost_usd ?? row.reserved_cost_usd;
  return {
    id: row.id,
    tripId: row.trip_id,
    operationId: row.operation_id,
    role: row.role,
    model: row.model,
    provider: row.provider,
    promptVersion: row.prompt_version,
    mode: row.mode === "fixture" ? "fixture" : "openrouter",
    effectScope: row.effect_scope,
    pricingVersion: row.pricing_version,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedInputTokens: row.cached_input_tokens,
    reasoningOutputTokens: row.reasoning_output_tokens,
    latencyMs: row.latency_ms,
    costStatus: (row.cost_status as CostStatus | null) ?? null,
    costUsd: formatUsdAmount(usdFromDb(cost)),
    attempts: row.attempts,
    validationStatus: (row.validation_status as LlmCallRecord["validationStatus"]) ?? null,
    status: row.status as LlmCallStatus,
    finishReason: row.finish_reason,
    errorCode: row.error_code,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const CALL_COLUMNS =
  "id, trip_id, operation_id, role, model, provider, prompt_version, mode, effect_scope, " +
  "pricing_version, input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens, " +
  "latency_ms, cost_status, reserved_cost_usd, actual_cost_usd, attempts, validation_status, " +
  "status, finish_reason, error_code, created_at::text AS created_at";

/**
 * Reserve one billable attempt. Refuses (without writing a row) when the trip
 * call/cost budget or the role per-call ceiling would be exceeded.
 */
export async function reserveCall(
  pool: Pool,
  input: ReserveCallInput,
): Promise<ReserveCallOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Short per-trip lock serializes concurrent budget checks.
    await client.query(`SELECT id FROM odft_app.trips WHERE id = $1 FOR UPDATE`, [input.tripId]);
    // A worker that lost its lease must not reserve (or later write) under the
    // operation it no longer owns.
    if (input.fencingToken) {
      await assertOperationFence(client, {
        operationId: input.operationId,
        tripId: input.tripId,
        fencingToken: input.fencingToken,
      });
    }

    let reserved: bigint;
    try {
      reserved = parseUsdAmount(input.reservedCostUsd);
    } catch {
      await client.query("ROLLBACK");
      return {
        ok: false,
        code: "AI_PRICING_UNKNOWN",
        message: "reserved cost is not a valid USD amount",
      };
    }
    const ceiling = parseUsdAmount(input.maxCallCostUsd);
    if (reserved > ceiling) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        code: "AI_BUDGET_EXCEEDED",
        message: "the worst-case cost of this call exceeds the role per-call ceiling",
      };
    }
    // The two-attempt bound is durable: a restarted worker cannot restart the
    // adapter's local loop from zero for the same interpretation. An explicit owner
    // retry opens a new recovery round and with it a fresh budget for the scope it
    // was authorized to recover; a crash/restart inside the same round still cannot.
    const recovery = await client.query<{ recovery_rounds: number }>(
      `SELECT recovery_rounds FROM odft_app.workflow_operations WHERE id = $1`,
      [input.operationId],
    );
    const attemptLimit =
      input.maxAttemptsPerScope * ((recovery.rows[0]?.recovery_rounds ?? 0) + 1);
    const scopeAttempts = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.llm_calls
        WHERE operation_id = $1 AND effect_scope = $2`,
      [input.operationId, input.effectScope],
    );
    if (Number.parseInt(scopeAttempts.rows[0]?.count ?? "0", 10) + 1 > attemptLimit) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        code: "AI_BUDGET_EXCEEDED",
        message: "the per-interpretation AI attempt limit is exhausted",
      };
    }
    const attempted = await countTripLlmCalls(client, input.tripId);
    if (attempted + 1 > input.maxCallsPerTrip) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        code: "AI_BUDGET_EXCEEDED",
        message: "the per-trip AI call budget is exhausted",
      };
    }
    const spent = await sumTripLlmCostUsd(client, input.tripId);
    if (spent + reserved > parseUsdAmount(input.maxCostUsdPerTrip)) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        code: "AI_BUDGET_EXCEEDED",
        message: "the per-trip AI cost budget is exhausted",
      };
    }

    const callId = randomUUID();
    await client.query(
      `INSERT INTO odft_app.llm_calls
         (id, trip_id, operation_id, role, model, provider, prompt_version, mode, effect_scope,
          pricing_version, reserved_tokens, reserved_cost_usd, attempts, status, validation_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::numeric, 0, 'reserved', 'pending')`,
      [
        callId,
        input.tripId,
        input.operationId,
        input.role,
        input.model,
        input.provider,
        input.promptVersion,
        input.mode,
        input.effectScope,
        input.pricingVersion,
        input.reservedTokens,
        input.reservedCostUsd,
      ],
    );
    await client.query("COMMIT");
    return { ok: true, callId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Settle a reserved attempt with its usage and validation outcome. */
export async function recordCallResult(
  pool: Pool,
  callId: string,
  usage: RecordCallResultInput,
): Promise<void> {
  const status: LlmCallStatus =
    usage.costStatus === "unknown_reserved"
      ? "unknown_reserved"
      : usage.validationStatus === "valid"
        ? "succeeded"
        : "failed";
  // A negative or non-finite latency (e.g. a backward clock step) must never fail the
  // settlement and orphan a reservation; telemetry clamps to zero instead.
  const latencyMs = Number.isFinite(usage.latencyMs) ? Math.max(0, Math.round(usage.latencyMs)) : 0;
  await pool.query(
    `UPDATE odft_app.llm_calls
        SET input_tokens = $2, output_tokens = $3, cached_input_tokens = $4,
            reasoning_output_tokens = $5,
            actual_cost_usd = CASE WHEN $6::text IS NULL THEN NULL ELSE $6::numeric END,
            cost_status = $7, latency_ms = $8, finish_reason = $9, attempts = $10,
            validation_status = $11, status = $12, error_code = $13
      WHERE id = $1`,
    [
      callId,
      usage.inputTokens ?? null,
      usage.outputTokens ?? null,
      usage.cachedInputTokens ?? null,
      usage.reasoningOutputTokens ?? null,
      usage.costStatus === "unknown_reserved" ? null : (usage.costUsd ?? null),
      usage.costStatus,
      latencyMs,
      usage.finishReason ?? null,
      usage.attempts,
      usage.validationStatus,
      status,
      usage.errorCode ?? null,
    ],
  );
}

/** Mark a call whose billing is unknown; the reservation is retained, not zeroed. */
export async function markCallUnknown(
  pool: Pool,
  callId: string,
  errorCode: string,
  latencyMs?: number,
): Promise<void> {
  const elapsed =
    latencyMs === undefined
      ? null
      : Number.isFinite(latencyMs)
        ? Math.max(0, Math.round(latencyMs))
        : 0;
  await pool.query(
    `UPDATE odft_app.llm_calls
        SET status = 'unknown_reserved', cost_status = 'unknown_reserved', error_code = $2,
            latency_ms = COALESCE($3::integer, latency_ms)
      WHERE id = $1`,
    [callId, errorCode, elapsed],
  );
}

/** Explicit reconciliation of an uncertain charge (never an automatic zero). */
export async function reconcileUnknownBilling(
  pool: Pool,
  callId: string,
  resolution: { readonly actualCostUsd?: string; readonly costStatus?: CostStatus },
): Promise<void> {
  await pool.query(
    `UPDATE odft_app.llm_calls
        SET actual_cost_usd = CASE WHEN $2::text IS NULL THEN actual_cost_usd ELSE $2::numeric END,
            cost_status = COALESCE($3, cost_status, 'actual'),
            status = 'reconciled', reconciled_at = now()
      WHERE id = $1`,
    [callId, resolution.actualCostUsd ?? null, resolution.costStatus ?? null],
  );
}

export async function getLlmCall(client: Pool | PoolClient, callId: string): Promise<LlmCallRecord | undefined> {
  const result = await client.query<LlmCallRow>(
    `SELECT ${CALL_COLUMNS} FROM odft_app.llm_calls WHERE id = $1`,
    [callId],
  );
  const row = result.rows[0];
  return row ? toRecord(row) : undefined;
}

/** Safe telemetry rows for a trip (never prompts/reasoning/provider payloads). */
export async function listTripLlmCalls(
  client: Pool | PoolClient,
  tripId: string,
  limit = 50,
): Promise<LlmCallRecord[]> {
  const result = await client.query<LlmCallRow>(
    `SELECT ${CALL_COLUMNS} FROM odft_app.llm_calls
      WHERE trip_id = $1 ORDER BY created_at ASC LIMIT $2`,
    [tripId, Math.max(1, Math.min(limit, 200))],
  );
  return result.rows.map(toRecord);
}
