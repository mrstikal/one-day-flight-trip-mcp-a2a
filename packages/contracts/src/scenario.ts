import { z } from "zod";
import {
  activityCategorySchema,
  activityTagSchema,
  scenarioDomainSchema,
  serviceLevelSchema,
  travelVariantSchema,
  mealSchema,
} from "./enums.js";
import { flightCombinationSchema } from "./feasibility.js";
import {
  countryKeySchema,
  fingerprintSchema,
  instantSchema,
  localDateSchema,
  moneyMinorSchema,
  timeZoneSchema,
  uuidSchema,
} from "./primitives.js";

/**
 * Scenario/offer contracts (04-domain-model.md section 5,
 * 05-synthetic-data-design.md sections 7-9). Every persisted offer is immutable
 * within a snapshot, carries provenance labels, and is synthetic unless it is a
 * curated landmark reference.
 */

export const GENERATOR_VERSION = "generator-v1" as const;
export const FAKER_VERSION = "10.6.0" as const;
export const SCHEMA_VERSION = "scenario-schema-v1" as const;
export const REFERENCE_VERSION = "reference-2026-10-10" as const;

export const PROVENANCE_LABELS = {
  geographic: "Geographic reference",
  demo: "Demo offer",
  simulated: "Simulated schedule/price",
  approximate: "Approximate location",
  ai: "AI recommendation",
} as const;

export const demoLabelSchema = z.enum([
  "Demo offer",
  "Simulated schedule/price",
  "Approximate location",
  "Geographic reference",
  "AI recommendation",
]);
export type DemoLabel = z.infer<typeof demoLabelSchema>;

/** Inputs that are hashed into the stable `scenarioKey` (05 section 7). */
export const generationInputsSchema = z
  .object({
    seed: z.string().min(1),
    originAirportId: z.string().min(1),
    originIata: z.string().min(1),
    destinationCityId: z.string().min(1),
    destinationCountryKey: countryKeySchema,
    destinationAirportIds: z.array(z.string().min(1)),
    sightseeingDate: localDateSchema,
    travelVariant: travelVariantSchema,
    adults: z.number().int().min(1).max(6),
    generatorVersion: z.string().min(1),
    referenceVersion: z.string().min(1),
    routePolicyVersion: z.string().min(1),
  })
  .strict();
export type GenerationInputs = z.infer<typeof generationInputsSchema>;

export const snapshotContextSchema = z
  .object({
    destinationCityId: z.string().min(1),
    countryKey: countryKeySchema,
    cityName: z.string().min(1),
    center: z
      .object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })
      .strict(),
    envelopeRadiusKm: z.number().positive(),
    cityZone: timeZoneSchema,
    cityFactor: z.number().positive(),
    sightseeingDate: localDateSchema,
    travelVariant: travelVariantSchema,
    adults: z.number().int().min(1).max(6),
    isCurated: z.boolean(),
    referenceVersion: z.string().min(1),
  })
  .strict();
export type SnapshotContext = z.infer<typeof snapshotContextSchema>;

export const geoAnchorSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    precisionMeters: z.number().nonnegative().optional(),
  })
  .strict();
export type GeoAnchor = z.infer<typeof geoAnchorSchema>;

export const hotelOfferSchema = z
  .object({
    id: z.string().min(1),
    level: serviceLevelSchema,
    name: z.string().min(1),
    date: localDateSchema,
    nights: z.number().int().min(1).max(7),
    adults: z.number().int().min(1).max(6),
    rooms: z.number().int().min(1).max(6),
    perNightMinor: moneyMinorSchema,
    partyTotalMinor: moneyMinorSchema,
    rating: z.number().min(0).max(5),
    anchor: geoAnchorSchema,
    centerDistanceKm: z.number().nonnegative(),
    luggageStorage: z.boolean(),
    checkInWindow: z.string().min(1),
    checkOutWindow: z.string().min(1),
    synthetic: z.literal(true),
    demoLabels: z.array(demoLabelSchema).min(1),
  })
  .strict();
export type HotelOffer = z.infer<typeof hotelOfferSchema>;

export const restaurantOfferSchema = z
  .object({
    id: z.string().min(1),
    meal: mealSchema,
    level: serviceLevelSchema,
    name: z.string().min(1),
    cuisine: z.string().min(1),
    perAdultMinor: moneyMinorSchema,
    partyTotalMinor: moneyMinorSchema,
    durationMinutes: z.number().int().min(15).max(240),
    windowStart: z.string().min(1),
    windowEnd: z.string().min(1),
    anchor: geoAnchorSchema,
    centerDistanceKm: z.number().nonnegative(),
    synthetic: z.literal(true),
    demoLabels: z.array(demoLabelSchema).min(1),
  })
  .strict();
export type RestaurantOffer = z.infer<typeof restaurantOfferSchema>;

export const activityRefSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["landmark", "generic"]),
    name: z.string().min(1),
    cityId: z.string().min(1),
    category: activityCategorySchema,
    tags: z.array(activityTagSchema),
    durationMinutes: z.number().int().min(10).max(240),
    ticketMinorPerAdult: moneyMinorSchema,
    anchor: geoAnchorSchema,
    reference: z.boolean(),
    sourceId: z.string().min(1).optional(),
    sourceUrl: z.string().min(1).optional(),
    synthetic: z.boolean(),
    demoLabels: z.array(demoLabelSchema).min(1),
  })
  .strict();
export type ActivityRef = z.infer<typeof activityRefSchema>;

export const eventRefSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(["performance", "exhibition", "festival"]),
    date: localDateSchema,
    startLocalTime: z.string().min(1),
    durationMinutes: z.number().int().min(15).max(360),
    ticketMinorPerAdult: moneyMinorSchema,
    anchor: geoAnchorSchema,
    synthetic: z.literal(true),
    demoLabels: z.array(demoLabelSchema).min(1),
  })
  .strict();
export type EventRef = z.infer<typeof eventRefSchema>;

export const snapshotContentSchema = z
  .object({
    schemaVersion: z.string().min(1),
    scenarioKey: z.string().min(1),
    seed: z.string().min(1),
    generatorVersion: z.string().min(1),
    fakerVersion: z.string().min(1),
    referenceVersion: z.string().min(1),
    /** Route approval fingerprint this snapshot was generated for. */
    routeFingerprint: fingerprintSchema,
    /** Metadata only; excluded from payload-determinism comparisons. */
    generatedAt: z.string().min(1),
    context: snapshotContextSchema,
    flights: z.array(flightCombinationSchema),
    hotels: z.array(hotelOfferSchema),
    restaurants: z.array(restaurantOfferSchema),
    activities: z.array(activityRefSchema),
    events: z.array(eventRefSchema),
  })
  .strict();
export type SnapshotContent = z.infer<typeof snapshotContentSchema>;

export const scenarioDomainVersionsSchema = z
  .object({
    flights: z.number().int().min(0),
    hotels: z.number().int().min(0),
    breakfast: z.number().int().min(0),
    lunch: z.number().int().min(0),
    dinner: z.number().int().min(0),
    activities: z.number().int().min(0),
    events: z.number().int().min(0),
  })
  .strict();
export type ScenarioDomainVersions = z.infer<typeof scenarioDomainVersionsSchema>;

export const scenarioDomainHashesSchema = z
  .object({
    flights: z.string().regex(/^[a-f0-9]{64}$/),
    hotels: z.string().regex(/^[a-f0-9]{64}$/),
    breakfast: z.string().regex(/^[a-f0-9]{64}$/),
    lunch: z.string().regex(/^[a-f0-9]{64}$/),
    dinner: z.string().regex(/^[a-f0-9]{64}$/),
    activities: z.string().regex(/^[a-f0-9]{64}$/),
    events: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ScenarioDomainHashes = z.infer<typeof scenarioDomainHashesSchema>;

export const scenarioManifestSchema = z
  .object({
    scenarioId: uuidSchema,
    snapshotId: uuidSchema,
    snapshotVersion: z.number().int().min(1),
    scenarioKey: z.string().min(1),
    seed: z.string().min(1),
    generatorVersion: z.string().min(1),
    fakerVersion: z.string().min(1),
    referenceVersion: z.string().min(1),
    generatedAt: z.string().min(1),
    destinationCityId: z.string().min(1),
    routeFingerprint: fingerprintSchema,
    materializedDomains: z.array(scenarioDomainSchema),
    domainVersions: scenarioDomainVersionsSchema,
    domainContentHashes: scenarioDomainHashesSchema,
  })
  .strict();
export type ScenarioManifest = z.infer<typeof scenarioManifestSchema>;

export const snapshotInputSchema = z
  .object({
    tripId: uuidSchema,
    scenarioId: uuidSchema,
    snapshotVersion: z.number().int().min(1),
    routeFingerprint: fingerprintSchema,
    content: snapshotContentSchema,
  })
  .strict();
export type SnapshotInput = z.infer<typeof snapshotInputSchema>;

export const SNAPSHOT_MAX_BYTES = 1024 * 1024;

export const MAX_SNAPSHOT_BYTES = SNAPSHOT_MAX_BYTES;

/** Domains that a single materialization extension may append. */
export const MATERIALIZABLE_DOMAINS = scenarioDomainSchema.options;

export const snapshotGeneratedAtSchema = instantSchema;
