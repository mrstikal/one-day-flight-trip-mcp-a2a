import { z } from "zod";

/**
 * Committed offline reference-data contracts (NDJSON rows). These are validated
 * on write (importer) and on read (loader / SQL reads). IDs retain their source
 * namespace: geographic references use `geonames:<id>` / `ourairports:<id>` and
 * curated landmarks use `wikidata:<QID>`.
 */

export const coverageFlagSchema = z.enum([
  "curated_landmarks",
  "generic_only",
  "insufficient_reference",
]);
export type CoverageFlag = z.infer<typeof coverageFlagSchema>;

export const countryRefSchema = z
  .object({
    countryKey: z.string().regex(/^[A-Z]{2}$/),
    name: z.string().min(1),
    admitted: z.literal(true),
    extension: z.boolean().default(false),
    policyNote: z.string().min(1).optional(),
  })
  .strict();
export type CountryRef = z.infer<typeof countryRefSchema>;

export const cityRefSchema = z
  .object({
    id: z.string().regex(/^geonames:\d+$/),
    countryKey: z.string().regex(/^[A-Z]{2}$/),
    name: z.string().min(1),
    asciiName: z.string().min(1),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    zone: z.string().min(1),
    coverage: coverageFlagSchema,
    population: z.number().int().nonnegative(),
    searchKey: z.string().min(1),
  })
  .strict();
export type CityRef = z.infer<typeof cityRefSchema>;

export const airportRefSchema = z
  .object({
    id: z.string().regex(/^ourairports:\d+$/),
    iata: z.string().regex(/^[A-Z]{3}$/),
    icao: z.string().optional(),
    name: z.string().min(1),
    countryKey: z.string().regex(/^[A-Z]{2}$/),
    municipality: z.string().optional(),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    zone: z.string().min(1),
    zoneSource: z.enum(["geo-tz", "override"]),
    zoneEvidence: z.string().min(1),
    zoneOverrideReason: z.string().min(1).optional(),
    eligibleOrigin: z.boolean(),
    airportType: z.string().min(1),
    scheduledService: z.boolean(),
    searchKey: z.string().min(1),
  })
  .strict();
export type AirportRef = z.infer<typeof airportRefSchema>;

export const cityAirportLinkSchema = z
  .object({
    cityId: z.string().regex(/^geonames:\d+$/),
    airportId: z.string().regex(/^ourairports:\d+$/),
    metroCatchmentId: z.string().min(1),
    transferMinutes: z.number().int().min(0).max(600),
    transferMode: z.enum(["public_transport", "taxi"]),
    eligibleDestination: z.boolean(),
    reviewed: z.boolean(),
    evidenceRefs: z.array(z.string().min(1)),
  })
  .strict();
export type CityAirportLink = z.infer<typeof cityAirportLinkSchema>;

export const landmarkSchema = z
  .object({
    id: z.string().regex(/^wikidata:Q\d+$/),
    cityId: z.string().regex(/^geonames:\d+$/),
    name: z.string().min(1),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    source: z.literal("wikidata"),
    sourceId: z.string().regex(/^Q\d+$/),
    sourceUrl: z.string().min(1),
    verified: z.literal(true),
  })
  .strict();
export type Landmark = z.infer<typeof landmarkSchema>;

export const routeEvidenceSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["ground_corridor", "island_exception", "curated_direct"]),
    originRef: z.string().min(1),
    destinationRef: z.string().min(1),
    minutes: z.number().int().min(0).optional(),
    details: z.string().min(1).optional(),
    evidenceRefs: z.array(z.string().min(1)),
  })
  .strict();
export type RouteEvidence = z.infer<typeof routeEvidenceSchema>;

export const manifestSchema = z
  .object({
    source: z.enum(["geonames", "ourairports", "wikidata-landmarks", "geo-tz", "tz-boundary-odbl"]),
    url: z.string().min(1),
    retrievedAt: z.string().min(1),
    revision: z.string().min(1).optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    license: z.string().min(1),
    licenseUrl: z.string().min(1).optional(),
    transformVersion: z.string().min(1),
    /** What the `sha256` value covers, so provenance is unambiguous per source. */
    hashTarget: z.string().min(1),
    recordCount: z.number().int().nonnegative(),
    rejectedCount: z.number().int().nonnegative(),
    rejectedReport: z
      .array(z.object({ reason: z.string().min(1), count: z.number().int().nonnegative() }).strict())
      .default([]),
    attribution: z.string().min(1).optional(),
  })
  .strict();
export type ReferenceManifest = z.infer<typeof manifestSchema>;

export const referenceDatasetSchema = z.object({
  countries: z.array(countryRefSchema),
  cities: z.array(cityRefSchema),
  airports: z.array(airportRefSchema),
  cityAirportLinks: z.array(cityAirportLinkSchema),
  landmarks: z.array(landmarkSchema),
  routeEvidence: z.array(routeEvidenceSchema),
});
export type ReferenceDataset = z.infer<typeof referenceDatasetSchema>;
