"use client";

import type { PublicMapMarker } from "@odft/contracts";

const KIND_LABELS: Readonly<Record<PublicMapMarker["kind"], string>> = {
  meal: "Meal",
  activity: "Visit",
  hotel: "Hotel",
  airport: "Airport",
};

/**
 * Accessible marker list (Phase 10 map policy): every map fact also exists as
 * text, including the approximate positioning and the simulated transfer times.
 */
export function MarkerList({
  markers,
}: {
  readonly markers: readonly PublicMapMarker[];
}): React.JSX.Element {
  return (
    <section aria-labelledby="markers-heading" className="flex flex-col gap-2">
      <h3 id="markers-heading" className="text-base">
        Stops and approximate positions
      </h3>
      {markers.length === 0 ? (
        <p className="text-sm text-ink-muted">No mapped stops for this plan.</p>
      ) : (
        <ol data-testid="marker-list" className="flex list-decimal flex-col gap-1 pl-5 text-sm">
          {markers.map((marker) => (
            <li key={marker.id}>
              <span className="font-medium">{marker.label}</span>{" "}
              <span className="text-ink-muted">
                ({KIND_LABELS[marker.kind]}, approximate position
                {marker.simulatedTransferMinutes !== null
                  ? `, ${marker.simulatedTransferMinutes} min simulated transfer from the previous stop`
                  : ""}
                )
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
