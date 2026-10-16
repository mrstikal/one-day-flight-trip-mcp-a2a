import type { RouteAlternative, RouteReason, ScheduleReason } from "@odft/contracts";

/**
 * Human copy for server-computed reason codes. The client only translates codes
 * to text; it never decides feasibility or severity.
 */

const ROUTE_REASON_COPY: Readonly<Record<RouteReason, string>> = {
  SAME_AIRPORT: "Origin and destination are the same airport.",
  SAME_CATCHMENT: "Origin and destination are in the same metro area.",
  GROUND_TRAVEL_PREFERRED: "Ground travel is preferred for this short route.",
  NO_REFERENCE_AIRPORT: "The destination has no reviewed destination airport.",
  TRANSFER_TOO_LONG: "The airport transfer to the city is too long.",
  UNKNOWN_TIMEZONE: "An airport time zone could not be resolved.",
  NO_PLAUSIBLE_ROUTE: "No plausible flight route was found for this date.",
  SHORT_ROUTE_UNJUSTIFIED: "The flight does not save enough time over ground travel.",
  MISSING_GEOGRAPHIC_EVIDENCE: "Required geographic evidence is missing.",
  DOOR_TO_DOOR_TOO_LONG: "The door-to-door travel time is too long.",
};

const ALTERNATIVE_COPY: Readonly<Record<RouteAlternative, string>> = {
  change_origin: "Choose a different origin airport",
  change_destination: "Choose a different destination",
  choose_ground_travel_elsewhere: "Plan ground travel instead",
};

const SCHEDULE_REASON_COPY: Readonly<Record<ScheduleReason, string>> = {
  OUTBOUND_DATE: "No outbound flight lands on the required day.",
  ARRIVAL_TOO_LATE: "The outbound flight arrives too late.",
  RETURN_DATE: "No return flight departs on the required day.",
  RETURN_TOO_EARLY: "The return flight departs too early.",
  CONNECTION_TOO_SHORT: "A connection is too short.",
  CONNECTION_TOO_LONG: "A connection is too long.",
  INVALID_DURATION: "A flight duration is not plausible.",
  INVALID_TIMEZONE: "A flight time zone could not be resolved.",
  INVALID_CONNECTION: "A connection is not valid.",
  PRICE_MISMATCH: "A simulated price is inconsistent.",
  TRANSFER_BUFFER: "The airport transfer leaves too little time.",
  INSUFFICIENT_SIGHTSEEING: "The schedule leaves too little sightseeing time.",
  STALE_ROUTE_APPROVAL: "The route approval is stale and must be revalidated.",
  NO_MATCHING_SCHEDULE: "No schedule matches the requested dates.",
  DOOR_TO_DOOR_TOO_LONG: "The door-to-door travel time is too long.",
};

export function routeReasonText(reason: RouteReason): string {
  return ROUTE_REASON_COPY[reason];
}

export function routeAlternativeText(alternative: RouteAlternative): string {
  return ALTERNATIVE_COPY[alternative];
}

export function scheduleReasonText(reason: ScheduleReason): string {
  return SCHEDULE_REASON_COPY[reason];
}
