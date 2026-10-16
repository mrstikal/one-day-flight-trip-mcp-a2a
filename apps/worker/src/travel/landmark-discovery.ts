import type { Pool } from "pg";
import { discoverCityLandmarks } from "@odft/data";
import {
  getReferenceCity,
  persistDiscoveredLandmarks,
  setReferenceCityCoverage,
} from "@odft/persistence";

/**
 * On-demand landmark curation (2026-10-13).
 *
 * A trip to a `generic_only` city would otherwise only ever see the explicitly
 * synthetic generic activity categories. Before the route inputs are built (when
 * the snapshot context's `isCurated` is fixed), look the city's landmarks up from
 * Wikidata once, persist them into the reference tables and mark the city
 * curated — every later trip to the same city reuses the stored rows without any
 * further lookup. An empty result marks the city `insufficient_reference` (also
 * "don't retry"); a failed lookup leaves `generic_only` so the next trip retries.
 * Discovery is best effort and NEVER fails a trip.
 */

/** Sightseeing radius around the city center for the lookup (kilometers). */
const DISCOVERY_RADIUS_KM = 10;
const DISCOVERY_LIMIT = 24;

export interface LandmarkDiscoveryOptions {
  readonly enabled: boolean;
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly language?: string;
  readonly logger?: (record: {
    level: "info" | "warn";
    component: string;
    message: string;
    [key: string]: unknown;
  }) => void;
}

export async function ensureCityLandmarks(
  pool: Pool,
  cityId: string,
  options: LandmarkDiscoveryOptions,
): Promise<void> {
  if (!options.enabled) {
    return;
  }
  const log = options.logger ?? (() => undefined);
  try {
    const city = await getReferenceCity(pool, cityId);
    if (!city || city.coverageFlag !== "generic_only") {
      return;
    }
    const landmarks = await discoverCityLandmarks({
      center: { lat: city.lat, lon: city.lon },
      envelopeRadiusKm: DISCOVERY_RADIUS_KM,
      limit: DISCOVERY_LIMIT,
      ...(options.language ? { language: options.language } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (landmarks.length === 0) {
      await setReferenceCityCoverage(pool, cityId, "insufficient_reference");
      log({
        level: "info",
        component: "landmark-discovery",
        message: "no landmarks found; city marked insufficient_reference",
        cityId,
      });
      return;
    }
    const inserted = await persistDiscoveredLandmarks(pool, { cityId, landmarks });
    log({
      level: "info",
      component: "landmark-discovery",
      message: "city landmarks discovered and stored",
      cityId,
      city: city.name,
      found: landmarks.length,
      inserted,
    });
  } catch (error) {
    log({
      level: "warn",
      component: "landmark-discovery",
      message: "landmark discovery failed; keeping generic activities",
      cityId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}