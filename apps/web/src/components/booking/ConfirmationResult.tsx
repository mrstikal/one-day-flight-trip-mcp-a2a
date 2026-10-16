import Link from "next/link";
import type { PublicReservation } from "@odft/contracts";
import { CONFIRMATION_DISCLAIMER } from "@/lib/disclaimers";
import { formatEuroMinor } from "@/lib/format/money";

const SERVICE_LABEL: Readonly<Record<PublicReservation["serviceKey"], string>> = {
  flights: "Flights",
  hotel: "Hotel",
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
};

/** Post-confirmation panel: status, copyable demo reference, and disclaimers. */
export function ConfirmationResult({
  reservation,
  tripId,
  nextHref,
  nextLabel,
}: {
  readonly reservation: PublicReservation;
  readonly tripId: string;
  readonly nextHref?: string;
  readonly nextLabel?: string;
}): React.JSX.Element {
  return (
    <section
      className="flex flex-col gap-4 rounded border border-teal bg-paper p-6"
      aria-labelledby="confirmed-heading"
    >
      <h2 id="confirmed-heading" className="text-xl text-teal">
        {SERVICE_LABEL[reservation.serviceKey]} booking confirmed
      </h2>
      <p className="text-sm">
        Reference{" "}
        <span data-testid="demo-reference" className="font-mono font-semibold">
          {reservation.demoReference}
        </span>
      </p>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <dt className="text-ink-muted">Status</dt>
        <dd>Confirmed</dd>
        <dt className="text-ink-muted">Party total</dt>
        <dd>{formatEuroMinor(reservation.partyTotalMinor)}</dd>
      </dl>
      <p role="note" className="rounded bg-info p-3 text-sm text-clay">
        {CONFIRMATION_DISCLAIMER}
      </p>
      <div className="flex flex-wrap gap-3">
        {nextHref && nextLabel ? (
          <Link
            href={nextHref}
            className="w-fit rounded bg-teal px-4 py-2 text-sm font-medium text-paper hover:bg-teal-strong"
          >
            {nextLabel}
          </Link>
        ) : null}
        <Link
          href={`/trips/${tripId}/summary`}
          className="w-fit rounded border border-teal px-4 py-2 text-sm text-teal"
        >
          View trip summary
        </Link>
      </div>
    </section>
  );
}
