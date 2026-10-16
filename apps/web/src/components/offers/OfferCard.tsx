import { ProvenanceLabel } from "./ProvenanceLabel";
import { formatEuroMinor } from "@/lib/format/money";

export interface OfferDetail {
  readonly label: string;
  readonly value: string;
}

/**
 * One selectable offer card (09 section 10). Selecting a card starts a review,
 * never a booking. Prices are the server party total in EUR minor units.
 */
export function OfferCard({
  title,
  subtitle,
  priceMinor,
  priceNote,
  details,
  demoLabels,
  actionLabel,
  selected,
  disabled,
  onAction,
  testId,
  children,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly priceMinor: number;
  readonly priceNote?: string;
  readonly details: readonly OfferDetail[];
  readonly demoLabels: readonly string[];
  readonly actionLabel: string;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onAction: () => void;
  readonly testId?: string;
  readonly children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <li
      data-testid={testId}
      className={`flex flex-col gap-3 rounded border p-4 ${
        selected ? "border-teal bg-paper" : "border-border bg-paper"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-base">{title}</h3>
          {subtitle ? <p className="text-sm text-ink-muted">{subtitle}</p> : null}
        </div>
        <p className="text-base font-semibold">
          {formatEuroMinor(priceMinor)}
          {priceNote ? (
            <span className="ml-2 text-xs font-normal text-ink-muted">{priceNote}</span>
          ) : null}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        {details.map((detail) => (
          <div key={detail.label} className="contents">
            <dt className="text-ink-muted">{detail.label}</dt>
            <dd>{detail.value}</dd>
          </div>
        ))}
      </dl>
      {children}
      <ProvenanceLabel labels={demoLabels} />
      <div>
        <button
          type="button"
          onClick={onAction}
          disabled={disabled}
          aria-pressed={selected}
          className="rounded bg-teal px-3 py-2 text-sm font-medium text-paper hover:bg-teal-strong disabled:opacity-50"
        >
          {actionLabel}
        </button>
      </div>
    </li>
  );
}
