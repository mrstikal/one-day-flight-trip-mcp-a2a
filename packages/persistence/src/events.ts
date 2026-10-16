import type { PoolClient } from "pg";

type Queryable = Pick<PoolClient, "query">;

export interface ExecutionEventInput {
  readonly tripId: string;
  readonly operationId?: string;
  readonly type: string;
  readonly payload: unknown;
}

/**
 * Phase 11 event projection (10-security-reliability.md section 8).
 *
 * Every persisted event is reduced to an explicit allowlist of safe fields
 * BEFORE it is stored. Prompts, chain-of-thought or raw model output, provider
 * payloads, SQL, stack traces, cookies, secrets, and raw headers are therefore
 * never stored — the inspector (or any reader) cannot reveal what was never
 * persisted. Unknown event types store an empty payload instead of leaking a
 * shape nobody reviewed.
 */
const EVENT_FIELD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  "trip.created": ["revision"],
  "operation.admitted": ["revision"],
  "decision.admitted": ["revision", "decisionId"],
  "operation.succeeded": ["summary"],
  "operation.failed": ["code"],
  "operation.rejected": ["code"],
  "operation.retry_requested": ["recoveryRound"],
  "decision.awaiting": ["kind"],
  "booking.confirmed": ["reservationId", "serviceKey", "demoReference"],
  "booking.declined": ["serviceKey", "offerId"],
  "booking.cancelled": ["serviceKey", "reason"],
  "trip.simulation_armed": ["mode", "domain"],
  "research.domain_started": [
    "domain",
    "attempt",
    "durationMs",
    "status",
    "simulatedFailure",
    "reason",
    "fingerprint",
  ],
  "research.domain_finished": [
    "domain",
    "attempt",
    "durationMs",
    "status",
    "simulatedFailure",
    "reason",
    "fingerprint",
  ],
  "itinerary.attempt_started": ["attempt", "mode", "candidateCount"],
  "program.saved": [],
  "itinerary.review_started": ["attempt"],
  "itinerary.attempt_finished": [
    "attempt",
    "status",
    "errorCodes",
    "warningCodes",
    "simulatedFailure",
    "mode",
  ],
  "itinerary.reviewed": ["verdict", "issueCount", "attempt", "mode", "suppressionReason"],
  "itinerary.approved": ["itineraryId", "version", "decisionId"],
  "node.started": ["node"],
  "node.updated": ["node"],
  // Atomic conversation delivery metadata only; content/interpretation never.
  "conversation.message_added": ["messageId", "sequence", "role"],
  "graph.initialized": ["graphVersion", "nodes", "edges"],
  "route_change.previewed": ["proposalId", "affectedReservationIds"],
  "route_change.committed": ["proposalId", "affectedReservationIds", "cancelledReservationIds"],
};

/** Reduce an event payload to the allowlisted safe fields for its type. */
export function projectSafeEvent(type: string, payload: unknown): Record<string, unknown> {
  const allowed = EVENT_FIELD_ALLOWLIST[type];
  if (!allowed || allowed.length === 0) {
    return {};
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const source = payload as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const field of allowed) {
    if (Object.prototype.hasOwnProperty.call(source, field) && source[field] !== undefined) {
      projected[field] = source[field];
    }
  }
  return projected;
}

export async function insertEvent(client: Queryable, input: ExecutionEventInput): Promise<void> {
  await client.query(
    `INSERT INTO odft_app.execution_events (trip_id, operation_id, type, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [
      input.tripId,
      input.operationId ?? null,
      input.type,
      JSON.stringify(projectSafeEvent(input.type, input.payload)),
    ],
  );
}

export interface ProjectedEvent {
  /** Monotonic bigint id as a decimal string (never a lossy JS number). */
  readonly id: string;
  readonly tripId: string;
  readonly operationId: string | null;
  readonly type: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

interface EventRow {
  id: string;
  trip_id: string;
  operation_id: string | null;
  type: string;
  payload: unknown;
  created_at: string;
}

/**
 * Read persisted events for replay, ordered by monotonic id. `after` is the
 * last seen id (decimal string, exclusive). Used by the SSE route and polling
 * fallback; authorization happens before this call.
 */
export async function listTripEvents(
  client: Queryable | Pick<import("pg").Pool, "query">,
  tripId: string,
  options: { after?: string; limit?: number } = {},
): Promise<ProjectedEvent[]> {
  const after = options.after && /^\d+$/.test(options.after) ? options.after : "0";
  const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
  const result = await client.query<EventRow>(
    `SELECT id::text AS id, trip_id, operation_id, type, payload, created_at::text AS created_at
       FROM odft_app.execution_events
      WHERE trip_id = $1 AND id > $2::bigint
      ORDER BY id ASC
      LIMIT $3`,
    [tripId, after, limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    tripId: row.trip_id,
    operationId: row.operation_id,
    type: row.type,
    payload: row.payload,
    createdAt: row.created_at,
  }));
}
