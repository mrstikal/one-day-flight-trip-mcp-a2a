import type { Pool } from "pg";
import { LEASE_RENEW_MS, renewLease, type ClaimedOperation } from "@odft/persistence";

/**
 * Lease heartbeat (02-architecture.md section 6): renew well before the lease
 * expires. A failed renewal or a fenced-out owner means this process has lost
 * exclusive ownership, so local work is aborted immediately.
 */
export function startLeaseRenewal(
  pool: Pool,
  claim: ClaimedOperation,
  abort: AbortController,
  options: { intervalMs?: number; onLost?: (error: unknown) => void } = {},
): () => void {
  const intervalMs = options.intervalMs ?? LEASE_RENEW_MS;
  let lost = false;
  const timer = setInterval(() => {
    if (lost) {
      return;
    }
    void renewLease(pool, claim)
      .then((renewed) => {
        if (!renewed) {
          lost = true;
          options.onLost?.(new Error("lease lost: fencing token no longer current"));
          abort.abort(new Error("lease lost"));
        }
      })
      .catch((error: unknown) => {
        lost = true;
        options.onLost?.(error);
        abort.abort(error instanceof Error ? error : new Error("lease renewal failed"));
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
