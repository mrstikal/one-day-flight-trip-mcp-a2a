import type { Meal, ServiceLevel } from "@odft/contracts";

/**
 * Deterministic simulated pricing in EUR minor units (05 section 8). Domain
 * algorithms own prices; Faker only supplies bounded variation, and every
 * calculated offer is rounded once at the documented boundary.
 */

export interface FlightPriceFactors {
  readonly seasonFactor: number;
  readonly tierFactor: number;
  /** Bounded per-direction demand factor (0.75..1.35). Defaults to 1. */
  readonly demandFactor?: number;
}

const FLIGHT_BASE_MINOR = 4_500;
const FLIGHT_BASE_MAX_MINOR = 42_000;
const FLIGHT_CONNECTION_MINOR = 2_500;
const FLIGHT_DEMAND_MIN = 0.75;
const FLIGHT_DEMAND_MAX = 1.35;

const HOTEL_BAND_MINOR: Record<ServiceLevel, { min: number; max: number }> = {
  budget: { min: 6_000, max: 9_500 },
  standard: { min: 11_000, max: 18_000 },
  luxury: { min: 25_000, max: 42_000 },
};

const MEAL_BAND_MINOR: Record<Meal, Record<ServiceLevel, { min: number; max: number }>> = {
  breakfast: {
    budget: { min: 600, max: 1_000 },
    standard: { min: 1_200, max: 1_800 },
    luxury: { min: 2_500, max: 4_000 },
  },
  lunch: {
    budget: { min: 1_200, max: 1_800 },
    standard: { min: 2_200, max: 3_500 },
    luxury: { min: 4_500, max: 7_500 },
  },
  dinner: {
    budget: { min: 1_600, max: 2_400 },
    standard: { min: 3_000, max: 4_800 },
    luxury: { min: 7_000, max: 12_000 },
  },
};

/** Season factor by destination-local month (1..12). */
export function seasonFactor(month: number): number {
  if (month >= 6 && month <= 8) {
    return 1.2;
  }
  if (month >= 9 && month <= 10) {
    return 1.1;
  }
  return 1.0;
}

export function clampMinor(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Per-adult, one-way flight price. `base = 25 + 0.085 * km` times
 * season/tier/demand factors, clamped to 45..420 EUR, plus 25 EUR per
 * connection.
 */
export function priceFlightPerAdult(
  distanceKm: number,
  factors: FlightPriceFactors,
  connections: number,
): number {
  const demand = Math.min(
    FLIGHT_DEMAND_MAX,
    Math.max(FLIGHT_DEMAND_MIN, factors.demandFactor ?? 1),
  );
  const baseMinor =
    (25 + 0.085 * distanceKm) * 100 * factors.seasonFactor * factors.tierFactor * demand;
  return (
    clampMinor(baseMinor, FLIGHT_BASE_MINOR, FLIGHT_BASE_MAX_MINOR) +
    connections * FLIGHT_CONNECTION_MINOR
  );
}

/**
 * Bounded per-direction demand factor from a seeded fraction (0..1), 0.85..1.20.
 * Deterministic variation so the combinations of one pair never share one price.
 */
export function flightDemandFactor(seedFraction: number): number {
  const fraction = Math.min(1, Math.max(0, seedFraction));
  return Math.round((0.85 + 0.35 * fraction) * 100) / 100;
}

/**
 * Departure-bank demand factor by the direction's own local departure hour
 * (0..23): morning/evening peaks cost more, late-night/early departures less.
 */
export function flightScheduleDemandFactor(localDepartureHour: number): number {
  if (localDepartureHour >= 7 && localDepartureHour <= 9) {
    return 1.1;
  }
  if (localDepartureHour >= 17 && localDepartureHour <= 20) {
    return 1.1;
  }
  if (localDepartureHour >= 21 || localDepartureHour <= 5) {
    return 0.9;
  }
  return 1.0;
}

/** Seed a hotel base night price inside the level's documented band. */
export function hotelBaseMinor(level: ServiceLevel, seedFraction: number): number {
  const band = HOTEL_BAND_MINOR[level];
  const fraction = Math.min(1, Math.max(0, seedFraction));
  return Math.round(band.min + (band.max - band.min) * fraction);
}

export function hotelBand(level: ServiceLevel): { min: number; max: number } {
  return HOTEL_BAND_MINOR[level];
}

/**
 * Apply city/season/weekend factors to a seeded base. `weekend` is the
 * Friday/Saturday room-night factor (1.12). Round once at the offer boundary.
 */
export function priceHotelPerNight(
  level: ServiceLevel,
  cityFactor: number,
  weekend: boolean,
  season: number,
  seededBaseMinor = Math.round((HOTEL_BAND_MINOR[level].min + HOTEL_BAND_MINOR[level].max) / 2),
): number {
  const base = clampMinor(
    seededBaseMinor,
    HOTEL_BAND_MINOR[level].min,
    HOTEL_BAND_MINOR[level].max,
  );
  const weekendFactor = weekend ? 1.12 : 1.0;
  return Math.round(base * cityFactor * season * weekendFactor);
}

/** Total room cost across nights/dates: per-date factors are applied before summing. */
export function hotelPartyTotalMinor(
  seededBaseMinor: number,
  cityFactor: number,
  dates: readonly string[],
  rooms: number,
  season: (date: string) => number,
): number {
  let perRoomTotal = 0;
  for (const date of dates) {
    const weekend = isWeekendRoomNight(date);
    perRoomTotal += seededBaseMinor * cityFactor * season(date) * (weekend ? 1.12 : 1.0);
  }
  return Math.round(perRoomTotal * rooms);
}

function isWeekendRoomNight(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 5 || day === 6;
}

/** Seed a restaurant base per-adult price inside the meal/level band. */
export function mealBaseMinor(meal: Meal, level: ServiceLevel, seedFraction: number): number {
  const band = MEAL_BAND_MINOR[meal][level];
  const fraction = Math.min(1, Math.max(0, seedFraction));
  return Math.round(band.min + (band.max - band.min) * fraction);
}

export function mealBand(meal: Meal, level: ServiceLevel): { min: number; max: number } {
  return MEAL_BAND_MINOR[meal][level];
}

/** Restaurant per-adult price with a documented cuisine factor 0.90..1.15. */
export function priceMeal(
  meal: Meal,
  level: ServiceLevel,
  cityFactor: number,
  cuisineFactor: number,
  seededBaseMinor = Math.round(
    (MEAL_BAND_MINOR[meal][level].min + MEAL_BAND_MINOR[meal][level].max) / 2,
  ),
): number {
  const band = MEAL_BAND_MINOR[meal][level];
  const base = clampMinor(seededBaseMinor, band.min, band.max);
  const cuisine = Math.min(1.15, Math.max(0.9, cuisineFactor));
  return Math.round(base * cityFactor * cuisine);
}

export function clampCuisineFactor(value: number): number {
  return Math.min(1.15, Math.max(0.9, value));
}

/** Defaults city factors (05 section 8). Unknown class uses a labelled 1.00. */
export function cityFactorOrDefault(cityName: string, known?: number): number {
  if (known !== undefined) {
    return known;
  }
  const defaults: Record<string, number> = { Rome: 1.0, Paris: 1.3, Barcelona: 1.1 };
  return defaults[cityName] ?? 1.0;
}
