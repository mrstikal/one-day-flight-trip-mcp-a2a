"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { PublicItinerary } from "@odft/contracts";
import { DEMO_DISCLAIMER } from "@/lib/disclaimers";
import { formatEuroMinor } from "@/lib/format/money";

/**
 * Approval dialog (Phase 10 section 7): names the exact version being approved,
 * disables the confirm action while blocking errors remain, and requires the
 * explicit acknowledgement. Focus is trapped while open (accessibility rules).
 */
export function ApprovalDialog({
  open,
  itinerary,
  canApprove,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  readonly open: boolean;
  readonly itinerary: PublicItinerary;
  readonly canApprove: boolean;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element | null {
  if (!open) {
    return null;
  }
  return (
    <DialogBody
      itinerary={itinerary}
      canApprove={canApprove}
      busy={busy}
      error={error}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

function DialogBody({
  itinerary,
  canApprove,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  readonly itinerary: PublicItinerary;
  readonly canApprove: boolean;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      previouslyFocused?.focus?.();
    };
  }, []);

  function focusableItems(): HTMLElement[] {
    const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    return nodes ? Array.from(nodes) : [];
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const items = focusableItems();
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-heading"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        data-testid="approval-dialog"
        className="flex w-full max-w-lg flex-col gap-4 rounded border border-border bg-paper p-6 shadow-xl"
      >
        <h2 id="approval-heading" className="text-xl">
          Approve itinerary version {itinerary.version}
        </h2>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-ink-muted">Status</dt>
          <dd className="capitalize">{itinerary.status}</dd>
          <dt className="text-ink-muted">Sightseeing day</dt>
          <dd>{itinerary.sightseeingDate}</dd>
          <dt className="text-ink-muted">Zone</dt>
          <dd>{itinerary.zone}</dd>
          <dt className="text-ink-muted">Party total</dt>
          <dd>{formatEuroMinor(itinerary.costs.totalMinor)}</dd>
        </dl>
        <p role="note" className="rounded bg-info p-3 text-sm text-clay">
          You are approving version {itinerary.version} of this plan. A later change creates a new
          draft; the approved version stays preserved. Nothing is booked or paid by approving.
        </p>
        {error ? (
          <p className="text-sm text-clay" role="alert">
            {error}
          </p>
        ) : null}
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            aria-label="I understand this approves the current itinerary version"
            className="mt-1"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          I understand this approves the current itinerary version.
        </label>
        <p role="note" className="text-xs text-ink-muted">
          {DEMO_DISCLAIMER}
        </p>
        <div className="flex flex-wrap justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-border px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="approve-itinerary"
            onClick={onConfirm}
            disabled={!acknowledged || busy || !canApprove}
            className="rounded bg-teal px-4 py-2 text-sm font-medium text-paper hover:bg-teal-strong disabled:opacity-50"
          >
            {busy ? "Approving…" : "Approve itinerary"}
          </button>
        </div>
      </div>
    </div>
  );
}