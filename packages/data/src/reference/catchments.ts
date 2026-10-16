/**
 * Deterministic destination-airport resolution and catchment math.
 *
 * Rules (Phase 02): 150 km great-circle radius, at most three suitable
 * airports, simulated city transfer <= 120 minutes, reviewed metro catchments
 * preferred. These are approximations, never real road routing.
 */

export const DESTINATION_RADIUS_KM = 150;
export const MAX_DESTINATION_AIRPORTS = 3;
export const MAX_TRANSFER_MINUTES = 120;

export interface LatLon {
  readonly lat: number;
  readonly lon: number;
}

const EARTH_RADIUS_KM = 6371.0088;

/** Great-circle (haversine) distance in kilometres. */
export function haversineKm(a: LatLon, b: LatLon): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Conservative simulated airport-transfer estimate (45 km/h + 20 min access). */
export function estimateTransferMinutes(distanceKm: number): number {
  return Math.ceil((distanceKm / 45) * 60) + 20;
}

export type TransferMode = "public_transport" | "taxi";

export interface CatchmentCity extends LatLon {
  readonly id: string;
}

export interface CatchmentAirport extends LatLon {
  readonly id: string;
  readonly zone: string;
  /** Raw OurAirports scheduled-service flag; used to keep fallback airports "suitable". */
  readonly scheduledService: boolean;
}

export interface ReviewedAirportLink {
  readonly airportId: string;
  readonly metroCatchmentId: string;
  readonly transferMinutes: number;
  readonly transferMode: TransferMode;
  readonly eligibleDestination: boolean;
  readonly evidenceRefs: readonly string[];
}

export interface DerivedCityAirportLink {
  readonly cityId: string;
  readonly airportId: string;
  readonly metroCatchmentId: string;
  readonly transferMinutes: number;
  readonly transferMode: TransferMode;
  readonly eligibleDestination: boolean;
  readonly reviewed: boolean;
  readonly evidenceRefs: string[];
  readonly distanceKm: number;
}

export interface CityAirportResolution {
  readonly links: DerivedCityAirportLink[];
  readonly limitation?: string;
}

function hasUsableZone(zone: string): boolean {
  return zone.length > 0 && !zone.startsWith("Etc/");
}

/**
 * Resolve the destination airports for a city. Reviewed links are preferred and
 * keep their reviewed catchment/transfer metadata; remaining capacity is filled
 * by the nearest otherwise-suitable airports.
 */
export function resolveCityAirports(
  city: CatchmentCity,
  airports: readonly CatchmentAirport[],
  reviewed: readonly ReviewedAirportLink[] = [],
): CityAirportResolution {
  const byId = new Map(airports.map((airport) => [airport.id, airport]));
  const selected: DerivedCityAirportLink[] = [];
  const used = new Set<string>();

  const pushReviewed = (link: ReviewedAirportLink): void => {
    const airport = byId.get(link.airportId);
    if (!airport || used.has(airport.id) || !hasUsableZone(airport.zone)) {
      return;
    }
    const distanceKm = haversineKm(city, airport);
    if (distanceKm > DESTINATION_RADIUS_KM || link.transferMinutes > MAX_TRANSFER_MINUTES) {
      return;
    }
    selected.push({
      cityId: city.id,
      airportId: airport.id,
      metroCatchmentId: link.metroCatchmentId,
      transferMinutes: link.transferMinutes,
      transferMode: link.transferMode,
      eligibleDestination: link.eligibleDestination,
      reviewed: true,
      evidenceRefs: [...link.evidenceRefs],
      distanceKm,
    });
    used.add(airport.id);
  };

  for (const link of reviewed) {
    if (selected.length >= MAX_DESTINATION_AIRPORTS) {
      break;
    }
    pushReviewed(link);
  }

  if (selected.length < MAX_DESTINATION_AIRPORTS) {
    const candidates = airports
      .filter(
        (airport) =>
          !used.has(airport.id) && airport.scheduledService && hasUsableZone(airport.zone),
      )
      .map((airport) => ({ airport, distanceKm: haversineKm(city, airport) }))
      .filter((candidate) => candidate.distanceKm <= DESTINATION_RADIUS_KM)
      .map((candidate) => ({
        ...candidate,
        transferMinutes: estimateTransferMinutes(candidate.distanceKm),
      }))
      .filter((candidate) => candidate.transferMinutes <= MAX_TRANSFER_MINUTES)
      .sort(
        (a, b) =>
          a.distanceKm - b.distanceKm || a.airport.id.localeCompare(b.airport.id),
      );

    for (const candidate of candidates) {
      if (selected.length >= MAX_DESTINATION_AIRPORTS) {
        break;
      }
      selected.push({
        cityId: city.id,
        airportId: candidate.airport.id,
        metroCatchmentId: `airport:${candidate.airport.id}`,
        transferMinutes: candidate.transferMinutes,
        transferMode: "public_transport",
        eligibleDestination: true,
        reviewed: false,
        evidenceRefs: [],
        distanceKm: candidate.distanceKm,
      });
      used.add(candidate.airport.id);
    }
  }

  if (selected.length === 0) {
    return {
      links: [],
      limitation:
        "NO_DEFENSIBLE_AIRPORT: no admitted airport within 150 km with a transfer of at most 120 minutes.",
    };
  }
  return { links: selected };
}

/**
 * Determine whether the given airports belong to a single reviewed metro
 * catchment (e.g. FCO/CIA share Rome, CDG/ORY share Paris).
 */
export function resolveCatchment(
  airportIds: readonly string[],
  links: readonly DerivedCityAirportLink[],
): { metroCatchmentId: string | null; sameCatchment: boolean } {
  if (airportIds.length === 0) {
    return { metroCatchmentId: null, sameCatchment: false };
  }
  const byAirport = new Map(links.map((link) => [link.airportId, link.metroCatchmentId]));
  const ids = new Set<string>();
  for (const airportId of airportIds) {
    const catchment = byAirport.get(airportId);
    if (!catchment) {
      return { metroCatchmentId: null, sameCatchment: false };
    }
    ids.add(catchment);
  }
  // "Same catchment" describes a duplicate-catchment conflict between two or
  // more airports; a single airport reports its catchment but is not a conflict.
  const [only] = [...ids];
  if (ids.size === 1) {
    return { metroCatchmentId: only ?? null, sameCatchment: airportIds.length >= 2 };
  }
  return { metroCatchmentId: null, sameCatchment: false };
}
