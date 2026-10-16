import type { PublicProposal } from "@odft/contracts";
import { formatEuroMinor } from "@/lib/format/money";
import { ImpactPreviewTable, type ImpactRow } from "./ImpactPreviewTable";
import { DEMO_DISCLAIMER } from "@/lib/disclaimers";

/**
 * Review-only proposal card: it shows what will be confirmed, the price delta
 * versus the current selection, and any deterministic impact, and gates the
 * confirmation dialog. Nothing is booked until the dialog is confirmed.
 */
export function ProposalReview({
  title,
  description,
  proposal,
  reviewLabel,
  onReview,
  onReject,
  busy,
  impactRows,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly proposal: PublicProposal;
  readonly reviewLabel: string;
  readonly onReview: () => void;
  readonly onReject: () => void;
  readonly busy: boolean;
  readonly impactRows?: readonly ImpactRow[];
  readonly children?: React.ReactNode;
}): React.JSX.Element {
  const delta = proposal.priceDeltaMinor;
  return (
    <section className="flex flex-col gap-3 rounded border border-border bg-paper p-6">
      <h2 className="text-lg">{title}</h2>
      <p className="text-sm">{description}</p>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <dt className="text-ink-muted">Party total</dt>
        <dd className="font-semibold">{formatEuroMinor(proposal.partyTotalMinor)}</dd>
        {delta !== null ? (
          <>
            <dt className="text-ink-muted">Change vs current</dt>
            <dd>
              {delta >= 0 ? "+" : ""}
              {formatEuroMinor(delta)}
            </dd>
          </>
        ) : null}
      </dl>
      {children}
      {impactRows && impactRows.length > 0 ? <ImpactPreviewTable rows={impactRows} /> : null}
      <p role="note" className="rounded bg-info p-3 text-sm text-clay">
        {DEMO_DISCLAIMER}
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onReview}
          disabled={busy}
          className="w-fit rounded bg-teal px-4 py-2 text-sm font-medium text-paper hover:bg-teal-strong disabled:opacity-50"
        >
          {reviewLabel}
        </button>
        <button
          type="button"
          onClick={onReject}
          disabled={busy}
          className="w-fit rounded border border-border px-4 py-2 text-sm disabled:opacity-50"
        >
          Choose a different option
        </button>
      </div>
    </section>
  );
}
