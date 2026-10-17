import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  protocolObservationSchema,
  type ProtocolObservation,
  type ProtocolObservationKind,
  type ProtocolObservationPayload,
  type ProtocolSource,
} from "@odft/contracts";
import { insertProtocolObservation } from "@odft/persistence";

/**
 * Phase 03 safe protocol telemetry (plan §3.6, §3.9).
 *
 * One sanitized observation per real interaction. Payloads carry only safe
 * codes/counters; prompts, tokens, credentials, raw response bodies and stack
 * traces never reach this module by construction (the payload type has no
 * field for them), and free-text details are flattened and length-capped.
 */

export const MAX_DETAIL_LENGTH = 400;

/** Flatten a free-text detail into one bounded, newline-free line. */
export function sanitizeDetail(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const flattened = value.replace(/\s+/g, " ").trim();
  if (flattened.length === 0) {
    return null;
  }
  return flattened.slice(0, MAX_DETAIL_LENGTH);
}

export interface ObservationInput {
  readonly source: ProtocolSource;
  readonly kind: ProtocolObservationKind;
  readonly correlation?: {
    readonly tripId?: string | null;
    readonly operationId?: string | null;
    readonly delegationId?: string | null;
    readonly taskId?: string | null;
    readonly contextId?: string | null;
    readonly traceId?: string | null;
  };
  readonly payload?: Partial<ProtocolObservationPayload>;
  readonly occurredAt?: Date;
}

/** Canonical hash of the safe payload (stable key order). */
export function observationPayloadHash(payload: ProtocolObservationPayload): string {
  const canonical = JSON.stringify({
    detail: payload.detail,
    failureCategory: payload.failureCategory,
    durationMs: payload.durationMs,
    status: payload.status,
    counters: Object.fromEntries(
      Object.entries(payload.counters).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function buildObservation(input: ObservationInput): ProtocolObservation {
  const payload: ProtocolObservationPayload = {
    detail: sanitizeDetail(input.payload?.detail),
    failureCategory: input.payload?.failureCategory ?? null,
    durationMs: input.payload?.durationMs ?? null,
    status: input.payload?.status ?? null,
    counters: input.payload?.counters ?? {},
  };
  return protocolObservationSchema.parse({
    id: randomUUID(),
    source: input.source,
    kind: input.kind,
    correlation: {
      tripId: input.correlation?.tripId ?? null,
      operationId: input.correlation?.operationId ?? null,
      delegationId: input.correlation?.delegationId ?? null,
      taskId: input.correlation?.taskId ?? null,
      contextId: input.correlation?.contextId ?? null,
      traceId: input.correlation?.traceId ?? null,
    },
    payload,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    payloadHash: observationPayloadHash(payload),
  });
}

/**
 * Persist observations. Recording is best-effort for callers: telemetry must
 * never turn a successful interaction into a failed one, so `record` resolves
 * even when the write fails (the failure is surfaced through the returned
 * boolean for tests/logging).
 */
export class ProtocolTelemetryWriter {
  constructor(private readonly pool: Pool) {}

  async record(observation: ProtocolObservation): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await insertProtocolObservation(client, observation);
      return true;
    } catch {
      return false;
    } finally {
      client.release();
    }
  }
}
