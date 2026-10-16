"use client";

import type { PublicRouteChangePreview } from "@odft/contracts";

/**
 * Phase 11 route-change impact card (08-frontend-ux.md section 5).
 *
 * A route change that would invalidate confirmed reservations is NOT applied
 * until the user confirms it here. The card names every affected reservation
 * explicitly; nothing is cancelled before the confirmation, and the server
 * re-validates the preview before committing.
 */
export function RouteChangeCard({
  preview,
  busy,
  onConfirm,
}: {
  readonly preview: PublicRouteChangePreview;
  readonly busy: boolean;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  const money = (minor: number): string => (minor / 100).toFixed(2);
  const variantLabel = (variant: string): string =>
    variant === "one_night" ? "one night" : "two nights";
  // Only the fields the command actually changes are shown, with both values, so
  // an origin-only change is visibly destructive instead of looking identical.
  const changes: { readonly field: string; readonly from: string; readonly to: string }[] = [];
  if (preview.from.originAirportId !== preview.to.originAirportId) {
    changes.push({
      field: "Origin airport",
      from: preview.from.originAirportId,
      to: preview.to.originAirportId,
    });
  }
  if (preview.from.destinationCityId !== preview.to.destinationCityId) {
    changes.push({
      field: "Destination",
      from: `${preview.from.destinationCityId} (${preview.from.destinationCountryKey})`,
      to: `${preview.to.destinationCityId} (${preview.to.destinationCountryKey})`,
    });
  }
  if (preview.from.sightseeingDate !== preview.to.sightseeingDate) {
    changes.push({
      field: "Sightseeing date",
      from: preview.from.sightseeingDate,
      to: preview.to.sightseeingDate,
    });
  }
  if (preview.from.travelVariant !== preview.to.travelVariant) {
    changes.push({
      field: "Variant",
      from: variantLabel(preview.from.travelVariant),
      to: variantLabel(preview.to.travelVariant),
    });
  }
  return (
    <section
      data-testid="route-change-card"
      aria-label="Route change impact"
      className="rounded border border-amber-500 bg-amber-50 p-3 text-sm"
    >
      <h3 className="font-serif text-sm font-semibold">Confirm the route change</h3>
      <ul className="mt-1 text-xs text-ink-muted" data-testid="route-change-fields">
        {changes.map((change) => (
          <li key={change.field}>
            <span className="font-medium text-ink">{change.field}:</span> {change.from} →{" "}
            {change.to}
          </li>
        ))}
      </ul>
      {preview.affectedReservations.length > 0 ? (
        <>
          <p className="mt-2 text-xs">
            These confirmed reservations will be cancelled when you confirm, and the route,
            schedule, and itinerary are re-validated from scratch:
          </p>
          <ul className="mt-1 list-disc pl-5 text-xs" data-testid="route-change-reservations">
            {preview.affectedReservations.map((reservation) => (
              <li key={reservation.id}>
                {reservation.serviceKey} — {reservation.demoReference} ({money(reservation.partyTotalMinor)})
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-2 text-xs">
          No confirmed reservation is affected; the change still re-validates the route.
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={onConfirm}
        data-testid="route-change-confirm"
        className="mt-3 rounded bg-teal px-3 py-1.5 text-xs font-medium text-paper disabled:opacity-50"
      >
        Confirm route change
      </button>
      <p className="mt-2 text-[11px] text-ink-muted">
        Declining is safe: nothing changes until you confirm, and you can keep chatting instead.
      </p>
    </section>
  );
}
