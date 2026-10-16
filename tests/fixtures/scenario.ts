import { Temporal } from "@js-temporal/polyfill";
import {
  GENERATOR_VERSION,
  REFERENCE_VERSION,
  ROUTE_POLICY_VERSION,
  SCHEMA_VERSION,
  type FeasibleRouteApproval,
  type FlightCombination,
  type SnapshotContext,
} from "@odft/contracts";
import { checkInDate, returnDepartureDate } from "@odft/domain";

/** Snapshot/combinations fixtures for Phase 04 unit tests. */

export const ROME_CITY_ID = "geonames:3169070";

export function snapshotContext(overrides: Partial<SnapshotContext> = {}): SnapshotContext {
  return {
    destinationCityId: ROME_CITY_ID,
    countryKey: "IT",
    cityName: "Rome",
    center: { lat: 41.89193, lon: 12.51133 },
    envelopeRadiusKm: 16,
    cityZone: "Europe/Rome",
    cityFactor: 1.0,
    sightseeingDate: "2026-12-01",
    travelVariant: "two_nights",
    adults: 2,
    isCurated: true,
    referenceVersion: REFERENCE_VERSION,
    ...overrides,
  };
}

export function flightApproval(
  overrides: Partial<FeasibleRouteApproval> = {},
): FeasibleRouteApproval {
  return {
    routeValidationId: "11111111-1111-4111-8111-111111111111",
    status: "FEASIBLE",
    fingerprint: "a".repeat(64),
    policyVersion: ROUTE_POLICY_VERSION,
    approvedAirportPairs: [["PRG", "FCO"]],
    approvedPairDetails: [
      {
        originAirportId: "ourairports:4408",
        originIata: "PRG",
        originZone: "Europe/Prague",
        originLat: 50.100874,
        originLon: 14.259911,
        destinationAirportId: "ourairports:4372",
        destinationIata: "FCO",
        destinationZone: "Europe/Rome",
        destinationLat: 41.804532,
        destinationLon: 12.251998,
        destinationTransferMinutes: 45,
        distanceKm: 1000,
        connectionHub: null,
        isException: true,
        airDoorToDoorMinutes: 366,
        evidenceRefs: [],
      },
    ],
    expiresWithInputs: true,
    ...overrides,
  };
}

function instantAt(date: string, minutes: number, zone: string): string {
  const day = Temporal.PlainDate.from(date);
  return Temporal.ZonedDateTime.from(
    {
      timeZone: zone,
      year: day.year,
      month: day.month,
      day: day.day,
      hour: Math.floor(minutes / 60),
      minute: minutes % 60,
    },
    { disambiguation: "compatible" },
  )
    .toInstant()
    .toString();
}

export interface DirectCombinationOptions {
  readonly sightseeingDate: string;
  readonly variant?: "one_night" | "two_nights";
  readonly elapsedMinutes?: number;
  readonly outboundArrivalLocalMinutes?: number;
  readonly returnDepartureLocalMinutes?: number;
  readonly adults?: number;
  readonly id?: string;
}

/** A schedule-valid PRG-FCO direct combination with correct dates/zones. */
export function directCombination(options: DirectCombinationOptions): FlightCombination {
  const variant = options.variant ?? "two_nights";
  const elapsed = options.elapsedMinutes ?? 111;
  const outboundDate = checkInDate(options.sightseeingDate);
  const returnDate = returnDepartureDate(options.sightseeingDate, variant);
  const arrivalInstant = instantAt(
    outboundDate,
    options.outboundArrivalLocalMinutes ?? 1080,
    "Europe/Rome",
  );
  const departureInstant = Temporal.Instant.from(arrivalInstant)
    .subtract({ minutes: elapsed })
    .toString();
  const returnDepartureInstant = instantAt(
    returnDate,
    options.returnDepartureLocalMinutes ?? 1380,
    "Europe/Rome",
  );
  const returnArrivalInstant = Temporal.Instant.from(returnDepartureInstant)
    .add({ minutes: elapsed })
    .toString();

  return {
    id: options.id ?? "demo-flights-fixture",
    outbound: {
      direction: "outbound",
      segments: [
        {
          fromAirportId: "ourairports:4408",
          toAirportId: "ourairports:4372",
          fromIata: "PRG",
          toIata: "FCO",
          departureInstant,
          arrivalInstant,
          departureZone: "Europe/Prague",
          arrivalZone: "Europe/Rome",
          elapsedMinutes: elapsed,
          airlineName: "Demo Air",
          airlineCode: "DA",
          flightNumber: "D100",
        },
      ],
    },
    inbound: {
      direction: "inbound",
      segments: [
        {
          fromAirportId: "ourairports:4372",
          toAirportId: "ourairports:4408",
          fromIata: "FCO",
          toIata: "PRG",
          departureInstant: returnDepartureInstant,
          arrivalInstant: returnArrivalInstant,
          departureZone: "Europe/Rome",
          arrivalZone: "Europe/Prague",
          elapsedMinutes: elapsed,
          airlineName: "Demo Air",
          airlineCode: "DA",
          flightNumber: "D100R",
        },
      ],
    },
    adults: options.adults ?? 2,
    supportedVariants: [variant],
    perAdultMinor: 18_000,
    partyTotalMinor: 36_000,
    synthetic: true,
    demoLabels: ["Demo offer", "Simulated schedule/price"],
  };
}

export const SCENARIO_CONSTANTS = { SCHEMA_VERSION, GENERATOR_VERSION, REFERENCE_VERSION };
