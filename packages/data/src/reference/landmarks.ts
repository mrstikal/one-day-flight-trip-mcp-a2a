import { haversineKm, type LatLon } from "./catchments.js";

/**
 * Curated landmark helpers. Landmarks are real references with source identity
 * (Wikidata QIDs) and coordinates verified against a reviewed city envelope.
 * Non-curated cities offer only explicitly synthetic generic activities.
 */

export interface CityEnvelope extends LatLon {
  readonly envelopeRadiusKm: number;
}

export interface LandmarkDurationTemplate {
  readonly id: string;
  readonly minMinutes: number;
  readonly maxMinutes: number;
}

/** Planning duration assumptions for curated landmarks (not opening hours). */
export const LANDMARK_DURATION_TEMPLATES: readonly LandmarkDurationTemplate[] = [
  { id: "major_museum", minMinutes: 90, maxMinutes: 120 },
  { id: "small_museum_gallery", minMinutes: 60, maxMinutes: 90 },
  { id: "monument_interior", minMinutes: 45, maxMinutes: 75 },
  { id: "exterior_landmark", minMinutes: 20, maxMinutes: 30 },
  { id: "park", minMinutes: 30, maxMinutes: 60 },
];

export function withinEnvelope(point: LatLon, envelope: CityEnvelope): boolean {
  return haversineKm(point, envelope) <= envelope.envelopeRadiusKm;
}

/**
 * A grammar of explicitly synthetic generic activity categories for non-curated
 * cities. Never a fabricated factual venue or landmark.
 */
export const GENERIC_ACTIVITY_CATEGORIES: readonly string[] = [
  "Approximate city-center walk",
  "Demo relaxation break",
  "Unspecified local exploration",
];
