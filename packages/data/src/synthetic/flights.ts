import { Temporal } from "@js-temporal/polyfill";
import type { Faker } from "@faker-js/faker";
import type {
  ApprovedRoutePair,
  FeasibleRouteApproval,
  FlightCombination,
  FlightDirection,
  FlightSegment,
  RouteInputs,
  TravelVariant,
} from "@odft/contracts";
import { assertApprovalCurrent } from "../feasibility/approval-guard.js";
import { haversineKm } from "../routing/haversine.js";
import { DomainError } from "@odft/domain";
import { createDomainFaker } from "./seed.js";
import { deriveOfferId } from "./ids.js";
import {
  flightDemandFactor,
  flightScheduleDemandFactor,
  priceFlightPerAdult,
  seasonFactor,
} from "./pricing.js";

/**
 * Deterministic flight generator (05 section 6). Reads only a fresh
 * `FeasibleRouteApproval`; produces outbound/return directions with UTC
 * instants + IANA zones, at most one connection per direction, and
 * party-priced combinations with stable IDs. Never repairs invalid data.
 */

export interface FlightGenerationContext {
  readonly scenarioKey: string;
  readonly seed: string;
  readonly sightseeingDate: string;
  readonly travelVariant: TravelVariant;
  readonly adults: number;
  readonly generatorVersion: string;
}

const COMBINATIONS_PER_PAIR = 6;
const MIN_AIRBORNE_VARIATION = -8;
const MAX_AIRBORNE_VARIATION = 8;
const OUTBOUND_ARRIVAL_MINUTES = [960, 990, 1020, 1050, 1080, 1110] as const;
const RETURN_DEPARTURE_MINUTES = [1260, 1290, 1310, 1330, 1350, 1370] as const;

const AIRLINE_NAMES = [
  "Demo Air",
  "Skyline Demo",
  "Aurora Demo",
  "Northwind Demo",
  "Vector Demo",
  "Meridian Demo",
];
const AIRLINE_CODES = ["DA", "SD", "AD", "ND", "VD", "MD"];

function zonedAt(
  date: Temporal.PlainDate,
  minuteOfDay: number,
  zone: string,
): Temporal.ZonedDateTime {
  return Temporal.ZonedDateTime.from(
    {
      timeZone: zone,
      year: date.year,
      month: date.month,
      day: date.day,
      hour: Math.floor(minuteOfDay / 60),
      minute: minuteOfDay % 60,
      second: 0,
    },
    { disambiguation: "compatible" },
  );
}

function toInstant(date: string, minuteOfDay: number, zone: string): Temporal.Instant {
  return zonedAt(Temporal.PlainDate.from(date), minuteOfDay, zone).toInstant();
}

function addDays(date: string, days: number): string {
  return Temporal.PlainDate.from(date).add({ days }).toString();
}

function legMinutes(distanceKm: number, variation: number): number {
  return Math.max(35, Math.ceil(25 + (distanceKm / 700) * 60) + variation);
}

function segment(
  fromAirportId: string,
  fromIata: string,
  fromZone: string,
  toAirportId: string,
  toIata: string,
  toZone: string,
  departureInstant: Temporal.Instant,
  elapsedMinutes: number,
  airlineName: string,
  airlineCode: string,
  flightNumber: string,
): FlightSegment {
  return {
    fromAirportId,
    toAirportId,
    fromIata,
    toIata,
    departureInstant: departureInstant.toString({ smallestUnit: "second" }),
    arrivalInstant: departureInstant
      .add({ minutes: elapsedMinutes })
      .toString({ smallestUnit: "second" }),
    departureZone: fromZone,
    arrivalZone: toZone,
    elapsedMinutes,
    airlineName,
    airlineCode,
    flightNumber,
  };
}

function buildDirection(
  pair: ApprovedRoutePair & { __sightseeingDate: string; __seasonFactor: number },
  variant: TravelVariant,
  index: number,
  faker: Faker,
): { outbound: FlightDirection; inbound: FlightDirection; perAdultMinor: number } {
  const variation = faker.number.int({ min: MIN_AIRBORNE_VARIATION, max: MAX_AIRBORNE_VARIATION });
  const originPoint = { lat: pair.originLat, lon: pair.originLon };
  const destinationPoint = { lat: pair.destinationLat, lon: pair.destinationLon };
  const originToHub = pair.connectionHub
    ? haversineKm(originPoint, { lat: pair.connectionHub.lat, lon: pair.connectionHub.lon })
    : pair.distanceKm;
  const hubToDestination = pair.connectionHub
    ? haversineKm({ lat: pair.connectionHub.lat, lon: pair.connectionHub.lon }, destinationPoint)
    : 0;

  const airlineName = AIRLINE_NAMES[index % AIRLINE_NAMES.length] as string;
  const airlineCode = AIRLINE_CODES[index % AIRLINE_CODES.length] as string;
  const flightNumber = `D${100 + index}`;

  const outboundDate = addDays(pair.__sightseeingDate, -1);
  const outboundArrival = OUTBOUND_ARRIVAL_MINUTES[
    index % OUTBOUND_ARRIVAL_MINUTES.length
  ] as number;
  const outboundElapsed = legMinutes(pair.distanceKm, variation);

  let outbound: FlightDirection;
  let outboundConnections = 0;
  if (pair.connectionHub) {
    const hubLeg1 = legMinutes(originToHub, variation);
    const hubLeg2 = legMinutes(hubToDestination, -variation);
    outboundConnections = 1;
    const finalArrival = toInstant(outboundDate, outboundArrival, pair.destinationZone);
    const secondDeparture = finalArrival.subtract({ minutes: hubLeg2 });
    const firstArrival = secondDeparture.subtract({ minutes: 90 });
    const firstDeparture = firstArrival.subtract({ minutes: hubLeg1 });
    const hub = pair.connectionHub;
    outbound = {
      direction: "outbound",
      segments: [
        segment(
          pair.originAirportId,
          pair.originIata,
          pair.originZone,
          `hub:${hub.iata}`,
          hub.iata,
          hub.zone,
          firstDeparture,
          hubLeg1,
          airlineName,
          airlineCode,
          `${flightNumber}A`,
        ),
        segment(
          `hub:${hub.iata}`,
          hub.iata,
          hub.zone,
          pair.destinationAirportId,
          pair.destinationIata,
          pair.destinationZone,
          secondDeparture,
          hubLeg2,
          airlineName,
          airlineCode,
          `${flightNumber}B`,
        ),
      ],
    };
  } else {
    const arrival = toInstant(outboundDate, outboundArrival, pair.destinationZone);
    const departure = arrival.subtract({ minutes: outboundElapsed });
    outbound = {
      direction: "outbound",
      segments: [
        segment(
          pair.originAirportId,
          pair.originIata,
          pair.originZone,
          pair.destinationAirportId,
          pair.destinationIata,
          pair.destinationZone,
          departure,
          outboundElapsed,
          airlineName,
          airlineCode,
          flightNumber,
        ),
      ],
    };
  }

  const returnDate = addDays(pair.__sightseeingDate, variant === "one_night" ? 0 : 1);
  const returnDeparture = RETURN_DEPARTURE_MINUTES[
    index % RETURN_DEPARTURE_MINUTES.length
  ] as number;
  const returnElapsed = legMinutes(pair.distanceKm, -variation);
  let inbound: FlightDirection;
  let inboundConnections = 0;
  if (pair.connectionHub) {
    const hubLeg1 = legMinutes(hubToDestination, -variation);
    const hubLeg2 = legMinutes(originToHub, variation);
    const hub = pair.connectionHub;
    inboundConnections = 1;
    const firstDeparture = toInstant(returnDate, returnDeparture, pair.destinationZone);
    const firstArrival = firstDeparture.add({ minutes: hubLeg1 });
    const secondDeparture = firstArrival.add({ minutes: 90 });
    inbound = {
      direction: "inbound",
      segments: [
        segment(
          pair.destinationAirportId,
          pair.destinationIata,
          pair.destinationZone,
          `hub:${hub.iata}`,
          hub.iata,
          hub.zone,
          firstDeparture,
          hubLeg1,
          airlineName,
          airlineCode,
          `${flightNumber}C`,
        ),
        segment(
          `hub:${hub.iata}`,
          hub.iata,
          hub.zone,
          pair.originAirportId,
          pair.originIata,
          pair.originZone,
          secondDeparture,
          hubLeg2,
          airlineName,
          airlineCode,
          `${flightNumber}D`,
        ),
      ],
    };
  } else {
    const departure = toInstant(returnDate, returnDeparture, pair.destinationZone);
    inbound = {
      direction: "inbound",
      segments: [
        segment(
          pair.destinationAirportId,
          pair.destinationIata,
          pair.destinationZone,
          pair.originAirportId,
          pair.originIata,
          pair.originZone,
          departure,
          returnElapsed,
          airlineName,
          airlineCode,
          `${flightNumber}R`,
        ),
      ],
    };
  }

  // Demand-based fares: each direction is priced with its own connection count,
  // a bounded seeded demand factor, and the demand of its local departure bank.
  const outboundLocalHour = Temporal.Instant.from(
    (outbound.segments[0] as FlightSegment).departureInstant,
  ).toZonedDateTimeISO(pair.originZone).hour;
  const inboundLocalHour = Temporal.Instant.from(
    (inbound.segments[0] as FlightSegment).departureInstant,
  ).toZonedDateTimeISO(pair.destinationZone).hour;
  const perAdult =
    priceFlightPerAdult(
      pair.distanceKm,
      {
        seasonFactor: pair.__seasonFactor,
        tierFactor: 1,
        demandFactor:
          flightDemandFactor(faker.number.float({ min: 0, max: 1 })) *
          flightScheduleDemandFactor(outboundLocalHour),
      },
      outboundConnections,
    ) +
    priceFlightPerAdult(
      pair.distanceKm,
      {
        seasonFactor: pair.__seasonFactor,
        tierFactor: 1,
        demandFactor:
          flightDemandFactor(faker.number.float({ min: 0, max: 1 })) *
          flightScheduleDemandFactor(inboundLocalHour),
      },
      inboundConnections,
    );
  return { outbound, inbound, perAdultMinor: perAdult };
}

export function generateFlights(
  approval: FeasibleRouteApproval,
  context: FlightGenerationContext,
  current: RouteInputs,
): FlightCombination[] {
  // The approval must match the live inputs AND the generation context, so a
  // caller cannot generate offers for unapproved dates/variants/party sizes.
  assertApprovalCurrent(approval, current);
  if (
    context.sightseeingDate !== current.sightseeingDate ||
    context.travelVariant !== current.travelVariant ||
    context.adults !== current.adults
  ) {
    throw new DomainError(
      "STALE_ROUTE_APPROVAL",
      "flight generation context does not match the current route inputs",
    );
  }

  const month = Temporal.PlainDate.from(context.sightseeingDate).month;
  const season = seasonFactor(month);
  const combinations: FlightCombination[] = [];

  // Deterministic pair order (independent of DB/array order).
  const pairs = [...approval.approvedPairDetails].sort((a, b) =>
    `${a.destinationAirportId}:${a.destinationIata}`.localeCompare(
      `${b.destinationAirportId}:${b.destinationIata}`,
    ),
  );

  for (const pair of pairs) {
    // A dedicated per-pair stream so one pair's output never depends on order.
    const faker = createDomainFaker(
      context.seed,
      context.scenarioKey,
      "flights",
      `${context.generatorVersion}:${pair.destinationIata}`,
    );
    const enriched: ApprovedRoutePair & {
      __sightseeingDate: string;
      __seasonFactor: number;
    } = { ...pair, __sightseeingDate: context.sightseeingDate, __seasonFactor: season };
    for (let index = 0; index < COMBINATIONS_PER_PAIR; index += 1) {
      const { outbound, inbound, perAdultMinor } = buildDirection(
        enriched,
        context.travelVariant,
        index,
        faker,
      );
      combinations.push({
        id: deriveOfferId(context.scenarioKey, "flights", index, pair.destinationIata),
        outbound,
        inbound,
        adults: context.adults,
        supportedVariants: [context.travelVariant],
        perAdultMinor,
        partyTotalMinor: perAdultMinor * context.adults,
        synthetic: true,
        demoLabels: ["Demo offer", "Simulated schedule/price"],
      });
    }
  }
  return combinations;
}
