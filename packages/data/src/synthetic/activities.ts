import type { ActivityCategory, ActivityRef, ActivityTag, SnapshotContext } from "@odft/contracts";
import { GENERIC_ACTIVITY_CATEGORIES } from "../reference/landmarks.js";
import { haversineKm } from "../routing/haversine.js";
import { deriveEntityId } from "./ids.js";
import { createDomainFaker } from "./seed.js";

/**
 * Deterministic activity generator (05 section 9). Curated cities use verified
 * real landmark identities with source IDs; non-curated cities offer only
 * explicitly synthetic generic categories. Never invents a factual venue.
 */

export interface LandmarkInput {
  readonly id: string;
  readonly name: string;
  readonly cityId: string;
  readonly lat: number;
  readonly lon: number;
  readonly sourceId: string;
  readonly sourceUrl: string;
}

export interface ActivityGenInput {
  readonly scenarioKey: string;
  readonly seed: string;
  readonly generatorVersion: string;
  readonly context: SnapshotContext;
  readonly landmarks: readonly LandmarkInput[];
}

interface Classification {
  readonly category: ActivityCategory;
  readonly tags: ActivityTag[];
  readonly minMinutes: number;
  readonly maxMinutes: number;
  readonly ticketMinor: number;
}

function classify(name: string): Classification {
  const lower = name.toLowerCase();
  // Parks/gardens (exterior, free): English + common European tokens.
  if (
    /park|garden|jardin|parc|parco|giardino|beach|waterfront|riverbank|ciutadella|retiro/.test(
      lower,
    )
  ) {
    return {
      category: "relaxation",
      tags: ["park", "garden"],
      minMinutes: 30,
      maxMinutes: 60,
      ticketMinor: 0,
    };
  }
  // Fountains/squares/arches (exterior, free).
  if (
    /fountain|fontaine|fontana|squar|plaza|placa|obelisk|arch\b|gate\b|bridge|puente|pont\b/.test(
      lower,
    )
  ) {
    return {
      category: "culture",
      tags: ["landmark", "architecture"],
      minMinutes: 20,
      maxMinutes: 30,
      ticketMinor: 0,
    };
  }
  // Large museums.
  if (/museum|musée|museu|museo|galleria|orsay|uffizi/.test(lower)) {
    return {
      category: "culture",
      tags: ["museum"],
      minMinutes: 90,
      maxMinutes: 120,
      ticketMinor: 2000,
    };
  }
  // Smaller galleries.
  if (/gallery|galeria|galerie|exhibition/.test(lower)) {
    return {
      category: "culture",
      tags: ["gallery"],
      minMinutes: 60,
      maxMinutes: 90,
      ticketMinor: 1200,
    };
  }
  // Monuments/religious/castle interiors.
  if (
    /cathedral|basilica|church|eglise|église|iglesia|chiesa|colosseum|coliseum|castel|castle|palace|palacio|palazzo|casa|tower|tour\b|dom\b/.test(
      lower,
    )
  ) {
    return {
      category: "culture",
      tags: ["landmark", "architecture"],
      minMinutes: 45,
      maxMinutes: 75,
      ticketMinor: 1500,
    };
  }
  // Default: a modest exterior/interior landmark assumption.
  return {
    category: "culture",
    tags: ["landmark"],
    minMinutes: 20,
    maxMinutes: 30,
    ticketMinor: 0,
  };
}

export function generateActivities(input: ActivityGenInput): ActivityRef[] {
  const { context } = input;
  const faker = createDomainFaker(
    input.seed,
    input.scenarioKey,
    "activities",
    input.generatorVersion,
  );
  const activities: ActivityRef[] = [];

  if (context.isCurated && input.landmarks.length > 0) {
    input.landmarks.forEach((landmark, index) => {
      const classification = classify(landmark.name);
      const fraction = faker.number.float({ min: 0, max: 1 });
      const duration = Math.round(
        classification.minMinutes +
          (classification.maxMinutes - classification.minMinutes) * fraction,
      );
      activities.push({
        id: deriveEntityId(input.scenarioKey, "activities", index, landmark.sourceId),
        kind: "landmark",
        name: landmark.name,
        cityId: landmark.cityId,
        category: classification.category,
        tags: [...classification.tags],
        durationMinutes: duration,
        ticketMinorPerAdult: classification.ticketMinor,
        anchor: { lat: landmark.lat, lon: landmark.lon, precisionMeters: 50 },
        reference: true,
        sourceId: landmark.sourceId,
        sourceUrl: landmark.sourceUrl,
        synthetic: false,
        demoLabels: ["Geographic reference", "Simulated schedule/price"],
      });
    });
    return activities;
  }

  GENERIC_ACTIVITY_CATEGORIES.forEach((name, index) => {
    const fraction = faker.number.float({ min: 0, max: 1 });
    const distanceKm = context.envelopeRadiusKm * 0.4 * fraction;
    const bearing = fraction * Math.PI * 2;
    const lat = context.center.lat + (distanceKm * Math.cos(bearing)) / 111;
    const lon =
      context.center.lon +
      (distanceKm * Math.sin(bearing)) /
        (111 * Math.max(0.1, Math.cos((context.center.lat * Math.PI) / 180)));
    activities.push({
      id: deriveEntityId(input.scenarioKey, "activities", index, name),
      kind: "generic",
      name,
      cityId: context.destinationCityId,
      category: index % 2 === 0 ? "relaxation" : "culture",
      tags: ["landmark"],
      durationMinutes: 45,
      ticketMinorPerAdult: 0,
      anchor: {
        lat: Math.round(lat * 1e6) / 1e6,
        lon: Math.round(lon * 1e6) / 1e6,
        precisionMeters: 1000,
      },
      reference: false,
      synthetic: true,
      demoLabels: ["Demo offer", "Approximate location"],
    });
  });
  return activities;
}

/** Distance helper reused by callers that validate anchors stay in-envelope. */
export function anchorDistanceKm(
  context: SnapshotContext,
  point: { lat: number; lon: number },
): number {
  return haversineKm(context.center, point);
}
