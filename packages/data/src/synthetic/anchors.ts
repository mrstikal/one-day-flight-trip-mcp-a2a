import type { Faker } from "@faker-js/faker";
import type { SnapshotContext } from "@odft/contracts";
import { haversineKm } from "../routing/haversine.js";

/**
 * Safe anchor selection for generated point offers (05 section 9). Curated
 * cities anchor near a real reviewed landmark coordinate (guaranteed on land);
 * generic cities use a tight city-core radius. This avoids placing demo pins on
 * water or far outside the city while keeping positions approximate.
 */

export interface LandmarkAnchor {
  readonly lat: number;
  readonly lon: number;
}

const CURATED_OFFSET_KM = 0.4;
const GENERIC_OFFSET_MAX_KM = 1.5;

export function safeAnchor(
  faker: Faker,
  context: SnapshotContext,
  landmarks: readonly LandmarkAnchor[],
  index: number,
): { lat: number; lon: number; centerDistanceKm: number } {
  const useLandmarks = context.isCurated && landmarks.length > 0;
  const base = useLandmarks
    ? (landmarks[index % landmarks.length] as LandmarkAnchor)
    : context.center;
  const maxKm = useLandmarks
    ? CURATED_OFFSET_KM
    : Math.min(context.envelopeRadiusKm * 0.6, GENERIC_OFFSET_MAX_KM);
  const distanceKm = maxKm * faker.number.float({ min: 0, max: 1 });
  const bearing = faker.number.float({ min: 0, max: Math.PI * 2 });
  const dLat = (distanceKm * Math.cos(bearing)) / 111;
  const dLon =
    (distanceKm * Math.sin(bearing)) / (111 * Math.max(0.1, Math.cos((base.lat * Math.PI) / 180)));
  const lat = base.lat + dLat;
  const lon = base.lon + dLon;
  return {
    lat: Math.round(lat * 1e6) / 1e6,
    lon: Math.round(lon * 1e6) / 1e6,
    centerDistanceKm: Math.round(haversineKm(context.center, { lat, lon }) * 100) / 100,
  };
}
