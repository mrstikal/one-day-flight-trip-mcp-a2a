import type { Meal, RestaurantOffer, ServiceLevel, SnapshotContext } from "@odft/contracts";
import { safeAnchor, type LandmarkAnchor } from "./anchors.js";
import { deriveEntityId } from "./ids.js";
import { mealBaseMinor, priceMeal } from "./pricing.js";
import { createDomainFaker } from "./seed.js";

/**
 * Deterministic restaurant generator, one independent stream per meal
 * (05 sections 7-8). A dinner extension cannot change breakfast/lunch hashes
 * because each meal is produced from its own stream and hash.
 */

export interface MealGenInput {
  readonly scenarioKey: string;
  readonly seed: string;
  readonly generatorVersion: string;
  readonly context: SnapshotContext;
  readonly meal: Meal;
  readonly landmarks?: readonly LandmarkAnchor[];
}

const LEVELS: readonly ServiceLevel[] = ["budget", "standard", "luxury"];
const PER_LEVEL = 4;

const CUISINES = [
  "Trattoria",
  "Bistro",
  "Brasserie",
  "Osteria",
  "Taverna",
  "Cantina",
  "Kitchen",
  "Grill",
  "Garden",
  "Table",
  "Eatery",
  "Diner",
  "Cellar",
  "Terrace",
  "Parlour",
  "Lodge",
  "Pantry",
  "Bodega",
  "Rotisserie",
  "Smokehouse",
  "Steakhouse",
];

const WINDOWS: Record<Meal, { start: string; end: string }> = {
  breakfast: { start: "07:30", end: "10:30" },
  lunch: { start: "12:00", end: "14:30" },
  dinner: { start: "19:00", end: "22:00" },
};

function durationFor(meal: Meal, level: ServiceLevel): number {
  if (meal === "breakfast") {
    return level === "luxury" ? 60 : 40;
  }
  if (meal === "lunch") {
    return level === "luxury" ? 90 : 65;
  }
  return level === "luxury" ? 120 : 95;
}

export function generateMeals(input: MealGenInput): RestaurantOffer[] {
  const { context, meal } = input;
  const faker = createDomainFaker(input.seed, input.scenarioKey, meal, input.generatorVersion);
  const offers: RestaurantOffer[] = [];
  let index = 0;
  for (const level of LEVELS) {
    for (let slot = 0; slot < PER_LEVEL; slot += 1) {
      const seedFraction = faker.number.float({ min: 0, max: 1 });
      const cuisineFactor = faker.number.float({ min: 0.9, max: 1.15 });
      const base = mealBaseMinor(meal, level, seedFraction);
      const perAdultMinor = priceMeal(meal, level, context.cityFactor, cuisineFactor, base);
      const cuisines = CUISINES[
        Math.floor(seedFraction * CUISINES.length) % CUISINES.length
      ] as string;
      const anchor = safeAnchor(faker, context, input.landmarks ?? [], index);
      const window = WINDOWS[meal];
      offers.push({
        id: deriveEntityId(input.scenarioKey, meal, index, `${level}:${slot}`),
        meal,
        level,
        name: `Demo ${cuisines} ${faker.word.adjective()}`,
        cuisine: "Demo cuisine",
        perAdultMinor,
        partyTotalMinor: perAdultMinor * context.adults,
        durationMinutes: durationFor(meal, level),
        windowStart: `${window.start} (simulated)`,
        windowEnd: `${window.end} (simulated)`,
        anchor: {
          lat: anchor.lat,
          lon: anchor.lon,
          precisionMeters: 500,
        },
        centerDistanceKm: anchor.centerDistanceKm,
        synthetic: true,
        demoLabels: ["Demo offer", "Simulated schedule/price", "Approximate location"],
      });
      index += 1;
    }
  }
  return offers;
}
