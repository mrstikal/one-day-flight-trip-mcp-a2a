import type { Pool, PoolClient } from "pg";

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
  "operation.cancel_requested": ["controlRequestId"],
  "operation.cancelled": ["controlRequestId"],
  // Phase 09 observation bridge: one application event per persisted protocol
  // observation (safe correlation/summary only; never prompts or payloads).
  "protocol.observed": ["kind", "source", "observationId", "delegationId", "observedAt", "summary"],
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
  // Legacy graph event retained for historical projections; the coordinator never emits it.
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

/**
 * Phase 09 observation→event bridge (ODTF_PLAN.md step 1).
 *
 * Inserts one `protocol.observed` application event for an unlinked observation
 * and links the observation to that event idempotently. Late observations are
 * reconciled even after their operation ended: the link uses the observation's
 * correlation (trip/operation) and the SOURCE timestamp is preserved in the
 * payload as `observedAt`, so the timeline keeps chronological source order
 * instead of ingestion order. The observation stays linked exactly once; a
 * duplicate bridge for the same observation returns the stored event link.
 *
 * Runs on the caller's client in ONE transaction (insert + link commit
 * atomically): a crash between the statements can never orphan a duplicate
 * `protocol.observed` event. When the link UPDATE affects 0 rows, a concurrent
 * bridge won the race — the transaction rolls back and the winner's event id
 * is returned instead of inserting a second event.
 */
export async function bridgeObservationToEvent(
  pool: Pool,
  input: {
    observationId: string;
    tripId: string;
    operationId: string | null;
    type: "protocol.observed";
    payload: Record<string, unknown>;
  },
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ application_event_id: string | null }>(
      `SELECT application_event_id FROM odft_app.protocol_observations WHERE id = $1`,
      [input.observationId],
    );
    const linked = existing.rows[0]?.application_event_id;
    if (linked !== null && linked !== undefined) {
      await client.query("ROLLBACK");
      return String(linked);
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO odft_app.execution_events (trip_id, operation_id, type, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id::text AS id`,
      [
        input.tripId,
        input.operationId,
        input.type,
        JSON.stringify(projectSafeEvent(input.type, input.payload)),
      ],
    );
    const eventId = inserted.rows[0]?.id;
    if (!eventId) {
      await client.query("ROLLBACK");
      throw new Error(`bridging observation ${input.observationId} produced no event`);
    }
    const linked2 = await client.query(
      `UPDATE odft_app.protocol_observations
          SET application_event_id = $2::bigint
        WHERE id = $1 AND application_event_id IS NULL`,
      [input.observationId, eventId],
    );
    if ((linked2.rowCount ?? 0) !== 1) {
      // Lost the race: roll back our orphan event and return the winner.
      await client.query("ROLLBACK");
      const after = await client.query<{ application_event_id: string | null }>(
        `SELECT application_event_id FROM odft_app.protocol_observations WHERE id = $1`,
        [input.observationId],
      );
      const winner = after.rows[0]?.application_event_id;
      if (winner === null || winner === undefined) {
        throw new Error(`bridging observation ${input.observationId} lost its link`);
      }
      return String(winner);
    }
    await client.query("COMMIT");
    return eventId;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore nested rollback failure
    }
    throw error;
  } finally {
    client.release();
  }
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
