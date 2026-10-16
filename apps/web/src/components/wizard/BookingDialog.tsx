"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { PublicFlightCombination, PublicProposal } from "@odft/contracts";
import { CONFIRMATION_DISCLAIMER, DEMO_DISCLAIMER } from "@/lib/disclaimers";
import { formatDate, formatDuration, formatTime } from "@/lib/format/datetime";
import { formatEuroMinor } from "@/lib/format/money";

/**
 * Modal booking confirmation. It shows the concrete itinerary being confirmed
 * (route, dates, times, party, price) so a reloaded pending decision can still be
 * reviewed. The body mounts only while open, so the acknowledgement resets on
 * every close/reopen without an effect.
 */
export function BookingDialog({
  open,
  flight,
  proposal,
  busy,
  error,
  onConfirm,
  onReject,
  onClose,
}: {
  readonly open: boolean;
  readonly flight: PublicFlightCombination | null;
  readonly proposal: PublicProposal | null;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onConfirm: () => void;
  readonly onReject?: () => void;
  readonly onClose: () => void;
}): React.JSX.Element | null {
  if (!open) {
    return null;
  }
  return (
    <DialogBody
      flight={flight}
      proposal={proposal}
      busy={busy}
      error={error}
      onConfirm={onConfirm}
      {...(onReject ? { onReject } : {})}
      onClose={onClose}
    />
  );
}

function DialogBody({
  flight,
  proposal,
  busy,
  error,
  onConfirm,
  onReject,
  onClose,
}: {
  readonly flight: PublicFlightCombination | null;
  readonly proposal: PublicProposal | null;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onConfirm: () => void;
  readonly onReject?: () => void;
  readonly onClose: () => void;
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
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    return nodes ? Array.from(nodes) : [];
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
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

  const outbound = flight?.outbound.segments[0];
  const inboundSegments = flight?.inbound.segments ?? [];
  const inbound = inboundSegments[inboundSegments.length - 1];
  const priceDelta = proposal?.priceDeltaMinor ?? null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="booking-dialog-heading"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex w-full max-w-lg flex-col gap-4 rounded border border-border bg-paper p-6 shadow-xl"
      >
        <h2 id="booking-dialog-heading" className="text-xl">
          Confirm this simulated booking
        </h2>

        {flight && outbound && inbound ? (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-ink-muted">Route</dt>
            <dd>
              {outbound.fromIata} → {inbound.toIata}
            </dd>
            <dt className="text-ink-muted">Outbound</dt>
            <dd>
              {formatDate(outbound.departureInstant, outbound.departureZone)} ·{" "}
              {formatTime(outbound.departureInstant, outbound.departureZone)} →{" "}
              {formatTime(outbound.arrivalInstant, outbound.arrivalZone)}
            </dd>
            <dt className="text-ink-muted">Return</dt>
            <dd>
              {formatDate(inbound.departureInstant, inbound.departureZone)} ·{" "}
              {formatTime(inbound.departureInstant, inbound.departureZone)} →{" "}
              {formatTime(inbound.arrivalInstant, inbound.arrivalZone)}
            </dd>
            <dt className="text-ink-muted">Flying time</dt>
            <dd>{formatDuration(flight.totalTravelMinutes)} total (incl. layovers)</dd>
            <dt className="text-ink-muted">Party</dt>
            <dd>
              {flight.adults} {flight.adults === 1 ? "adult" : "adults"}
            </dd>
            <dt className="text-ink-muted">Total price</dt>
            <dd className="font-semibold">
              {formatEuroMinor(proposal?.partyTotalMinor ?? flight.partyTotalMinor)}
              {priceDelta !== null ? (
                <span className="ml-2 text-xs font-normal text-ink-muted">
                  ({priceDelta >= 0 ? "+" : ""}
                  {formatEuroMinor(priceDelta)} vs current)
                </span>
              ) : null}
            </dd>
          </dl>
        ) : (
          <p className="text-sm">
            Total price{" "}
            <span className="font-semibold">
              {formatEuroMinor(proposal?.partyTotalMinor ?? 0)}
            </span>{" "}
            for the party.
          </p>
        )}

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
              className="rounded border border-border px-4 py-2 text-sm"
            >
              Choose a different flight
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
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
