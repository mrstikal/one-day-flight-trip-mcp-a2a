"use client";

import type { PublicItinerary } from "@odft/contracts";
import { formatEuroMinor } from "@/lib/format/money";

/**
 * Deterministic party cost breakdown (Phase 10 section 6): every item carries its
 * inclusion key/provenance, booked offers are never added twice, and the
 * excluded notes state what the total does not include. A flight/hotel kept as a
 * selection ("I don't want to book") is costed but marked "Not booked".
 */
export function CostBreakdown({
  itinerary,
  notBooked = [],
}: {
  readonly itinerary: PublicItinerary;
  /** Cost categories with a kept selection and no confirmed reservation. */
  readonly notBooked?: readonly ("flights" | "hotel")[];
}): React.JSX.Element {
  const costs = itinerary.costs;
  const notBookedCategories = new Set(notBooked);
  return (
    <section aria-labelledby="costs-heading" className="flex flex-col gap-3">
      <h2 id="costs-heading" className="text-xl">
        Party cost breakdown
      </h2>
      <table data-testid="cost-breakdown" className="w-full border-collapse text-sm">
        <caption className="sr-only">
          Deterministic simulated party totals in EUR for the whole trip
        </caption>
        <thead>
          <tr className="border-b border-border text-left text-ink-muted">
            <th scope="col" className="py-1 pr-3">
              Item
            </th>
            <th scope="col" className="py-1 pr-3">
              Category
            </th>
            <th scope="col" className="py-1 text-right">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {costs.items.map((item) => (
            <tr key={item.key} className="border-b border-border">
              <td className="py-1 pr-3">
                {item.label}
                {notBookedCategories.has(item.category as "flights" | "hotel") ? (
                  <span
                    data-testid={`not-booked-${item.category}`}
                    className="ml-2 rounded border border-clay bg-cream px-1.5 py-0.5 align-middle text-xs font-medium uppercase tracking-wide text-clay"
                  >
                    Not booked
                  </span>
                ) : null}
                <span className="block text-xs text-ink-muted">{item.provenance.join(" · ")}</span>
              </td>
              <td className="py-1 pr-3 capitalize text-ink-muted">{item.category}</td>
              <td className="py-1 text-right font-mono">{formatEuroMinor(item.amountMinor)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={2} className="py-2 text-left">
              Party total
            </th>
            <td data-testid="cost-total" className="py-2 text-right font-mono font-semibold">
              {formatEuroMinor(costs.totalMinor)}
            </td>
          </tr>
        </tfoot>
      </table>
      {costs.dinnerExcluded ? (
        <p data-testid="dinner-excluded" className="text-sm text-ink-muted">
          {costs.dinnerExcludedReason ?? "Dinner is not included."}
        </p>
      ) : null}
      <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-ink-muted">
        {costs.excludedNotes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </section>
  );
}
