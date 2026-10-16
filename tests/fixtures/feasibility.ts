import {
  GENERATOR_VERSION,
  REFERENCE_VERSION,
  ROUTE_POLICY_VERSION,
  SCHEMA_VERSION,
  type RouteAirport,
  type RouteInputs,
} from "@odft/contracts";
import { DEFAULT_TRANSFER_POLICY } from "@odft/data";

/**
 * Route-input fixtures for Phase 04 unit tests. Reference identities/coordinates
 * mirror `data/reference/*.ndjson` so the pure Stage A rule table is exercised
 * on the same evidence the integration tests load.
 */

const PRG_ORIGIN: RouteAirport = {
  airportId: "ourairports:4408",
  iata: "PRG",
  countryKey: "CZ",
  lat: 50.100874,
  lon: 14.259911,
  zone: "Europe/Prague",
  zoneResolved: true,
  metroCatchmentId: "prague",
  transferMinutes: null,
  transferMode: null,
  eligibleOrigin: true,
  eligibleDestination: false,
  largeAirport: true,
  reviewed: true,
  evidenceRefs: [],
};

const FCO: RouteAirport = {
  airportId: "ourairports:4372",
  iata: "FCO",
  countryKey: "IT",
  lat: 41.804532,
  lon: 12.251998,
  zone: "Europe/Rome",
  zoneResolved: true,
  metroCatchmentId: "rome",
  transferMinutes: 45,
  transferMode: "public_transport",
  eligibleOrigin: true,
  eligibleDestination: true,
  largeAirport: true,
  reviewed: true,
  evidenceRefs: ["reviewed:metro:rome"],
};

const CIA: RouteAirport = {
  ...FCO,
  airportId: "ourairports:4370",
  iata: "CIA",
  lat: 41.798769,
  lon: 12.595331,
  transferMinutes: 40,
};

const JCL: RouteAirport = {
  ...FCO,
  airportId: "ourairports:4393",
  iata: "JCL",
  countryKey: "CZ",
  lat: 48.948171,
  lon: 14.42832,
  zone: "Europe/Prague",
  metroCatchmentId: "ceske-budejovice",
  transferMinutes: 30,
  evidenceRefs: [],
};

const PMI: RouteAirport = {
  ...FCO,
  airportId: "ourairports:4035",
  iata: "PMI",
  countryKey: "ES",
  lat: 39.551701,
  lon: 2.73881,
  zone: "Europe/Madrid",
  metroCatchmentId: "palma",
  transferMinutes: 20,
  evidenceRefs: ["reviewed:metro:palma"],
};

export const HUB_AIRPORTS = [
  { iata: "PRG", lat: 50.100874, lon: 14.259911, zone: "Europe/Prague" },
  { iata: "FRA", lat: 50.033333, lon: 8.570556, zone: "Europe/Berlin" },
  { iata: "CDG", lat: 49.00896, lon: 2.554117, zone: "Europe/Paris" },
  { iata: "AMS", lat: 52.308613, lon: 4.763889, zone: "Europe/Amsterdam" },
  { iata: "VIE", lat: 48.110278, lon: 16.569722, zone: "Europe/Vienna" },
];

export const CURATED_DIRECT_PAIRS: [string, string][] = [
  ["PRG", "FCO"],
  ["PRG", "CIA"],
  ["PRG", "CDG"],
  ["PRG", "ORY"],
  ["PRG", "BCN"],
];

export function routeInputs(overrides: Partial<RouteInputs> = {}): RouteInputs {
  const base: RouteInputs = {
    schemaVersion: SCHEMA_VERSION,
    routePolicyVersion: ROUTE_POLICY_VERSION,
    generatorVersion: GENERATOR_VERSION,
    referenceVersion: REFERENCE_VERSION,
    origin: PRG_ORIGIN,
    destination: {
      countryKey: "IT",
      cityId: "geonames:3169070",
      name: "Rome",
      lat: 41.89193,
      lon: 12.51133,
      zone: "Europe/Rome",
      zoneResolved: true,
      metroCatchmentId: "rome",
      isCurated: true,
    },
    originKnown: true,
    destinationKnown: true,
    destinationAirports: [FCO, CIA],
    groundCorridors: [
      {
        originRef: "airport:PRG",
        destinationRef: "geonames:3077916",
        minutes: 180,
        evidenceRefs: ["reviewed:ground-corridor:prg-cb"],
      },
    ],
    islandExceptions: [
      {
        originRef: "airport:BCN",
        destinationRef: "airport:PMI",
        evidenceRefs: ["reviewed:island:bcn-pmi"],
      },
    ],
    curatedDirectPairs: CURATED_DIRECT_PAIRS,
    hubAirports: HUB_AIRPORTS,
    sightseeingDate: "2026-12-01",
    travelVariant: "two_nights",
    adults: 2,
    transfer: { ...DEFAULT_TRANSFER_POLICY },
  };
  return { ...base, ...overrides };
}

/** PRG -> Ceske Budejovice (ground-preferred corridor). */
export function ceskeBudejoviceRoute(overrides: Partial<RouteInputs> = {}): RouteInputs {
  return routeInputs({
    destination: {
      countryKey: "CZ",
      cityId: "geonames:3077916",
      name: "České Budějovice",
      lat: 48.97447,
      lon: 14.47434,
      zone: "Europe/Prague",
      zoneResolved: true,
      metroCatchmentId: "ceske-budejovice",
      isCurated: false,
    },
    destinationAirports: [JCL],
    ...overrides,
  });
}

/** BCN -> PMI short island exception. */
export function bcnToPmiRoute(overrides: Partial<RouteInputs> = {}): RouteInputs {
  return routeInputs({
    origin: {
      ...PRG_ORIGIN,
      airportId: "ourairports:4004",
      iata: "BCN",
      countryKey: "ES",
      lat: 41.2971,
      lon: 2.07846,
      zone: "Europe/Madrid",
      metroCatchmentId: "barcelona",
    },
    destination: {
      countryKey: "ES",
      cityId: "geonames:2512989",
      name: "Palma de Mallorca",
      lat: 39.5696,
      lon: 2.65016,
      zone: "Europe/Madrid",
      zoneResolved: true,
      metroCatchmentId: "palma",
      isCurated: false,
    },
    destinationAirports: [PMI],
    ...overrides,
  });
}

/** Cross-border same-catchment fixture (different country keys, same catchment). */
export function sameCatchmentCrossBorderRoute(overrides: Partial<RouteInputs> = {}): RouteInputs {
  return routeInputs({
    origin: {
      ...PRG_ORIGIN,
      airportId: "fixture:basel-fr",
      iata: "BSL",
      countryKey: "FR",
      lat: 47.6,
      lon: 7.53,
      zone: "Europe/Paris",
      metroCatchmentId: "basel",
    },
    destination: {
      countryKey: "CH",
      cityId: "fixture:basel-ch",
      name: "Basel",
      lat: 47.5596,
      lon: 7.5886,
      zone: "Europe/Zurich",
      zoneResolved: true,
      metroCatchmentId: "basel",
      isCurated: false,
    },
    destinationAirports: [
      {
        ...FCO,
        airportId: "fixture:basel-ch-airport",
        iata: "ZDH",
        countryKey: "CH",
        lat: 47.5,
        lon: 7.6,
        zone: "Europe/Zurich",
        metroCatchmentId: "basel",
      },
    ],
    ...overrides,
  });
}
