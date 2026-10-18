import type { Pool } from "pg";
import {
  bridgeObservationToEvent,
  claimDelegationCancel,
  listPendingDelegationCancels,
  listUnlinkedObservations,
  markObservationBridgeSkipped,
  resolveDelegationCancellation,
  type ProtocolObservationRecord,
} from "@odft/persistence";

/**
 * Phase 09 durable observation/cancel reconciler
 * (ODTF_PLAN.md §3.13/§3.15, Phase 09 steps 1 and 5).
 *
 * Two independent outboxes, both processed outside any operation claim or
 * fence:
 *
 * 1. Observation bridge: unlinked `protocol_observations` rows become
 *    `protocol.observed` application events (with the SOURCE timestamp
 *    preserved as `observedAt`, so the timeline keeps chronological source
 *    order). Late observations reconcile even after their operation ended;
 *    the unique observation→event link makes the bridge idempotent under
 *    SSE reconnects.
 * 2. Cancel outbox: delegations with a persisted `cancellation_state =
 *    'pending'` intent get one bounded SDK `cancelTask` attempt through the
 *    injected transport. Remote cancellation is best effort (the task may
 *    have completed already): the final `acknowledged`/`failed` outcome is
 *    persisted as inspector evidence. Local revocation already happened
 *    atomically in `cancelOperation`, so late artifacts stay inadmissible
 *    regardless of the remote outcome.
 */

export interface CancelTaskTransport {
  /** Best-effort remote SDK cancellation of one specialist task. */
  cancelTask(input: {
    agentIdentity: string;
    delegationId: string;
    taskId: string;
  }): Promise<void>;
}

export interface ObservationBridgeSummary {
  readonly observationId: string;
  readonly eventId: string;
}

export interface CancelReconcileSummary {
  readonly delegationId: string;
  readonly outcome: "acknowledged" | "failed";
}

export interface ReconcileOutboxesResult {
  readonly bridged: readonly ObservationBridgeSummary[];
  readonly cancels: readonly CancelReconcileSummary[];
}

const MAX_BRIDGE_PER_ROUND = 100;
const MAX_CANCEL_PER_ROUND = 25;

/** Safe one-line summary of an observation for the timeline event. */
function summarizeObservation(record: ProtocolObservationRecord): string | null {
  const detail =
    typeof record.payload.detail === "string" && record.payload.detail.length > 0
      ? record.payload.detail.slice(0, 200)
      : null;
  const status = record.payload.status;
  const summary = [record.kind, record.source, detail ?? status].filter(Boolean).join(" · ");
  return summary.length > 0 ? summary.slice(0, 200) : null;
}

export async function bridgePendingObservations(
  pool: Pool,
  options: {
    readonly limit?: number;
    readonly onSkipped?: (info: { observationId: string; error: unknown }) => void;
    /** Quarantine corrupt rows out of the bridge window after N failures (default 3). */
    readonly maxSkipsBeforeQuarantine?: number;
  } = {},
): Promise<readonly ObservationBridgeSummary[]> {
  // Each observation bridges in its own transaction (insert + link commit
  // atomically inside `bridgeObservationToEvent`); a corrupt row is skipped
  // so one bad payload can never wedge the whole round.
  const client = await pool.connect();
  let unlinked;
  try {
    unlinked = await listUnlinkedObservations(
      client,
      Math.max(1, Math.min(options.limit ?? MAX_BRIDGE_PER_ROUND, 500)),
    );
  } finally {
    client.release();
  }
  const bridged: ObservationBridgeSummary[] = [];
  // Per-round skip counts: a corrupt row that keeps failing is quarantined
  // out of the bridge window after the budget, so it can never starve valid
  // observations behind the LIMIT window.
  const skips = new Map<string, number>();
  const maxSkips = Math.max(1, options.maxSkipsBeforeQuarantine ?? 3);
  for (const record of unlinked) {
    if (!record.correlation.tripId) {
      continue;
    }
    // Computed once per observation (never twice per bridge).
    const summary = summarizeObservation(record);
    try {
      const eventId = await bridgeObservationToEvent(pool, {
        observationId: record.id,
        tripId: record.correlation.tripId,
        operationId: record.correlation.operationId,
        type: "protocol.observed",
        payload: {
          kind: record.kind,
          source: record.source,
          observationId: record.id,
          ...(record.correlation.delegationId
            ? { delegationId: record.correlation.delegationId }
            : {}),
          observedAt: record.occurredAt,
          ...(summary ? { summary } : {}),
        },
      });
      bridged.push({ observationId: record.id, eventId });
    } catch (error) {
      // A corrupt row stays unlinked for a later pass; the round continues.
      // Reported through the hook so a persistently failing observation is
      // visible in worker logs instead of silently skipped. Past the budget
      // the row is quarantined out of the bridge window (stays queryable).
      options.onSkipped?.({ observationId: record.id, error });
      const count = (skips.get(record.id) ?? 0) + 1;
      skips.set(record.id, count);
      if (count >= maxSkips) {
        await markObservationBridgeSkipped(pool, record.id).catch(() => undefined);
      }
      continue;
    }
  }
  return bridged;
}

export async function reconcilePendingCancels(
  pool: Pool,
  transport: CancelTaskTransport,
  options: { readonly limit?: number; readonly maxAttempts?: number } = {},
): Promise<readonly CancelReconcileSummary[]> {
  // Bounded retries: a transient transport failure leaves the intent `pending`
  // (attempt counter incremented) until the budget is exhausted; only then
  // does it settle as `failed` inspector evidence. Each intent is CLAIMED via
  // a guarded UPDATE before dispatch, so a concurrent reconciler loses the
  // race and skips the transport call instead of double-dispatching.
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const client = await pool.connect();
  try {
    const pending = await listPendingDelegationCancels(
      client,
      Math.max(1, Math.min(options.limit ?? MAX_CANCEL_PER_ROUND, 100)),
    );
    const outcomes: CancelReconcileSummary[] = [];
    for (const intent of pending) {
      if (!intent.taskId) {
        // Never dispatched: nothing remote to cancel; the intent is complete.
        await resolveDelegationCancellation(client, {
          delegationId: intent.delegationId,
          state: "acknowledged",
        });
        outcomes.push({ delegationId: intent.delegationId, outcome: "acknowledged" });
        continue;
      }
      // Claim first: the loser of a concurrent round skips dispatch entirely.
      // The claim itself counts as the attempt, so the budget math below uses
      // the pre-claim count (`intent.attempts + 1` = attempts including this round).
      const claimed = await claimDelegationCancel(client, intent.delegationId);
      if (!claimed) {
        continue;
      }
      try {
        await transport.cancelTask({
          agentIdentity: intent.agentIdentity,
          delegationId: intent.delegationId,
          taskId: intent.taskId,
        });
        await resolveDelegationCancellation(client, {
          delegationId: intent.delegationId,
          state: "acknowledged",
        });
        outcomes.push({ delegationId: intent.delegationId, outcome: "acknowledged" });
      } catch {
        if (intent.attempts + 1 >= maxAttempts) {
          await resolveDelegationCancellation(client, {
            delegationId: intent.delegationId,
            state: "failed",
          });
          outcomes.push({ delegationId: intent.delegationId, outcome: "failed" });
        }
        // Below budget: stays `pending` for the next reconcile round.
      }
    }
    return outcomes;
  } finally {
    client.release();
  }
}

/**
 * Run both outboxes in one pass. Observation bridging never fails the round:
 * a corrupt row is skipped (it stays unlinked for a later pass); cancel
 * outcomes are always persisted per-intent, never thrown.
 */
export async function reconcileOutboxes(
  pool: Pool,
  transport: CancelTaskTransport,
  options: {
    readonly observationLimit?: number;
    readonly cancelLimit?: number;
    readonly onSkippedObservation?: (info: { observationId: string; error: unknown }) => void;
  } = {},
): Promise<ReconcileOutboxesResult> {
  const bridged = await bridgePendingObservations(pool, {
    limit: options.observationLimit,
    onSkipped: options.onSkippedObservation,
  });
  const cancels = await reconcilePendingCancels(pool, transport, {
    limit: options.cancelLimit,
  });
  return { bridged, cancels };
}
