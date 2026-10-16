import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { DecisionKind } from "@odft/contracts";
import { insertEvent } from "../events.js";

/**
 * Fenced, single-transaction operation finalization (Phase 05).
 *
 * The operation transition, trip projection, pending-decision binding, and
 * execution event are committed together. A crash therefore cannot leave the
 * graph paused at an interrupt with no decision row, or a completed operation
 * with a stale projection — either the whole transition commits or none of it
 * does. Every statement is gated by the exact `fencing_token`, so a stale worker
 * finalizes nothing.
 */

export interface FinalizeFence {
  readonly operationId: string;
  readonly tripId: string;
  readonly fencingToken: string;
}

export interface WaitingSpec {
  readonly kind: DecisionKind;
  readonly fingerprint: string;
  readonly allowedOptionIds: readonly string[];
  readonly graphVersion: string;
  readonly createdRevision: number;
  /** Proposal a confirmation decision is bound to (booking/replacement decisions). */
  readonly proposalId?: string;
  /** Offer ids a `choose_offer` response may select. */
  readonly allowedOfferIds?: readonly string[];
  /** Server-side clarification question/labels (jsonb; never raw commands to the client). */
  readonly optionPayload?: unknown;
  /** LangGraph checkpoint id the interrupt was raised at (inspector evidence). */
  readonly checkpointId?: string | null;
  /** LangGraph interrupt id of the awaited interrupt (inspector evidence). */
  readonly interruptId?: string | null;
}

async function transitionOperation(
  client: Pick<PoolClient, "query">,
  fence: FinalizeFence,
  setClause: string,
  params: unknown[],
): Promise<boolean> {
  const result = await client.query(
    `UPDATE odft_app.workflow_operations
        SET ${setClause}, lease_expires_at = NULL, claimed_by = NULL, updated_at = now()
      WHERE id = $1 AND fencing_token = $2::bigint AND status = 'running'`,
    [fence.operationId, fence.fencingToken, ...params],
  );
  return result.rowCount === 1;
}

/** Persist a `waiting` transition together with its pending decision and the trip projection. */
export async function finalizeWaiting(
  pool: Pool,
  fence: FinalizeFence,
  spec: WaitingSpec,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const committed = await transitionOperation(
      client,
      fence,
      "status = 'waiting', result = $3::jsonb",
      [JSON.stringify({ kind: spec.kind })],
    );
    if (!committed) {
      await client.query("ROLLBACK");
      return false;
    }

    // Retire any pending decision that this interrupt supersedes. A row is kept
    // only for an EXACT replay of the same decision: the same kind, fingerprint,
    // proposal, and offered ids. A descriptor that differs in any bound id (e.g.
    // a modification refreshed the offers while keeping the same kind and
    // fingerprint) must replace the row — otherwise the stored allowlist would go
    // stale and the next resume of a freshly rendered offer would be refused as
    // STALE_DECISION.
    await client.query(
      `UPDATE odft_app.pending_decisions
          SET status = 'cancelled', resolved_at = now()
        WHERE trip_id = $1 AND status = 'pending'
          AND NOT (
            kind = $2
            AND source_fingerprint = $3
            AND allowed_offer_ids = $4::jsonb
            AND allowed_option_ids = $5::jsonb
            AND proposal_id IS NOT DISTINCT FROM $6::uuid
          )`,
      [
        fence.tripId,
        spec.kind,
        spec.fingerprint,
        JSON.stringify(spec.allowedOfferIds ?? []),
        JSON.stringify(spec.allowedOptionIds),
        spec.proposalId ?? null,
      ],
    );
    // Insert the current decision; an exact replay (same kind, fingerprint, and
    // bound ids) left the row in place above, so this insert is a no-op then.
    await client.query(
      `INSERT INTO odft_app.pending_decisions
         (id, trip_id, kind, thread_id, graph_version, created_revision, source_fingerprint,
          proposal_id, allowed_offer_ids, allowed_option_ids, option_payload, payload_hash, status,
          checkpoint_id, interrupt_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $7, 'pending',
               $12, $13)
       ON CONFLICT DO NOTHING`,
      [
        randomUUID(),
        fence.tripId,
        spec.kind,
        fence.tripId,
        spec.graphVersion,
        spec.createdRevision,
        spec.fingerprint,
        spec.proposalId ?? null,
        JSON.stringify(spec.allowedOfferIds ?? []),
        JSON.stringify(spec.allowedOptionIds),
        JSON.stringify(spec.optionPayload ?? []),
        spec.checkpointId ?? null,
        spec.interruptId ?? null,
      ],
    );
    await client.query(
      `UPDATE odft_app.trips SET workflow_status = 'waiting_user', updated_at = now() WHERE id = $1`,
      [fence.tripId],
    );
    await insertEvent(client, {
      tripId: fence.tripId,
      operationId: fence.operationId,
      type: "decision.awaiting",
      payload: { kind: spec.kind },
    });
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface SuccessSpec {
  readonly result: unknown;
  readonly summary: string;
  readonly resolveDecisionId?: string;
  /** Terminal trip projection status; defaults to `ready`. */
  readonly workflowStatus?: "ready" | "blocked";
}

/** Persist a `succeeded` transition with the trip projection and decision resolution. */
export async function finalizeSuccess(
  pool: Pool,
  fence: FinalizeFence,
  spec: SuccessSpec,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const committed = await transitionOperation(
      client,
      fence,
      "status = 'succeeded', result = $3::jsonb, completed_at = now()",
      [JSON.stringify(spec.result ?? null)],
    );
    if (!committed) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `UPDATE odft_app.trips SET workflow_status = $2, updated_at = now() WHERE id = $1`,
      [fence.tripId, spec.workflowStatus ?? "ready"],
    );
    if (spec.resolveDecisionId) {
      await client.query(
        `UPDATE odft_app.pending_decisions SET status = 'resolved', resolved_at = now()
          WHERE id = $1 AND status = 'pending'`,
        [spec.resolveDecisionId],
      );
    }
    await insertEvent(client, {
      tripId: fence.tripId,
      operationId: fence.operationId,
      type: "operation.succeeded",
      payload: { summary: spec.summary },
    });
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface FailureSpec {
  readonly code: string;
  /** True when the automatic-claim budget is exhausted (trip requires owner recovery). */
  readonly exhausted: boolean;
  /** Diagnostic detail stored on the operation result (never sent to events). */
  readonly message?: string;
}

/**
 * Persist a `failed` transition. When not exhausted, the operation is released
 * back to `queued` for the next bounded automatic attempt instead.
 */
export async function finalizeFailure(
  pool: Pool,
  fence: FinalizeFence,
  spec: FailureSpec,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (spec.exhausted) {
      const committed = await transitionOperation(
        client,
        fence,
        "status = 'failed', result = $3::jsonb, completed_at = now()",
        [
          JSON.stringify(
            spec.message ? { code: spec.code, message: spec.message } : { code: spec.code },
          ),
        ],
      );
      if (!committed) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `UPDATE odft_app.trips
            SET recovery_required = true, workflow_status = 'failed',
                last_unfinished_operation_id = $2, updated_at = now()
          WHERE id = $1`,
        [fence.tripId, fence.operationId],
      );
    } else {
      const released = await client.query(
        `UPDATE odft_app.workflow_operations
            SET status = 'queued', lease_expires_at = NULL, claimed_by = NULL, updated_at = now()
          WHERE id = $1 AND fencing_token = $2::bigint AND status = 'running'`,
        [fence.operationId, fence.fencingToken],
      );
      if (released.rowCount !== 1) {
        await client.query("ROLLBACK");
        return false;
      }
    }
    await insertEvent(client, {
      tripId: fence.tripId,
      operationId: fence.operationId,
      type: "operation.failed",
      payload: { code: spec.code },
    });
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Persist a `failed` transition for a rejected operation.
 *
 * By default the trip projection is restored for the decision the client can
 * still answer (`waiting_user` when one is pending, else `ready`). When the call
 * rejected a run whose graph head is unfinished work owned by a *different*
 * operation, pass `unfinishedOperationId`: there is no answerable interrupt left,
 * so the trip must expose the unfinished failed checkpoint for owner recovery
 * (RECOVERY_REQUIRED) instead of presenting a decision that can never be applied.
 */
export async function finalizeConflict(
  pool: Pool,
  fence: FinalizeFence,
  spec: { code: string; message: string; unfinishedOperationId?: string },
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const committed = await transitionOperation(
      client,
      fence,
      "status = 'failed', result = $3::jsonb, completed_at = now()",
      [JSON.stringify({ code: spec.code, message: spec.message })],
    );
    if (!committed) {
      await client.query("ROLLBACK");
      return false;
    }
    // Restore the trip projection: a rejected operation must not leave the trip
    // stuck in `queued`. It returns to `waiting_user` when a decision is still
    // pending (the usual pre-Phase-08 case) and to `ready` otherwise (e.g. a chat
    // command that was admitted while the trip was decision-free). An unfinished
    // failed checkpoint instead exposes owner recovery for its owning operation.
    if (spec.unfinishedOperationId) {
      await client.query(
        `UPDATE odft_app.trips
            SET recovery_required = true, workflow_status = 'failed',
                last_unfinished_operation_id = $2, updated_at = now()
          WHERE id = $1`,
        [fence.tripId, spec.unfinishedOperationId],
      );
    } else {
      await client.query(
        `UPDATE odft_app.trips
            SET workflow_status = CASE
                  WHEN EXISTS (
                    SELECT 1 FROM odft_app.pending_decisions
                     WHERE trip_id = $1 AND status = 'pending'
                  ) THEN 'waiting_user'
                  ELSE 'ready'
                END,
                updated_at = now()
          WHERE id = $1`,
        [fence.tripId],
      );
    }
    await insertEvent(client, {
      tripId: fence.tripId,
      operationId: fence.operationId,
      type: "operation.rejected",
      payload: { code: spec.code },
    });
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
