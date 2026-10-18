import type { Pool } from "pg";
import { reconcileOutboxes, type CancelTaskTransport } from "@odft/workflow";
import type { ShutdownController } from "./shutdown.js";

/**
 * Phase 09 durable outbox reconciler loop (ODTF_PLAN.md §3.13/§3.15 step 1).
 *
 * Runs alongside the claim loops on a slow interval (independent of any
 * operation claim or fence):
 *
 * 1. Observation bridge: unlinked `protocol_observations` rows become
 *    `protocol.observed` application events — including late observations
 *    whose operation already ended — so the timeline keeps chronological
 *    source order under SSE reconnects.
 * 2. Cancel outbox: persisted `cancellation_state = 'pending'` intents get
 *    one bounded SDK `cancelTask` attempt; the outcome persists as inspector
 *    evidence. Local revocation already happened atomically in
 *    `cancelOperation`, so the remote outcome never gates correctness.
 *
 * Failures are logged and retried on the next interval; the loop never throws.
 */

export interface ReconcileLoopOptions {
  readonly operationsPool: Pool;
  readonly shutdown: ShutdownController;
  readonly transport: CancelTaskTransport;
  readonly intervalMs?: number;
  readonly logger: (record: Record<string, unknown>) => void;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const DEFAULT_RECONCILE_INTERVAL_MS = 5_000;

export async function runReconcileLoop(options: ReconcileLoopOptions): Promise<void> {
  const intervalMs = options.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
  while (!options.shutdown.isStopping) {
    try {
      const result = await reconcileOutboxes(options.operationsPool, options.transport, {
        onSkippedObservation: ({ observationId, error }) => {
          options.logger({
            level: "warn",
            component: "reconciler",
            message: "observation bridge skipped a row",
            observationId,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      });
      if (result.bridged.length > 0 || result.cancels.length > 0) {
        options.logger({
          level: "info",
          component: "reconciler",
          message: "outboxes reconciled",
          bridged: result.bridged.length,
          cancels: result.cancels.length,
        });
      }
    } catch (error) {
      options.logger({
        level: "error",
        component: "reconciler",
        message: "reconcile round failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await sleep(intervalMs, options.shutdown.signal);
  }
}
