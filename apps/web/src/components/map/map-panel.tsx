"use client";

import dynamic from "next/dynamic";
import { useCallback, useState } from "react";
import type { PublicMapMarker } from "@odft/contracts";
import { MapFallback } from "./map-fallback";
import { MarkerList } from "./marker-list";

/** Leaflet is client-only: it must never render during the server pass. */
const MapCanvas = dynamic(() => import("./map-view"), {
  ssr: false,
  loading: () => <p className="text-sm text-ink-muted">Loading the map…</p>,
});

/**
 * Map panel (Phase 10 map policy): the Leaflet canvas runs only when a
 * policy-compliant, credential-free tile URL is configured *and* the first tile
 * loads within five seconds. Otherwise the labeled SVG schematic renders.
 * "Show approximate schematic" switches manually at any time; every fact also
 * exists as text in the marker list.
 */
export function MapPanel({
  markers,
  tileUrl,
}: {
  readonly markers: readonly PublicMapMarker[];
  readonly tileUrl: string | null;
}): React.JSX.Element {
  const [mode, setMode] = useState<"map" | "fallback">(tileUrl ? "map" : "fallback");
  const [fallbackReason, setFallbackReason] = useState<string | null>(
    tileUrl ? null : "No map tiles are configured for this demo; the schematic shows approximate simulated connections.",
  );
  const onReady = useCallback(() => {
    setMode("map");
  }, []);
  const onFailure = useCallback((reason: string) => {
    setFallbackReason(reason);
    setMode("fallback");
  }, []);
  const showFallback = mode === "fallback" || tileUrl === null;

  return (
    <section aria-labelledby="map-heading" className="flex flex-col gap-3">
      <h2 id="map-heading" className="text-xl">
        Map
      </h2>
      {showFallback ? (
        <MapFallback markers={markers} reason={fallbackReason} />
      ) : (
        <div className="flex flex-col gap-2">
          <MapCanvas markers={markers} tileUrl={tileUrl ?? ""} onReady={onReady} onFailure={onFailure} />
          <p className="text-xs text-ink-muted">
            Tiles © OpenStreetMap contributors. Geographic data: GeoNames (CC BY 4.0); timezone
            boundaries: ODbL. Connections are approximate simulated links.
          </p>
        </div>
      )}
      <div>
        <button
          type="button"
          data-testid="map-mode-toggle"
          onClick={() => setMode(showFallback ? "map" : "fallback")}
          disabled={tileUrl === null}
          className="rounded border border-teal px-3 py-1 text-sm text-teal disabled:opacity-50"
        >
          {showFallback ? "Try the interactive map" : "Show approximate schematic"}
        </button>
      </div>
      <MarkerList markers={markers} />
    </section>
  );
}