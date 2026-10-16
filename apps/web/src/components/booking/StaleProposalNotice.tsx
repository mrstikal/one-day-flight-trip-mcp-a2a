/**
 * Shown when a booking-confirmation decision is pending but its review proposal
 * expired or is missing (e.g. after the 30-minute TTL). The user can reopen the
 * choice for the current step without a silent dead end.
 */
export function StaleProposalNotice({
  serviceLabel,
  canReselect,
  busy,
  onReselect,
}: {
  readonly serviceLabel: string;
  readonly canReselect: boolean;
  readonly busy: boolean;
  readonly onReselect: () => void;
}): React.JSX.Element {
  return (
    <section
      className="flex flex-col gap-3 rounded border border-clay bg-paper p-6"
      aria-labelledby="stale-proposal-heading"
    >
      <h2 id="stale-proposal-heading" className="text-lg text-clay">
        This proposal is no longer valid
      </h2>
      <p className="text-sm text-ink-muted">
        The {serviceLabel} review proposal expired or was superseded. Choose again to create a fresh
        proposal and a new expiry.
      </p>
      <button
        type="button"
        onClick={onReselect}
        disabled={busy || !canReselect}
        className="w-fit rounded bg-teal px-4 py-2 text-sm font-medium text-paper hover:bg-teal-strong disabled:opacity-50"
      >
        {busy ? "Reopening…" : `Choose a different ${serviceLabel}`}
      </button>
    </section>
  );
}
