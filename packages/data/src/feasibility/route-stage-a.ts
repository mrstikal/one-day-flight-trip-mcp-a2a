import type {
  ApprovedRoutePair,
  FeasibleRouteValidation,
  RouteAirport,
  RouteHub,
  RouteInputs,
  RouteReason,
  RouteReasonEntry,
  RouteValidation,
} from "@odft/contracts";
import { haversineKm } from "../routing/haversine.js";
import { computeRouteFingerprint } from "./fingerprints.js";

/**
 * Stage A deterministic route feasibility (05 section 5). Pure TypeScript, no
 * LLM. Ordered rule table with typed reason codes; `FEASIBLE` is a bound
 * approval, never a graph boolean.
 */

export const MIN_AIRBORNE_MINUTES = 35;
export const GROUND_PREFERRED_MAX_MINUTES = 300;
export const GROUND_ADVANTAGE_MINUTES = 45;
export const DIRECT_MIN_KM = 350;
export const DIRECT_MAX_KM = 3500;
export const CONNECTION_NOMINAL_MINUTES = 120;
export const MAX_DOOR_TO_DOOR_MINUTES = 600;

export const DEFAULT_TRANSFER_POLICY = {
  originAccessMinutes: 45,
  departureBufferMinutes: 120,
  arrivalClearanceMinutes: 45,
  maxDestinationTransferMinutes: 120,
  minConnectionMinutes: 75,
  maxConnectionMinutes: 240,
} as const;

/** Airborne duration for a direct leg: `ceil(25 + km / 700 * 60)`, min 35. */
export function airborneMinutes(distanceKm: number): number {
  return Math.max(MIN_AIRBORNE_MINUTES, Math.ceil(25 + (distanceKm / 700) * 60));
}

/** Optimistic pre-airport lower bound: no airport/offer is invented. */
export function minimumAirProcessMinutes(input: RouteInputs): number {
  return (
    input.transfer.originAccessMinutes +
    input.transfer.departureBufferMinutes +
    MIN_AIRBORNE_MINUTES +
    input.transfer.arrivalClearanceMinutes
  );
}

function matchedGroundCorridor(
  input: RouteInputs,
): { minutes: number; evidenceRefs: string[] } | null {
  const originRef = `airport:${input.origin.iata}`;
  for (const corridor of input.groundCorridors) {
    if (corridor.originRef === originRef && corridor.destinationRef === input.destination.cityId) {
      return { minutes: corridor.minutes, evidenceRefs: corridor.evidenceRefs };
    }
  }
  return null;
}

function isExceptionPair(
  input: RouteInputs,
  airport: RouteAirport,
): { isException: boolean; evidenceRefs: string[] } {
  const originRef = `airport:${input.origin.iata}`;
  const destinationRef = `airport:${airport.iata}`;
  const evidence: string[] = [];
  let isException = false;
  for (const exception of input.islandExceptions) {
    if (exception.originRef === originRef && exception.destinationRef === destinationRef) {
      isException = true;
      evidence.push(...exception.evidenceRefs);
    }
  }
  for (const [from, to] of input.curatedDirectPairs) {
    if (from === input.origin.iata && to === airport.iata) {
      isException = true;
      evidence.push(`curated-direct:${from}-${to}`);
    }
  }
  return { isException, evidenceRefs: evidence };
}

function hubLegException(input: RouteInputs, fromIata: string, toIata: string): boolean {
  const fromRef = `airport:${fromIata}`;
  const toRef = `airport:${toIata}`;
  for (const exception of input.islandExceptions) {
    if (
      (exception.originRef === fromRef && exception.destinationRef === toRef) ||
      (exception.originRef === toRef && exception.destinationRef === fromRef)
    ) {
      return true;
    }
  }
  for (const [from, to] of input.curatedDirectPairs) {
    if ((from === fromIata && to === toIata) || (from === toIata && to === fromIata)) {
      return true;
    }
  }
  return false;
}

/**
 * Choose the first reviewed hub whose two legs are each eligible: every leg must
 * clear the same `< 350 km` short-route rule as a direct pair, unless it is an
 * explicit reviewed exception. This prevents authorizing arbitrary short
 * sub-legs (e.g. BRQ -> VIE) as a "connection".
 */
function pickEligibleHub(
  input: RouteInputs,
  airport: RouteAirport,
): { hub: RouteHub | null; onlyShortLegs: boolean } {
  let sawShortLeg = false;
  for (const hub of input.hubAirports) {
    if (hub.iata === input.origin.iata || hub.iata === airport.iata) {
      continue;
    }
    const originToHub = haversineKm(input.origin, hub);
    const hubToDestination = haversineKm(hub, airport);
    const firstOk =
      originToHub >= DIRECT_MIN_KM || hubLegException(input, input.origin.iata, hub.iata);
    const secondOk =
      hubToDestination >= DIRECT_MIN_KM || hubLegException(input, hub.iata, airport.iata);
    if (firstOk && secondOk) {
      return { hub, onlyShortLegs: false };
    }
    sawShortLeg = true;
  }
  return { hub: null, onlyShortLegs: sawShortLeg };
}

interface PairEvaluation {
  readonly airport: RouteAirport;
  readonly distanceKm: number;
  readonly hasConnection: boolean;
  readonly connectionHub: RouteHub | null;
  readonly isException: boolean;
  readonly airDoorToDoorMinutes: number;
  readonly evidenceRefs: string[];
  readonly failures: RouteReasonEntry[];
  readonly approved: ApprovedRoutePair | null;
}

function evaluatePair(input: RouteInputs, airport: RouteAirport): PairEvaluation {
  const failures: RouteReasonEntry[] = [];
  const distanceKm = haversineKm(input.origin, airport);
  const { isException, evidenceRefs } = isExceptionPair(input, airport);
  const transferMinutes = airport.transferMinutes ?? input.transfer.maxDestinationTransferMinutes;

  const bothLarge = input.origin.largeAirport && airport.largeAirport;
  const sameCatchment =
    input.origin.metroCatchmentId !== null &&
    airport.metroCatchmentId !== null &&
    input.origin.metroCatchmentId === airport.metroCatchmentId;
  const standardDirect =
    distanceKm >= DIRECT_MIN_KM && distanceKm <= DIRECT_MAX_KM && bothLarge && !sameCatchment;
  const directAllowed = isException || standardDirect;

  let hasConnection = false;
  let connectionHub: RouteHub | null = null;
  if (!directAllowed) {
    if (distanceKm < DIRECT_MIN_KM && !isException) {
      failures.push({
        code: "SHORT_ROUTE_UNJUSTIFIED",
        explanation:
          `Great-circle distance ${Math.round(distanceKm)} km is below ${DIRECT_MIN_KM} km without a reviewed ` +
          "practical comparison or geographic short-link exception.",
      });
    } else {
      const picked = pickEligibleHub(input, airport);
      connectionHub = picked.hub;
      if (connectionHub) {
        hasConnection = true;
      } else if (picked.onlyShortLegs) {
        failures.push({
          code: "SHORT_ROUTE_UNJUSTIFIED",
          explanation:
            "Every reviewed connection hub would require a sub-350 km leg without an explicit exception.",
        });
      } else {
        failures.push({
          code: "NO_PLAUSIBLE_ROUTE",
          explanation:
            "No allowed direct or single-connection synthetic route is available for this pair.",
        });
      }
    }
  }

  const airMinutes = airborneMinutes(distanceKm);
  const airDoorToDoorMinutes =
    input.transfer.originAccessMinutes +
    input.transfer.departureBufferMinutes +
    airMinutes +
    (hasConnection ? CONNECTION_NOMINAL_MINUTES : 0) +
    input.transfer.arrivalClearanceMinutes +
    transferMinutes;

  const corridor = matchedGroundCorridor(input);
  if (
    corridor &&
    corridor.minutes <= GROUND_PREFERRED_MAX_MINUTES &&
    airDoorToDoorMinutes >= corridor.minutes + GROUND_ADVANTAGE_MINUTES
  ) {
    failures.push({
      code: "GROUND_TRAVEL_PREFERRED",
      explanation:
        `Reviewed ground corridor is ${corridor.minutes} minutes and the estimated air door-to-door is ` +
        `${airDoorToDoorMinutes} minutes (>= ground + ${GROUND_ADVANTAGE_MINUTES}).`,
    });
  }

  if (airDoorToDoorMinutes > MAX_DOOR_TO_DOOR_MINUTES) {
    failures.push({
      code: "DOOR_TO_DOOR_TOO_LONG",
      explanation: `Estimated air door-to-door ${airDoorToDoorMinutes} minutes exceeds ${MAX_DOOR_TO_DOOR_MINUTES}.`,
    });
  }

  const approved: ApprovedRoutePair | null =
    failures.length === 0
      ? {
          originAirportId: input.origin.airportId,
          originIata: input.origin.iata,
          originZone: input.origin.zone as string,
          originLat: input.origin.lat,
          originLon: input.origin.lon,
          destinationAirportId: airport.airportId,
          destinationIata: airport.iata,
          destinationZone: airport.zone as string,
          destinationLat: airport.lat,
          destinationLon: airport.lon,
          destinationTransferMinutes: transferMinutes,
          distanceKm: Math.round(distanceKm * 1000) / 1000,
          connectionHub,
          isException,
          airDoorToDoorMinutes,
          evidenceRefs: [
            ...new Set([...evidenceRefs, ...(corridor ? corridor.evidenceRefs : [])]),
          ].sort(),
        }
      : null;

  return {
    airport,
    distanceKm,
    hasConnection,
    connectionHub,
    isException,
    airDoorToDoorMinutes,
    evidenceRefs,
    failures,
    approved,
  };
}

function collectReasonCodes(evaluations: readonly PairEvaluation[]): Set<RouteReason> {
  const codes = new Set<RouteReason>();
  for (const evaluation of evaluations) {
    for (const failure of evaluation.failures) {
      codes.add(failure.code);
    }
  }
  return codes;
}

function infeasible(
  status: "INFEASIBLE" | "UNDETERMINED",
  fingerprint: string,
  policyVersion: string,
  code: RouteReason,
  explanation: string,
): RouteValidation {
  return {
    status,
    fingerprint,
    policyVersion,
    reasons: [{ code, explanation }],
    alternatives: ["change_origin", "change_destination", "choose_ground_travel_elsewhere"],
  };
}

export function validateRoute(input: RouteInputs): RouteValidation {
  const fingerprint = computeRouteFingerprint(input);
  const policyVersion = input.routePolicyVersion;

  // Priority 1: unknown origin/city reference.
  if (!input.originKnown || !input.origin.eligibleOrigin) {
    return infeasible(
      "UNDETERMINED",
      fingerprint,
      policyVersion,
      "NO_REFERENCE_AIRPORT",
      "Origin airport is not a known eligible passenger reference.",
    );
  }
  if (!input.origin.zoneResolved || input.origin.zone === null) {
    return infeasible(
      "UNDETERMINED",
      fingerprint,
      policyVersion,
      "UNKNOWN_TIMEZONE",
      "Origin airport IANA zone is unresolved.",
    );
  }
  if (!input.destinationKnown) {
    return infeasible(
      "UNDETERMINED",
      fingerprint,
      policyVersion,
      "MISSING_GEOGRAPHIC_EVIDENCE",
      "Destination city coordinates, country identity, or fundamental evidence is missing.",
    );
  }

  // Priority 2: same airport / reviewed shared metro catchment (cross-border safe).
  for (const airport of input.destinationAirports) {
    if (airport.airportId === input.origin.airportId) {
      return infeasible(
        "INFEASIBLE",
        fingerprint,
        policyVersion,
        "SAME_AIRPORT",
        "Origin and destination share the same airport.",
      );
    }
    if (
      input.origin.metroCatchmentId !== null &&
      airport.metroCatchmentId !== null &&
      input.origin.metroCatchmentId === airport.metroCatchmentId
    ) {
      return infeasible(
        "INFEASIBLE",
        fingerprint,
        policyVersion,
        "SAME_CATCHMENT",
        "Origin and destination airports belong to the same reviewed metro catchment.",
      );
    }
  }

  // Priority 3: reviewed ground corridor vs the optimistic air lower bound,
  // evaluated before missing/ineligible destination airports.
  const corridor = matchedGroundCorridor(input);
  if (corridor) {
    const lowerBound = minimumAirProcessMinutes(input);
    if (
      corridor.minutes <= GROUND_PREFERRED_MAX_MINUTES &&
      lowerBound >= corridor.minutes + GROUND_ADVANTAGE_MINUTES
    ) {
      return infeasible(
        "INFEASIBLE",
        fingerprint,
        policyVersion,
        "GROUND_TRAVEL_PREFERRED",
        `Reviewed ${corridor.minutes}-minute ground corridor is preferred: the ${lowerBound}-minute pre-airport lower ` +
          "bound already exceeds ground + " +
          GROUND_ADVANTAGE_MINUTES +
          " minutes.",
      );
    }
  }

  // Priority 4: no defensible destination-airport reference.
  if (input.destinationAirports.length === 0) {
    return infeasible(
      "UNDETERMINED",
      fingerprint,
      policyVersion,
      "NO_REFERENCE_AIRPORT",
      "No defensible destination-airport reference exists within the search radius.",
    );
  }

  // Priority 5: unknown/ambiguous destination timezone.
  if (!input.destination.zoneResolved || input.destination.zone === null) {
    return infeasible(
      "UNDETERMINED",
      fingerprint,
      policyVersion,
      "UNKNOWN_TIMEZONE",
      "Destination city IANA zone is unresolved.",
    );
  }
  const zoneResolved = input.destinationAirports.filter(
    (airport) => airport.zoneResolved && airport.zone !== null,
  );
  if (zoneResolved.length === 0) {
    return infeasible(
      "UNDETERMINED",
      fingerprint,
      policyVersion,
      "UNKNOWN_TIMEZONE",
      "Destination airport IANA zone is unresolved.",
    );
  }

  // Priority 6: every otherwise supported airport transfer exceeds the bound.
  const usable = zoneResolved.filter(
    (airport) =>
      (airport.transferMinutes ?? Number.POSITIVE_INFINITY) <=
      input.transfer.maxDestinationTransferMinutes,
  );
  if (usable.length === 0) {
    return infeasible(
      "INFEASIBLE",
      fingerprint,
      policyVersion,
      "TRANSFER_TOO_LONG",
      `All candidate transfers exceed ${input.transfer.maxDestinationTransferMinutes} minutes.`,
    );
  }

  // Priority 9 (partial): neither candidate is an eligible destination airport.
  const eligible = usable.filter((airport) => airport.eligibleDestination);
  if (eligible.length === 0) {
    return infeasible(
      "UNDETERMINED",
      fingerprint,
      policyVersion,
      "MISSING_GEOGRAPHIC_EVIDENCE",
      "Candidate airports are not reviewed eligible destination airports.",
    );
  }

  const evaluations = eligible.map((airport) => evaluatePair(input, airport));
  const approved = evaluations
    .map((evaluation) => evaluation.approved)
    .filter((pair): pair is ApprovedRoutePair => pair !== null);

  if (approved.length > 0) {
    const warnings: RouteReasonEntry[] = approved
      .filter((pair) => pair.distanceKm < DIRECT_MIN_KM)
      .map((pair) => ({
        code: "SHORT_ROUTE_UNJUSTIFIED" as const,
        explanation:
          `Pair ${pair.originIata}-${pair.destinationIata} is ${Math.round(pair.distanceKm)} km and is admitted ` +
          "through the explicit reviewed geographic catalog entry, not on distance alone.",
      }));
    const evidenceRefs = [...new Set(approved.flatMap((pair) => pair.evidenceRefs))].sort();
    const result: FeasibleRouteValidation = {
      status: "FEASIBLE",
      fingerprint,
      policyVersion,
      approvedAirportPairs: approved.map(
        (pair) => [pair.originIata, pair.destinationIata] as [string, string],
      ),
      approvedPairDetails: approved,
      evidenceRefs,
      warnings,
      expiresWithInputs: true,
    };
    return result;
  }

  // Priorities 8/9/10/11: no pair passed. Classify the dominant reason in the
  // canonical ordered-table order (7 GROUND, 8 SHORT, 9 MISSING, 10 NO_PLAUSIBLE,
  // 11 DOOR).
  const codes = collectReasonCodes(evaluations);
  if (codes.has("GROUND_TRAVEL_PREFERRED")) {
    return infeasible(
      "INFEASIBLE",
      fingerprint,
      policyVersion,
      "GROUND_TRAVEL_PREFERRED",
      "Ground travel is preferred for this route.",
    );
  }
  if (codes.has("SHORT_ROUTE_UNJUSTIFIED")) {
    return infeasible(
      "UNDETERMINED",
      fingerprint,
      policyVersion,
      "SHORT_ROUTE_UNJUSTIFIED",
      "Short route below 350 km without a reviewed practical comparison or geographic exception.",
    );
  }
  if (codes.has("NO_PLAUSIBLE_ROUTE")) {
    return infeasible(
      "INFEASIBLE",
      fingerprint,
      policyVersion,
      "NO_PLAUSIBLE_ROUTE",
      "No allowed direct or one-stop synthetic route is available.",
    );
  }
  if (codes.has("DOOR_TO_DOOR_TOO_LONG")) {
    return infeasible(
      "INFEASIBLE",
      fingerprint,
      policyVersion,
      "DOOR_TO_DOOR_TOO_LONG",
      `Every permitted route exceeds ${MAX_DOOR_TO_DOOR_MINUTES} minutes door-to-door.`,
    );
  }
  return infeasible(
    "UNDETERMINED",
    fingerprint,
    policyVersion,
    "MISSING_GEOGRAPHIC_EVIDENCE",
    "Passenger, connectivity, or geographic evidence is incomplete for every candidate pair.",
  );
}
