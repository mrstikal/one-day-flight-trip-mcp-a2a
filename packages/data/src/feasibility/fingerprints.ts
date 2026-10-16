import type { FlightCombination, RouteInputs, ScheduleValidationInput } from "@odft/contracts";
import { fingerprint } from "@odft/domain";

/**
 * Route and schedule fingerprints (04-domain-model.md section 4).
 *
 * The route fingerprint binds every input that can change the Stage A decision.
 * The schedule fingerprint binds ONLY the stable scenario key, flight-domain
 * version/hash, schedule-rule version, route approval, and combination content
 * — never the whole snapshot version, so extending dinner inventory cannot
 * invalidate flights.
 */

function sortedPairEvidence(
  input: RouteInputs,
): { destinationIata: string; evidenceRefs: string[] }[] {
  const originRef = `airport:${input.origin.iata}`;
  const matches: { destinationIata: string; evidenceRefs: string[] }[] = [];
  for (const airport of input.destinationAirports) {
    const destinationRef = `airport:${airport.iata}`;
    for (const exception of input.islandExceptions) {
      if (exception.originRef === originRef && exception.destinationRef === destinationRef) {
        matches.push({
          destinationIata: airport.iata,
          evidenceRefs: [...exception.evidenceRefs].sort(),
        });
      }
    }
  }
  return matches.sort((a, b) => a.destinationIata.localeCompare(b.destinationIata));
}

function matchedGroundCorridor(
  input: RouteInputs,
): { minutes: number; evidenceRefs: string[] } | null {
  const originRef = `airport:${input.origin.iata}`;
  for (const corridor of input.groundCorridors) {
    if (corridor.originRef === originRef && corridor.destinationRef === input.destination.cityId) {
      return { minutes: corridor.minutes, evidenceRefs: [...corridor.evidenceRefs].sort() };
    }
  }
  return null;
}

function matchedCuratedDirectPairs(input: RouteInputs): string[] {
  const candidateIatas = new Set(input.destinationAirports.map((airport) => airport.iata));
  const matched: string[] = [];
  for (const [from, to] of input.curatedDirectPairs) {
    if (from === input.origin.iata && candidateIatas.has(to)) {
      matched.push(`${from}-${to}`);
    }
  }
  return matched.sort();
}

export function computeRouteFingerprint(input: RouteInputs): string {
  const payload = {
    schemaVersion: input.schemaVersion,
    routePolicyVersion: input.routePolicyVersion,
    generatorVersion: input.generatorVersion,
    referenceVersion: input.referenceVersion,
    origin: {
      airportId: input.origin.airportId,
      iata: input.origin.iata,
      countryKey: input.origin.countryKey,
      lat: input.origin.lat,
      lon: input.origin.lon,
      zone: input.origin.zone,
      zoneResolved: input.origin.zoneResolved,
      metroCatchmentId: input.origin.metroCatchmentId,
      eligibleOrigin: input.origin.eligibleOrigin,
      largeAirport: input.origin.largeAirport,
    },
    destination: {
      countryKey: input.destination.countryKey,
      cityId: input.destination.cityId,
      lat: input.destination.lat,
      lon: input.destination.lon,
      zone: input.destination.zone,
      zoneResolved: input.destination.zoneResolved,
      metroCatchmentId: input.destination.metroCatchmentId,
    },
    destinationAirports: [...input.destinationAirports]
      .map((airport) => ({
        airportId: airport.airportId,
        iata: airport.iata,
        countryKey: airport.countryKey,
        lat: airport.lat,
        lon: airport.lon,
        zone: airport.zone,
        zoneResolved: airport.zoneResolved,
        metroCatchmentId: airport.metroCatchmentId,
        transferMinutes: airport.transferMinutes,
        transferMode: airport.transferMode,
        eligibleDestination: airport.eligibleDestination,
        largeAirport: airport.largeAirport,
        reviewed: airport.reviewed,
      }))
      .sort((a, b) => a.airportId.localeCompare(b.airportId)),
    hubAirports: [...input.hubAirports]
      .map((hub) => ({ iata: hub.iata, lat: hub.lat, lon: hub.lon, zone: hub.zone }))
      .sort((a, b) => a.iata.localeCompare(b.iata)),
    transfer: input.transfer,
    sightseeingDate: input.sightseeingDate,
    travelVariant: input.travelVariant,
    adults: input.adults,
    groundCorridor: matchedGroundCorridor(input),
    islandExceptions: sortedPairEvidence(input),
    curatedDirectPairs: matchedCuratedDirectPairs(input),
  };
  return fingerprint(payload);
}

function combinationContent(combination: FlightCombination): {
  id: string;
  outbound: FlightCombination["outbound"];
  inbound: FlightCombination["inbound"];
  adults: number;
  supportedVariants: string[];
  perAdultMinor: number;
  partyTotalMinor: number;
} {
  return {
    id: combination.id,
    outbound: combination.outbound,
    inbound: combination.inbound,
    adults: combination.adults,
    supportedVariants: [...combination.supportedVariants].sort(),
    perAdultMinor: combination.perAdultMinor,
    partyTotalMinor: combination.partyTotalMinor,
  };
}

export function computeScheduleFingerprint(input: ScheduleValidationInput): string {
  const combinations = [...input.combinations]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(combinationContent);
  const payload = {
    scenarioKey: input.scenarioKey,
    flightDomainVersion: input.flightDomainVersion,
    flightDomainHash: input.flightDomainHash,
    scheduleRuleVersion: input.scheduleRuleVersion,
    routeApprovalFingerprint: input.approval.fingerprint,
    sightseeingDate: input.sightseeingDate,
    travelVariant: input.travelVariant,
    destinationZone: input.destinationZone,
    destinationTransferMinutes: input.destinationTransferMinutes,
    combinations,
  };
  return fingerprint(payload);
}
