import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  DECISION_ALLOWED_ACTIONS,
  DEFAULT_TRIP_PREFERENCES,
  isNoOpSetRoute,
  resumeRequestSchema,
  type AdmissionAccepted,
  type CommandRequest,
  type CreationInput,
  type EffectKey,
  type ErrorCode,
  type ErrorEnvelope,
  type ResumeRequest,
  type TripPreferences,
} from "@odft/contracts";
import { contentHash } from "./hash.js";
import { insertEvent } from "./events.js";
import { readEffect, writeEffect } from "./effects.js";
import { insertConversationMessage } from "./conversations.js";
import { loadDecision } from "./decisions.js";
import {
  getActiveOperation,
  getOperationByRequestId,
  insertOperation,
} from "./operations.js";
import { insertTrip, lockTrip } from "./trips.js";

/**
 * Command admission and trip creation (02-architecture.md section 6).
 * All logic runs in a single transaction with a `SELECT ... FOR UPDATE` trip
 * lock. Only accepted user requests advance `trip.revision`, exactly once.
 */

export const GRAPH_VERSION = "graph-v0";

export interface CreateTripOptions {
  readonly sessionId: string;
  readonly input: CreationInput;
}

export interface CreateTripResult {
  readonly tripId: string;
  readonly operationId: string;
  readonly revision: 1;
}

export interface AdmitOperationOptions {
  readonly tripId: string;
  readonly sessionId: string;
  readonly request: CommandRequest;
  /**
   * Chat text stored as the user conversation message inside the admission
   * transaction (never as a separate write that could race the worker).
   */
  readonly userMessage?: string;
}

export interface AdmitOperationResult {
  readonly status: "accepted";
  readonly operationId: string;
  readonly revision: number;
  readonly deduped: boolean;
}

function error(
  code: ErrorCode,
  message: string,
  extra: Partial<ErrorEnvelope> = {},
): ErrorEnvelope {
  return { code, message, retryable: false, ...extra };
}

/** Idempotent effect ledger helper: inserts-or-reads the ledger row in-line. */
export async function withEffect<T>(
  client: Pick<PoolClient, "query">,
  key: EffectKey,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = await readEffect(client, key);
  if (existing !== undefined) {
    return existing as T;
  }
  const result = await fn();
  await writeEffect(client, key, result);
  return result;
}

export async function createTrip(
  pool: Pool,
  options: CreateTripOptions,
): Promise<CreateTripResult | ErrorEnvelope> {
  const { sessionId, input } = options;
  const payloadHash = contentHash(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query<{ id: string; creation_payload_hash: string }>(
      `SELECT id, creation_payload_hash FROM odft_app.trips
        WHERE session_id = $1 AND creation_request_id = $2 FOR UPDATE`,
      [sessionId, input.creationRequestId],
    );
    const existingTrip = existing.rows[0];
    if (existingTrip) {
      if (existingTrip.creation_payload_hash !== payloadHash) {
        await client.query("ROLLBACK");
        return error("CREATION_CONFLICT", "the creation request id was reused with a different payload");
      }
      const operation = await client.query<{ id: string }>(
        `SELECT id FROM odft_app.workflow_operations
          WHERE trip_id = $1 AND kind = 'creation' ORDER BY created_at ASC LIMIT 1`,
        [existingTrip.id],
      );
      const operationId = operation.rows[0]?.id;
      if (!operationId) {
        await client.query("ROLLBACK");
        return error("CONFLICT", "existing trip has no initialization operation");
      }
      await client.query("COMMIT");
      return { tripId: existingTrip.id, operationId, revision: 1 };
    }

    const existingSession = await client.query<{ id: string }>(
      `SELECT id FROM odft_app.anonymous_sessions WHERE id = $1 AND expires_at > now()`,
      [sessionId],
    );
    if (!existingSession.rows[0]) {
      await client.query("ROLLBACK");
      return error("FORBIDDEN", "session does not exist or has expired");
    }

    // Geographic references must be admitted reference data, not just regex-valid.
    const references = await client.query<{ airport_ok: boolean; city_country: string | null }>(
      `SELECT
         (SELECT true FROM odft_app.reference_airports WHERE id = $1 AND eligible_origin = true) AS airport_ok,
         (SELECT country_key FROM odft_app.reference_cities WHERE id = $2) AS city_country`,
      [input.originAirportId, input.destinationCityId],
    );
    const ref = references.rows[0];
    if (!ref?.airport_ok) {
      await client.query("ROLLBACK");
      return error("VALIDATION_FAILED", "origin airport is not an admitted eligible origin");
    }
    if (!ref.city_country) {
      await client.query("ROLLBACK");
      return error("VALIDATION_FAILED", "destination city is not an admitted reference city");
    }
    if (ref.city_country !== input.destinationCountryKey) {
      await client.query("ROLLBACK");
      return error("VALIDATION_FAILED", "destination country does not match the destination city");
    }

    const tripId = randomUUID();
    const preferences: TripPreferences = input.preferences ?? DEFAULT_TRIP_PREFERENCES;
    await insertTrip(client, {
      id: tripId,
      sessionId,
      userName: input.userName,
      adults: input.adults,
      originAirportId: input.originAirportId,
      destinationCityId: input.destinationCityId,
      destinationCountryKey: input.destinationCountryKey,
      sightseeingDate: input.sightseeingDate,
      travelVariant: input.travelVariant,
      preferences,
      graphVersion: GRAPH_VERSION,
      creationRequestId: input.creationRequestId,
      creationPayloadHash: payloadHash,
    });
    const operation = await insertOperation(client, {
      tripId,
      requestId: input.creationRequestId,
      payloadHash,
      acceptedRevision: 1,
      kind: "creation",
      payload: input,
    });
    await insertEvent(client, {
      tripId,
      operationId: operation.id,
      type: "trip.created",
      payload: { revision: 1 },
    });
    await client.query("COMMIT");
    return { tripId, operationId: operation.id, revision: 1 };
  } catch (err) {
    await client.query("ROLLBACK");
    // Concurrent creation with the same (session, creation_request_id): the loser
    // of the unique index race returns the stored result or a payload conflict.
    if (isCreationUniqueViolation(err)) {
      const stored = await client.query<{ id: string; creation_payload_hash: string }>(
        `SELECT id, creation_payload_hash FROM odft_app.trips
          WHERE session_id = $1 AND creation_request_id = $2`,
        [sessionId, input.creationRequestId],
      );
      const trip = stored.rows[0];
      if (!trip) {
        return error("CONFLICT", "concurrent creation conflict");
      }
      if (trip.creation_payload_hash !== payloadHash) {
        return error("CREATION_CONFLICT", "the creation request id was reused with a different payload");
      }
      const operation = await client.query<{ id: string }>(
        `SELECT id FROM odft_app.workflow_operations
          WHERE trip_id = $1 AND kind = 'creation' ORDER BY created_at ASC LIMIT 1`,
        [trip.id],
      );
      const operationId = operation.rows[0]?.id;
      if (!operationId) {
        return error("CONFLICT", "existing trip has no initialization operation");
      }
      return { tripId: trip.id, operationId, revision: 1 };
    }
    throw err;
  } finally {
    client.release();
  }
}

function isCreationUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === "23505" && candidate.constraint === "trips_session_id_creation_request_id_key";
}

export async function admitOperation(
  pool: Pool,
  options: AdmitOperationOptions,
): Promise<AdmitOperationResult | ErrorEnvelope> {
  const { tripId, sessionId, request } = options;
  const command = "command" in request ? request.command : undefined;
  const payload = "command" in request ? request.command : { kind: "chat" as const, message: request.chat };
  const payloadHash = contentHash(request);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (command && isNoOpSetRoute(command)) {
      await client.query("ROLLBACK");
      return error("VALIDATION_FAILED", "set_route must change at least one route field");
    }

    // 1. Deduplicate on (trip_id, request_id) first.
    const existing = await getOperationByRequestId(client, tripId, request.requestId);
    if (existing) {
      // Ownership must be validated even on the dedupe path.
      const owner = await client.query<{ session_id: string }>(
        `SELECT session_id FROM odft_app.trips WHERE id = $1`,
        [tripId],
      );
      if (owner.rows[0]?.session_id !== sessionId) {
        await client.query("ROLLBACK");
        return error("FORBIDDEN", "trip is not owned by this session");
      }
      if (existing.record.payloadHash !== payloadHash) {
        await client.query("ROLLBACK");
        return error("CONFLICT", "the request id was reused with a different payload");
      }
      // A deduped chat request reuses the stored message (same request id).
      if (options.userMessage !== undefined) {
        await insertConversationMessage(client, {
          tripId,
          role: "user",
          content: options.userMessage,
          operationId: existing.record.id,
          requestId: request.requestId,
        });
      }
      await client.query("COMMIT");
      return {
        status: "accepted",
        operationId: existing.record.id,
        revision: existing.record.acceptedRevision,
        deduped: true,
      };
    }

    // 2. Lock and validate the trip.
    const trip = await lockTrip(client, tripId);
    if (!trip) {
      await client.query("ROLLBACK");
      return error("NOT_FOUND", "trip not found");
    }
    if (trip.sessionId !== sessionId) {
      await client.query("ROLLBACK");
      return error("FORBIDDEN", "trip is not owned by this session");
    }

    // Re-check the dedupe key now that we hold the trip lock: a concurrent
    // duplicate may have committed between the first lookup and the lock.
    const raced = await getOperationByRequestId(client, tripId, request.requestId);
    if (raced) {
      if (raced.record.payloadHash !== payloadHash) {
        await client.query("ROLLBACK");
        return error("CONFLICT", "the request id was reused with a different payload");
      }
      await client.query("COMMIT");
      return {
        status: "accepted",
        operationId: raced.record.id,
        revision: raced.record.acceptedRevision,
        deduped: true,
      };
    }

    if (trip.recoveryRequired) {
      await client.query("ROLLBACK");
      return error("RECOVERY_REQUIRED", "the trip must recover its unfinished operation first");
    }
    if (trip.revision !== request.expectedRevision) {
      await client.query("ROLLBACK");
      return error("STALE_REVISION", "expected revision does not match the current revision", {
        currentRevision: trip.revision,
      });
    }
    const active = await getActiveOperation(client, tripId);
    if (active) {
      await client.query("ROLLBACK");
      return error("OPERATION_IN_PROGRESS", "another operation is already queued or running", {
        retryable: true,
      });
    }

    const newRevision = trip.revision + 1;
    const operation = await insertOperation(client, {
      tripId,
      requestId: request.requestId,
      payloadHash,
      acceptedRevision: newRevision,
      kind: "command",
      payload,
    });
    await client.query(
      `UPDATE odft_app.trips SET revision = $2, workflow_status = 'queued', updated_at = now() WHERE id = $1`,
      [tripId, newRevision],
    );
    await insertEvent(client, {
      tripId,
      operationId: operation.id,
      type: "operation.admitted",
      payload: { revision: newRevision },
    });
    // The user message is stored in the SAME transaction as the operation, so a
    // crash cannot admit work without its conversation entry and the worker can
    // never process a chat before the message exists.
    if (options.userMessage !== undefined) {
      await insertConversationMessage(client, {
        tripId,
        role: "user",
        content: options.userMessage,
        operationId: operation.id,
        requestId: request.requestId,
      });
    }
    await client.query("COMMIT");
    return { status: "accepted", operationId: operation.id, revision: newRevision, deduped: false };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export type AdmissionAcceptedEnvelope = AdmissionAccepted;

export interface AdmitResumeOptions {
  readonly tripId: string;
  readonly sessionId: string;
  readonly request: ResumeRequest;
}

export interface AdmitResumeResult {
  readonly status: "accepted";
  readonly operationId: string;
  readonly revision: number;
  readonly deduped: boolean;
}

/**
 * Admit a decision resume (persistence half of Phase 03 §7 / Phase 05 wiring).
 * Validates the resume envelope, ownership, revision, and that the pending
 * decision accepts the submitted action. Does NOT increment `trip.revision`.
 */
export async function admitResume(
  pool: Pool,
  options: AdmitResumeOptions,
): Promise<AdmitResumeResult | ErrorEnvelope> {
  const parsed = resumeRequestSchema.safeParse(options.request);
  if (!parsed.success) {
    return error("VALIDATION_FAILED", "invalid resume request");
  }
  const request = parsed.data;
  const { tripId, sessionId } = options;
  const payloadHash = contentHash(request);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await getOperationByRequestId(client, tripId, request.requestId);
    if (existing) {
      const owner = await client.query<{ session_id: string }>(
        `SELECT session_id FROM odft_app.trips WHERE id = $1`,
        [tripId],
      );
      if (owner.rows[0]?.session_id !== sessionId) {
        await client.query("ROLLBACK");
        return error("FORBIDDEN", "trip is not owned by this session");
      }
      if (existing.record.payloadHash !== payloadHash) {
        await client.query("ROLLBACK");
        return error("CONFLICT", "the request id was reused with a different payload");
      }
      await client.query("COMMIT");
      return {
        status: "accepted",
        operationId: existing.record.id,
        revision: existing.record.acceptedRevision,
        deduped: true,
      };
    }

    const trip = await lockTrip(client, tripId);
    if (!trip) {
      await client.query("ROLLBACK");
      return error("NOT_FOUND", "trip not found");
    }
    if (trip.sessionId !== sessionId) {
      await client.query("ROLLBACK");
      return error("FORBIDDEN", "trip is not owned by this session");
    }
    const raced = await getOperationByRequestId(client, tripId, request.requestId);
    if (raced) {
      if (raced.record.payloadHash !== payloadHash) {
        await client.query("ROLLBACK");
        return error("CONFLICT", "the request id was reused with a different payload");
      }
      await client.query("COMMIT");
      return {
        status: "accepted",
        operationId: raced.record.id,
        revision: raced.record.acceptedRevision,
        deduped: true,
      };
    }
    if (trip.recoveryRequired) {
      await client.query("ROLLBACK");
      return error("RECOVERY_REQUIRED", "the trip must recover its unfinished operation first");
    }
    if (trip.revision !== request.expectedRevision) {
      await client.query("ROLLBACK");
      return error("STALE_REVISION", "expected revision does not match the current revision", {
        currentRevision: trip.revision,
      });
    }
    const active = await getActiveOperation(client, tripId);
    if (active) {
      await client.query("ROLLBACK");
      return error("OPERATION_IN_PROGRESS", "another operation is already queued or running", {
        retryable: true,
      });
    }
    const decision = await loadDecision(client, request.decisionId);
    if (!decision || decision.tripId !== tripId || decision.status !== "pending") {
      await client.query("ROLLBACK");
      return error("STALE_DECISION", "decision is missing, resolved, or owned by another trip");
    }
    if (!DECISION_ALLOWED_ACTIONS[decision.kind].includes(request.response.action)) {
      await client.query("ROLLBACK");
      return error("STALE_DECISION", "response action does not match the pending decision kind");
    }
    // `choose_option` must select an option the decision actually offered.
    if (
      request.response.action === "choose_option" &&
      Array.isArray(decision.allowedOptionIds) &&
      !decision.allowedOptionIds.includes(request.response.optionId)
    ) {
      await client.query("ROLLBACK");
      return error("STALE_DECISION", "the selected option is not offered by the pending decision");
    }
    // `choose_offer` must select a combination/offer the decision actually offered.
    if (
      request.response.action === "choose_offer" &&
      Array.isArray(decision.allowedOfferIds) &&
      !decision.allowedOfferIds.includes(request.response.offerId)
    ) {
      await client.query("ROLLBACK");
      return error("STALE_DECISION", "the selected offer is not offered by the pending decision");
    }
    // A confirmation must target the proposal the pending decision is bound to.
    if (
      (request.response.action === "confirm_booking" ||
        request.response.action === "confirm_route_change") &&
      decision.proposalId &&
      decision.proposalId !== request.response.proposalId
    ) {
      await client.query("ROLLBACK");
      return error("STALE_DECISION", "the confirmation does not match the pending proposal");
    }
    // Phase 11: a route-change confirmation carries no selection proposal, so it
    // is bound to the persisted impact preview: the proposal id must match and
    // the named reservations must be exactly the previewed ones.
    if (request.response.action === "confirm_route_change") {
      const preview = await client.query<{ proposal_id: string | null; affected: unknown }>(
        `SELECT option_payload->>'proposalId' AS proposal_id,
                option_payload->'affectedReservations' AS affected
           FROM odft_app.pending_decisions WHERE id = $1`,
        [request.decisionId],
      );
      const row = preview.rows[0];
      const affectedIds = Array.isArray(row?.affected)
        ? (row?.affected as { id?: unknown }[])
            .map((entry) => (typeof entry?.id === "string" ? entry.id : null))
            .filter((id): id is string => id !== null)
            .sort()
        : [];
      const named = [...request.response.affectedReservationIds].sort();
      if (
        !row ||
        row.proposal_id !== request.response.proposalId ||
        affectedIds.length === 0 ||
        affectedIds.join(",") !== named.join(",")
      ) {
        await client.query("ROLLBACK");
        return error(
          "STALE_DECISION",
          "the confirmation does not match the persisted route-change impact preview",
        );
      }
    }

    const operation = await insertOperation(client, {
      tripId,
      requestId: request.requestId,
      payloadHash,
      acceptedRevision: trip.revision,
      kind: "decision",
      payload: request,
    });
    await insertEvent(client, {
      tripId,
      operationId: operation.id,
      type: "decision.admitted",
      payload: { revision: trip.revision, decisionId: request.decisionId },
    });
    await client.query("COMMIT");
    return { status: "accepted", operationId: operation.id, revision: trip.revision, deduped: false };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
