"use client";

import { useTripProjection } from "@/lib/use-trip-projection";

/**
 * Phase 09 history notice (ODTF_PLAN.md §3.16 step 6).
 *
 * An archived trip is read-only history: this banner explains why every
 * mutation control on the page is disabled, and the layout renders it above
 * the step content. Active trips render nothing.
 */
export function HistoryNotice({ tripId }: { readonly tripId: string }): React.JSX.Element | null {
  // Secondary reader: refetches on SSE events only, so the page keeps its
  // single polling loop in the rail/step content (one-poller rule).
  const { projection } = useTripProjection(tripId, { poll: false });
  if (!projection?.historyReadOnly) {
    return null;
  }
  return (
    <p
      role="note"
      data-testid="history-notice"
      className="rounded border border-border bg-cream px-4 py-2 text-sm text-ink-muted"
    >
      This trip is archived history and is read-only — bookings, changes, and assistant
      messages are disabled.
    </p>
  );
}
