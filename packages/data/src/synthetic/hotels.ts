import { Temporal } from "@js-temporal/polyfill";
import type { HotelOffer, ServiceLevel, SnapshotContext } from "@odft/contracts";
import { checkInDate, nightsForVariant } from "@odft/domain";
import { safeAnchor, type LandmarkAnchor } from "./anchors.js";
import { deriveEntityId } from "./ids.js";
import { hotelBaseMinor, hotelPartyTotalMinor, seasonFactor } from "./pricing.js";
import { createDomainFaker } from "./seed.js";

/**
 * Deterministic hotel generator (05 sections 7-9). Safe anchors stay inside the
 * reviewed city envelope; Faker supplies fictional names and bounded variation
 * only. Positions are approximate demo pins, never claimed street addresses.
 */

export interface HotelGenInput {
  readonly scenarioKey: string;
  readonly seed: string;
  readonly generatorVersion: string;
  readonly context: SnapshotContext;
  readonly landmarks?: readonly LandmarkAnchor[];
}

const LEVELS: readonly ServiceLevel[] = ["budget", "standard", "luxury"];
const PER_LEVEL = 6;
const HOTEL_BRANDS = [
  "Grand",
  "Central",
  "Riverside",
  "Old Town",
  "Panorama",
  "Garden",
  "Metro",
  "Harbor",
];

function nightDates(context: SnapshotContext): string[] {
  const checkIn = checkInDate(context.sightseeingDate);
  const nights = nightsForVariant(context.travelVariant);
  const dates: string[] = [];
  for (let index = 0; index < nights; index += 1) {
    dates.push(Temporal.PlainDate.from(checkIn).add({ days: index }).toString());
  }
  return dates;
}

function ratingFor(level: ServiceLevel, fraction: number): number {
  const bands: Record<ServiceLevel, { min: number; max: number }> = {
    budget: { min: 3.2, max: 4.2 },
    standard: { min: 3.8, max: 4.7 },
    luxury: { min: 4.5, max: 4.9 },
  };
  const band = bands[level];
  return Math.round((band.min + (band.max - band.min) * fraction) * 10) / 10;
}

export function generateHotels(input: HotelGenInput): HotelOffer[] {
  const { context } = input;
  const faker = createDomainFaker(input.seed, input.scenarioKey, "hotels", input.generatorVersion);
  const dates = nightDates(context);
  const nights = nightsForVariant(context.travelVariant);
  const rooms = Math.ceil(context.adults / 2);
  const offers: HotelOffer[] = [];
  let index = 0;
  for (const level of LEVELS) {
    for (let slot = 0; slot < PER_LEVEL; slot += 1) {
      const seedFraction = faker.number.float({ min: 0, max: 1 });
      const base = hotelBaseMinor(level, seedFraction);
      const anchor = safeAnchor(faker, context, input.landmarks ?? [], index);
      const brand = HOTEL_BRANDS[
        Math.floor(seedFraction * HOTEL_BRANDS.length) % HOTEL_BRANDS.length
      ] as string;
      const name = `${brand} ${context.cityName} ${faker.animal.type()} Hotel`;
      const partyTotalMinor = hotelPartyTotalMinor(base, context.cityFactor, dates, rooms, (date) =>
        seasonFactor(Temporal.PlainDate.from(date).month),
      );
      offers.push({
        id: deriveEntityId(input.scenarioKey, "hotels", index, `${level}:${slot}`),
        level,
        name: `Demo ${name}`,
        date: dates[0] as string,
        nights,
        adults: context.adults,
        rooms,
        perNightMinor: Math.max(1, Math.round(partyTotalMinor / (nights * rooms))),
        partyTotalMinor,
        rating: ratingFor(level, seedFraction),
        anchor: {
          lat: Math.round(anchor.lat * 1e6) / 1e6,
          lon: Math.round(anchor.lon * 1e6) / 1e6,
          precisionMeters: 500,
        },
        centerDistanceKm: Math.round(anchor.centerDistanceKm * 100) / 100,
        luggageStorage: level !== "budget" || slot % 2 === 0,
        checkInWindow: "15:00-22:00 (simulated)",
        checkOutWindow: "07:00-11:00 (simulated)",
        synthetic: true,
        demoLabels: ["Demo offer", "Simulated schedule/price", "Approximate location"],
      });
      index += 1;
    }
  }
  return offers;
}
