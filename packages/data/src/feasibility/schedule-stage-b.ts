import { Temporal } from "@js-temporal/polyfill";
import type {
  FlightCombination,
  FlightDirection,
  FlightSegment,
  ScheduleReason,
  ScheduleValidation,
  ScheduleValidationInput,
  TravelVariant,
} from "@odft/contracts";
import { computeScheduleFingerprint } from "./fingerprints.js";
import { haversineKm } from "../routing/haversine.js";
import { MAX_DOOR_TO_DOOR_MINUTES, MIN_AIRBORNE_MINUTES } from "./route-stage-a.js";

/**
 * Stage B independent schedule validator (05 section 6). Rejects wrong dates,
 * late arrivals, too-early returns, impossible/incoherent connections,
 * implausible per-leg durations, timezone problems, price inconsistencies, and
 * door-to-door violations with typed reason codes. It NEVER repairs invalid
 * data and is never an LLM decision.
 */

export const CONNECTION_MIN_MINUTES = 75;
export const CONNECTION_MAX_MINUTES = 240;
export const ARRIVAL_CLEARANCE_MINUTES = 45;
export const DEPARTURE_BUFFER_MINUTES = 120;
export const ORIGIN_ACCESS_MINUTES = 45;
export const CHECKIN_BUFFER_MINUTES = 20;
export const HOTEL_LATEST_ARRIVAL_MINUTES = 22 * 60;
export const CORE_SIGHTSEEING_END_MINUTES = 18 * 60;

function instant(value: string): Temporal.Instant {
  return Temporal.Instant.from(value);
}

function zoned(value: string, zone: string): Temporal.ZonedDateTime {
  return instant(value).toZonedDateTimeISO(zone);
}

/** Destination-local wall clock anchored to a calendar date (DST-aware). */
function tryLocalWallClock(
  date: string,
  minuteOfDay: number,
  zone: string,
): Temporal.ZonedDateTime | null {
  const day = Temporal.PlainDate.from(date);
  try {
    return Temporal.ZonedDateTime.from(
      {
        timeZone: zone,
        year: day.year,
        month: day.month,
        day: day.day,
        hour: Math.floor(minuteOfDay / 60),
        minute: minuteOfDay % 60,
        second: 0,
      },
      { disambiguation: "reject" },
    );
  } catch {
    return null;
  }
}

function localDate(value: string, zone: string): string {
  return zoned(value, zone).toPlainDate().toString();
}

function minutesBetween(start: string, end: string): number {
  return Math.round(instant(start).until(instant(end)).total({ unit: "minutes" }));
}

function firstDeparture(direction: FlightDirection): FlightSegment {
  return direction.segments[0] as FlightSegment;
}

function lastArrival(direction: FlightDirection): FlightSegment {
  return direction.segments[direction.segments.length - 1] as FlightSegment;
}

function expectedDurationMinutes(distanceKm: number): number {
  return Math.ceil(25 + (distanceKm / 700) * 60);
}

function evaluateDirection(
  direction: FlightDirection,
  codes: ScheduleReason[],
  zones: Map<string, string>,
  legDistances: Map<string, number>,
  fallbackZone: string,
): void {
  const segments = direction.segments;
  if (segments.length > 2) {
    codes.push("INVALID_CONNECTION");
  }
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as FlightSegment;
    const fromZone = zones.get(segment.fromIata) ?? fallbackZone;
    const toZone = zones.get(segment.toIata) ?? fallbackZone;
    if (segment.departureZone !== fromZone || segment.arrivalZone !== toZone) {
      codes.push("INVALID_TIMEZONE");
    }
    const actualElapsed = minutesBetween(segment.departureInstant, segment.arrivalInstant);
    if (
      actualElapsed <= 0 ||
      actualElapsed !== segment.elapsedMinutes ||
      actualElapsed < MIN_AIRBORNE_MINUTES
    ) {
      codes.push("INVALID_DURATION");
    }
    const legDistance = legDistances.get(`${segment.fromIata}-${segment.toIata}`);
    if (legDistance !== undefined) {
      const expected = expectedDurationMinutes(legDistance);
      const tolerance = Math.max(15, expected * 0.25);
      if (Math.abs(segment.elapsedMinutes - expected) > tolerance) {
        codes.push("INVALID_DURATION");
      }
    }
    if (index > 0) {
      const previous = segments[index - 1] as FlightSegment;
      if (previous.toAirportId !== segment.fromAirportId || previous.toIata !== segment.fromIata) {
        codes.push("INVALID_CONNECTION");
      }
      const layover = minutesBetween(previous.arrivalInstant, segment.departureInstant);
      if (layover < CONNECTION_MIN_MINUTES) {
        codes.push("CONNECTION_TOO_SHORT");
      }
      if (layover > CONNECTION_MAX_MINUTES) {
        codes.push("CONNECTION_TOO_LONG");
      }
    }
  }
}

function addLeg(map: Map<string, number>, from: string, to: string, distanceKm: number): void {
  map.set(`${from}-${to}`, distanceKm);
  map.set(`${to}-${from}`, distanceKm);
}

function legDistancesFor(
  pair: ScheduleValidationInput["approval"]["approvedPairDetails"][number] | undefined,
): Map<string, number> {
  const map = new Map<string, number>();
  if (!pair) {
    return map;
  }
  const origin = { lat: pair.originLat, lon: pair.originLon };
  const destination = { lat: pair.destinationLat, lon: pair.destinationLon };
  if (pair.connectionHub) {
    const hubPoint = { lat: pair.connectionHub.lat, lon: pair.connectionHub.lon };
    addLeg(map, pair.originIata, pair.connectionHub.iata, haversineKm(origin, hubPoint));
    addLeg(map, pair.connectionHub.iata, pair.destinationIata, haversineKm(hubPoint, destination));
  }
  addLeg(map, pair.originIata, pair.destinationIata, haversineKm(origin, destination));
  return map;
}

function requiredReturnDate(sightseeingDate: string, variant: TravelVariant): string {
  return Temporal.PlainDate.from(sightseeingDate)
    .add({ days: variant === "one_night" ? 0 : 1 })
    .toString();
}

function outboundArrivalDate(sightseeingDate: string): string {
  return Temporal.PlainDate.from(sightseeingDate).subtract({ days: 1 }).toString();
}

function evaluateCombination(
  combination: FlightCombination,
  input: ScheduleValidationInput,
  zones: Map<string, string>,
): ScheduleReason[] {
  const codes: ScheduleReason[] = [];
  const destinationZone = input.destinationZone;

  if (!combination.supportedVariants.includes(input.travelVariant)) {
    codes.push("NO_MATCHING_SCHEDULE");
  }
  if (combination.partyTotalMinor !== combination.perAdultMinor * combination.adults) {
    codes.push("PRICE_MISMATCH");
  }

  const pair = input.approval.approvedPairDetails.find(
    (detail) =>
      detail.originIata === firstDeparture(combination.outbound).fromIata &&
      detail.destinationIata === lastArrival(combination.outbound).toIata,
  );
  // A combination that does not correspond to an approved pair is rejected, and
  // the inbound route must return to the origin for the same pair.
  if (!pair) {
    codes.push("NO_MATCHING_SCHEDULE");
  } else {
    const outFirst = firstDeparture(combination.outbound);
    const outLast = lastArrival(combination.outbound);
    const inFirst = firstDeparture(combination.inbound);
    const inLast = lastArrival(combination.inbound);
    if (
      outFirst.fromAirportId !== pair.originAirportId ||
      outLast.toAirportId !== pair.destinationAirportId ||
      inFirst.fromAirportId !== pair.destinationAirportId ||
      inLast.toAirportId !== pair.originAirportId
    ) {
      codes.push("NO_MATCHING_SCHEDULE");
    }
  }

  // Always use the approved pair's transfer, not a caller-supplied value.
  const transfer = pair?.destinationTransferMinutes ?? input.destinationTransferMinutes;
  const legDistances = legDistancesFor(pair);
  evaluateDirection(combination.outbound, codes, zones, legDistances, destinationZone);

  // Outbound arrival on destination-local D-1.
  const outboundArrival = lastArrival(combination.outbound).arrivalInstant;
  const arrivalDate = outboundArrivalDate(input.sightseeingDate);
  if (localDate(outboundArrival, destinationZone) !== arrivalDate) {
    codes.push("OUTBOUND_DATE");
  }

  // Arrival + clearance + transfer + check-in <= destination-local D-1 22:00.
  const latest = tryLocalWallClock(arrivalDate, HOTEL_LATEST_ARRIVAL_MINUTES, destinationZone);
  if (!latest) {
    codes.push("INVALID_TIMEZONE");
  } else {
    const readyBy = zoned(outboundArrival, destinationZone).add({
      minutes: ARRIVAL_CLEARANCE_MINUTES + transfer + CHECKIN_BUFFER_MINUTES,
    });
    if (Temporal.ZonedDateTime.compare(readyBy, latest) > 0) {
      codes.push("ARRIVAL_TOO_LATE");
    }
  }
  if (transfer > 120) {
    codes.push("TRANSFER_BUFFER");
  }

  evaluateDirection(combination.inbound, codes, zones, legDistances, destinationZone);

  // Return departs on the variant-specific destination-local date.
  const returnDeparture = firstDeparture(combination.inbound).departureInstant;
  const expectedReturn = requiredReturnDate(input.sightseeingDate, input.travelVariant);
  if (localDate(returnDeparture, destinationZone) !== expectedReturn) {
    codes.push("RETURN_DATE");
  }

  // Late return: at/after destination-local 18:00 core end + transfer + buffer.
  const sightseeingEnd = tryLocalWallClock(
    expectedReturn,
    CORE_SIGHTSEEING_END_MINUTES,
    destinationZone,
  );
  if (!sightseeingEnd) {
    codes.push("INVALID_TIMEZONE");
  } else {
    const threshold = sightseeingEnd.add({ minutes: transfer + DEPARTURE_BUFFER_MINUTES });
    if (Temporal.ZonedDateTime.compare(zoned(returnDeparture, destinationZone), threshold) < 0) {
      codes.push("RETURN_TOO_EARLY");
      codes.push("INSUFFICIENT_SIGHTSEEING");
    }
  }

  // Realized door-to-door per direction (connections once).
  const outboundElapsed = minutesBetween(
    firstDeparture(combination.outbound).departureInstant,
    outboundArrival,
  );
  const inboundElapsed = minutesBetween(
    returnDeparture,
    lastArrival(combination.inbound).arrivalInstant,
  );
  const outboundDoor =
    ORIGIN_ACCESS_MINUTES +
    DEPARTURE_BUFFER_MINUTES +
    outboundElapsed +
    ARRIVAL_CLEARANCE_MINUTES +
    transfer;
  const inboundDoor =
    transfer +
    DEPARTURE_BUFFER_MINUTES +
    inboundElapsed +
    ARRIVAL_CLEARANCE_MINUTES +
    ORIGIN_ACCESS_MINUTES;
  if (outboundDoor > MAX_DOOR_TO_DOOR_MINUTES || inboundDoor > MAX_DOOR_TO_DOOR_MINUTES) {
    codes.push("DOOR_TO_DOOR_TOO_LONG");
  }

  return [...new Set(codes)];
}

export function validateSchedules(input: ScheduleValidationInput): ScheduleValidation {
  const fingerprint = computeScheduleFingerprint(input);
  const zones = new Map<string, string>();
  for (const pair of input.approval.approvedPairDetails) {
    zones.set(pair.originIata, pair.originZone);
    zones.set(pair.destinationIata, pair.destinationZone);
    if (pair.connectionHub) {
      zones.set(pair.connectionHub.iata, pair.connectionHub.zone);
    }
  }

  if (input.approval.status !== "FEASIBLE" || input.approval.expiresWithInputs !== true) {
    return {
      status: "NO_VALID_OFFERS",
      routeValidationId: input.routeValidationId,
      fingerprint,
      validCombinationIds: [],
      rejected: input.combinations.map((combination) => ({
        combinationId: combination.id,
        codes: ["STALE_ROUTE_APPROVAL"],
      })),
      explanation: "Stage A approval is not a current FEASIBLE server approval.",
    };
  }

  const rejected: { combinationId: string; codes: ScheduleReason[] }[] = [];
  const validCombinationIds: string[] = [];
  for (const combination of input.combinations) {
    const codes = evaluateCombination(combination, input, zones);
    if (codes.length === 0) {
      validCombinationIds.push(combination.id);
    } else {
      rejected.push({ combinationId: combination.id, codes });
    }
  }

  const status = validCombinationIds.length > 0 ? "VALID" : "NO_VALID_OFFERS";
  return {
    status,
    routeValidationId: input.routeValidationId,
    fingerprint,
    validCombinationIds,
    rejected,
    explanation:
      status === "VALID"
        ? `${validCombinationIds.length} of ${input.combinations.length} generated combinations satisfy the schedule rules.`
        : "No generated combination satisfies the schedule rules; a schedule-recovery decision is required.",
  };
}
