import type { Pool } from "pg";
import { claimNextOperation, reapExhaustedOperations, type ClaimedOperation } from "@odft/persistence";
import type { OperationDriver } from "./driver.js";
import type { ShutdownController } from "./shutdown.js";

/**
 * Bounded concurrency claim loop (02-architecture.md section 6). Claims up to
 * `concurrency` ready operations and drives each under its own trip lock and
 * lease. Claiming stops as soon as shutdown is requested; in-flight work is
 * aborted and drained within the grace window so a blocked run cannot hold the
 * process forever.
 */

export interface ClaimLoopOptions {
  readonly operationsPool: Pool;
  readonly driver: OperationDriver;
  readonly shutdown: ShutdownController;
  readonly workerId: string;
  readonly leaseMs: number;
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  readonly graceMs: number;
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

export async function runClaimLoop(options: ClaimLoopOptions): Promise<void> {
  const active = new Set<Promise<void>>();

  const track = (claim: ClaimedOperation): void => {
    const release = options.shutdown.enter();
    const task = options.driver
      .runOperation(claim)
      .catch((error: unknown) => {
        options.logger({
          level: "error",
          component: "worker",
          message: "operation failed unexpectedly",
          operationId: claim.operationId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        active.delete(task);
        release();
      });
    active.add(task);
  };

  while (!options.shutdown.isStopping) {
    if (active.size >= options.concurrency) {
      // Race the active work against a shutdown-aware sleep so a shutdown request
      // is noticed even while the concurrency limit is saturated.
      await Promise.race([...active, sleep(options.pollIntervalMs, options.shutdown.signal)]);
      continue;
    }
    let claim: ClaimedOperation | null;
    try {
      // Reap operations whose worker crashed after exhausting its claim budget,
      // so they do not block their trip forever.
      await reapExhaustedOperations(options.operationsPool).catch(() => {});
      claim = await claimNextOperation(options.operationsPool, {
        workerId: options.workerId,
        leaseMs: options.leaseMs,
      });
    } catch (error) {
      options.logger({
        level: "error",
        component: "worker",
        message: "claim failed",
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(options.pollIntervalMs, options.shutdown.signal);
      continue;
    }
    if (!claim) {
      await sleep(options.pollIntervalMs, options.shutdown.signal);
      continue;
    }
    track(claim);
  }

  // Drain in-flight work, bounded by the grace window (the driver aborts on the
  // shutdown signal, so this normally resolves quickly).
  await Promise.race([
    Promise.allSettled([...active]),
    sleep(options.graceMs, new AbortController().signal),
  ]);
}
