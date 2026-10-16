"use client";

import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { PublicMapMarker } from "@odft/contracts";

/**
 * Leaflet canvas (Phase 10 map policy). Tiles come only from the server-configured
 * credential-free template; the first tile must load within five seconds, and
 * repeated tile failures (also after a successful start) report failure so the
 * parent renders the SVG fallback. The component mounts only in the browser
 * (dynamic import with `ssr: false`).
 *
 * The effect depends on a stable content key, not the array identity: projection
 * polling re-creates the markers array every ~1.5s and must not tear the map
 * down (which would reset pan/zoom and restart the fallback timer).
 */
const CONSECUTIVE_TILE_FAILURES_BEFORE_FALLBACK = 4;

export default function MapView({
  markers,
  tileUrl,
  onReady,
  onFailure,
}: {
  readonly markers: readonly PublicMapMarker[];
  readonly tileUrl: string;
  readonly onReady: () => void;
  readonly onFailure: (reason: string) => void;
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const readyRef = useRef(onReady);
  const failureRef = useRef(onFailure);
  const markersRef = useRef(markers);
  const markersKey = useMemo(
    () =>
      JSON.stringify(
        markers.map((marker) => [marker.id, marker.kind, marker.label, marker.lat, marker.lon]),
      ),
    [markers],
  );

  useEffect(() => {
    readyRef.current = onReady;
    failureRef.current = onFailure;
  });

  useEffect(() => {
    markersRef.current = markers;
  }, [markers]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const points = markersRef.current.filter(
      (marker) => Number.isFinite(marker.lat) && Number.isFinite(marker.lon),
    );
    const center: L.LatLngExpression =
      points.length > 0
        ? [
            points.reduce((sum, marker) => sum + marker.lat, 0) / points.length,
            points.reduce((sum, marker) => sum + marker.lon, 0) / points.length,
          ]
        : [0, 0];
    const map = L.map(container, {
      center,
      zoom: points.length > 0 ? 12 : 2,
      zoomControl: true,
      attributionControl: true,
    });
    let firstTileLoaded = false;
    let failed = false;
    let consecutiveFailures = 0;
    const layer = L.tileLayer(tileUrl, {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });
    layer.on("tileload", () => {
      consecutiveFailures = 0;
      if (!firstTileLoaded) {
        firstTileLoaded = true;
        readyRef.current();
      }
    });
    layer.on("tileerror", () => {
      if (failed) {
        return;
      }
      if (!firstTileLoaded) {
        failed = true;
        failureRef.current("Tiles could not be loaded; showing the approximate schematic instead.");
        return;
      }
      // A single missing tile at the edge is tolerable; repeated failures after
      // panning or a connectivity loss must still activate the offline view.
      consecutiveFailures += 1;
      if (consecutiveFailures >= CONSECUTIVE_TILE_FAILURES_BEFORE_FALLBACK) {
        failed = true;
        failureRef.current(
          "Map tiles keep failing; showing the approximate schematic instead.",
        );
      }
    });
    layer.addTo(map);
    for (const marker of points) {
      L.circleMarker([marker.lat, marker.lon], {
        radius: 7,
        color: "#0f6b5c",
        fillColor: "#0f6b5c",
        fillOpacity: 0.9,
      })
        .bindPopup(marker.label)
        .addTo(map);
    }
    if (points.length > 1) {
      L.polyline(
        points.map((marker) => [marker.lat, marker.lon] as [number, number]),
        { color: "#b4552d", dashArray: "6 4", weight: 2 },
      ).addTo(map);
    }
    const timer = window.setTimeout(() => {
      if (!firstTileLoaded && !failed) {
        failed = true;
        failureRef.current(
          "Tiles did not load within 5 seconds; showing the approximate schematic instead.",
        );
      }
    }, 5000);
    return () => {
      window.clearTimeout(timer);
      map.remove();
    };
  }, [markersKey, tileUrl]);

  return (
    <div
      ref={containerRef}
      data-testid="map-canvas"
      role="img"
      aria-label="Map of the itinerary stops with simulated connections"
      className="relative isolate z-0 h-64 w-full rounded border border-border"
    />
  );
}
