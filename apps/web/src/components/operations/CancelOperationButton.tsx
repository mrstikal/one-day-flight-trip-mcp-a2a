"use client";

import { useRef, useState } from "react";
import { ApiError, apiPost } from "@/lib/api-client";
import type { CancelOperationResult } from "@odft/contracts";

/**
 * Phase 09 explicit operation cancellation (ODTF_PLAN.md §3.13).
 *
 * Rendered next to a queued/running/waiting operation: sends one technical
 * control action that never increments `trip.revision`. A duplicate click
 * replays the stored result; a settled operation reports a conflict instead.
 */
export function CancelOperationButton({
  tripId,
  operationId,
  revision,
  onCancelled,
}: {
  readonly tripId: string;
  readonly operationId: string;
  readonly revision: number;
  readonly onCancelled: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // One control id per logical cancel: a retry after a committed-but-lost
  // response replays the stored result instead of conflicting.
  const controlRequestId = useRef(crypto.randomUUID());

  async function cancel(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await apiPost<CancelOperationResult>(
        `/api/trips/${tripId}/operations/${operationId}/cancel`,
        { controlRequestId: controlRequestId.current, expectedRevision: revision },
      );
      onCancelled();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "The operation could not be cancelled.",
      );
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        data-testid={`cancel-${operationId}`}
        disabled={busy}
        onClick={() => void cancel()}
        className="w-fit rounded border border-clay px-3 py-1.5 text-sm font-medium text-clay hover:bg-clay hover:text-paper disabled:opacity-50"
      >
        {busy ? "Cancelling…" : "Cancel operation"}
      </button>
      {error ? (
        <span role="alert" className="text-sm text-clay">
          {error}
        </span>
      ) : null}
    </span>
  );
}
