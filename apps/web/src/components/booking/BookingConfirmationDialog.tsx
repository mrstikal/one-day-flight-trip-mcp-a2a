"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CONFIRMATION_DISCLAIMER, DEMO_DISCLAIMER } from "@/lib/disclaimers";

/**
 * Generic simulated-booking confirmation dialog (09 sections 6 and 10). It
 * renders a server-computed summary and requires the acknowledgement checkbox;
 * the confirm action is never enabled without it. The body mounts only while
 * open, so the acknowledgement resets on every close/reopen.
 */
export function BookingConfirmationDialog({
  open,
  heading,
  summary,
  busy,
  error,
  onConfirm,
  onCancel,
  onReject,
  rejectLabel,
}: {
  readonly open: boolean;
  readonly heading: string;
  readonly summary: React.ReactNode;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly onReject?: () => void;
  readonly rejectLabel?: string;
}): React.JSX.Element | null {
  if (!open) {
    return null;
  }
  return (
    <DialogBody
      heading={heading}
      summary={summary}
      busy={busy}
      error={error}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...(onReject ? { onReject } : {})}
      {...(rejectLabel ? { rejectLabel } : {})}
    />
  );
}

function DialogBody({
  heading,
  summary,
  busy,
  error,
  onConfirm,
  onCancel,
  onReject,
  rejectLabel,
}: {
  readonly heading: string;
  readonly summary: React.ReactNode;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly onReject?: () => void;
  readonly rejectLabel?: string;
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
        aria-labelledby="booking-confirmation-heading"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex w-full max-w-lg flex-col gap-4 rounded border border-border bg-paper p-6 shadow-xl"
      >
        <h2 id="booking-confirmation-heading" className="text-xl">
          {heading}
        </h2>
        {summary}
        <p role="note" className="rounded bg-info p-3 text-sm text-clay">
          {CONFIRMATION_DISCLAIMER}
        </p>
        <p role="note" className="text-xs text-ink-muted">
          {DEMO_DISCLAIMER}
        </p>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            aria-label="I understand this is a simulated booking"
            className="mt-1"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          I understand this is a simulated booking.
        </label>
        {error ? (
          <p className="text-sm text-clay" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-3">
          {onReject ? (
            <button
              type="button"
              onClick={onReject}
              disabled={busy}
              className="rounded border border-border px-4 py-2 text-sm disabled:opacity-50"
            >
              {rejectLabel ?? "Choose a different option"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-border px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!acknowledged || busy}
            className="rounded bg-teal px-4 py-2 text-sm font-medium text-paper hover:bg-teal-strong disabled:opacity-50"
          >
            {busy ? "Confirming…" : "Confirm simulated booking"}
          </button>
        </div>
      </div>
    </div>
  );
}
