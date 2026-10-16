"use client";

import type { PublicMapMarker } from "@odft/contracts";

const WIDTH = 320;
const HEIGHT = 200;
const PADDING = 24;

/**
 * Deterministic SVG schematic fallback (Phase 10 map policy): no tiles, every
 * marker keeps its accessible text in the marker list, and the connections are
 * labeled as approximate simulated links.
 */
export function MapFallback({
  markers,
  reason,
}: {
  readonly markers: readonly PublicMapMarker[];
  readonly reason: string | null;
}): React.JSX.Element {
  const points = markers.filter(
    (marker) => Number.isFinite(marker.lat) && Number.isFinite(marker.lon),
  );
  const hasPoints = points.length > 0;
  const lats = points.map((marker) => marker.lat);
  const lons = points.map((marker) => marker.lon);
  const rawMinLat = hasPoints ? Math.min(...lats) : 0;
  const rawMaxLat = hasPoints ? Math.max(...lats) : 1;
  const rawMinLon = hasPoints ? Math.min(...lons) : 0;
  const rawMaxLon = hasPoints ? Math.max(...lons) : 1;
  // Degenerate bounds (single point or a straight line) are widened so the
  // projection never divides by zero and the markers stay visible.
  const latSpan = Math.max(rawMaxLat - rawMinLat, 0.01);
  const lonSpan = Math.max(rawMaxLon - rawMinLon, 0.01);
  const centerLat = (rawMinLat + rawMaxLat) / 2;
  const centerLon = (rawMinLon + rawMaxLon) / 2;
  const minLon = centerLon - lonSpan / 2;
  const maxLat = centerLat + latSpan / 2;
  const project = (lat: number, lon: number): { x: number; y: number } => ({
    x: PADDING + ((lon - minLon) / lonSpan) * (WIDTH - 2 * PADDING),
    y: PADDING + ((maxLat - lat) / latSpan) * (HEIGHT - 2 * PADDING),
  });
  const path = points
    .map((marker) => {
      const { x, y } = project(marker.lat, marker.lon);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <div
      data-testid="map-fallback"
      className="flex flex-col gap-2 rounded border border-border bg-paper p-4"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
        Approximate simulated connections
      </p>
      {points.length > 0 ? (
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={`Approximate schematic of ${points.length} itinerary stops`}
          className="h-48 w-full"
        >
          <rect x="0" y="0" width={WIDTH} height={HEIGHT} fill="var(--color-cream, #f6f1e7)" />
          <polyline
            points={path}
            fill="none"
            stroke="var(--color-clay, #b4552d)"
            strokeDasharray="6 4"
            strokeWidth="2"
          />
          {points.map((marker) => {
            const { x, y } = project(marker.lat, marker.lon);
            return (
              <g key={marker.id}>
                <circle cx={x} cy={y} r="6" fill="var(--color-teal, #0f6b5c)" />
                <title>{marker.label}</title>
              </g>
            );
          })}
        </svg>
      ) : (
        <p className="text-sm text-ink-muted">No mapped stops for this plan.</p>
      )}
      <p data-testid="map-fallback-label" className="text-xs text-ink-muted">
        {reason ??
          "The interactive map is unavailable; the schematic shows approximate simulated connections, not real geography."}
      </p>
      <p className="text-xs text-ink-muted">
        No map tiles were loaded. Geographic data: GeoNames (CC BY 4.0); timezone boundaries:
        ODbL.
      </p>
    </div>
  );
}
