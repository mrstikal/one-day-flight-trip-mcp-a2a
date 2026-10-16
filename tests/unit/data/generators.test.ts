import { describe, expect, it } from "vitest";
import {
  GENERIC_ACTIVITY_CATEGORIES,
  SyntheticAccommodationSearchProvider,
  SyntheticFlightSearchProvider,
  SyntheticRestaurantSearchProvider,
  SyntheticRoutingProvider,
  generateActivities,
  generateEvents,
  generateHotels,
  generateMeals,
  flightDemandFactor,
  flightScheduleDemandFactor,
  hotelBaseMinor,
  priceFlightPerAdult,
  priceMeal,
  withinEnvelope,
} from "@odft/data";
import {
  FAKER_VERSION,
  GENERATOR_VERSION,
  REFERENCE_VERSION,
  SCHEMA_VERSION,
} from "@odft/contracts";
import { directCombination, flightApproval, snapshotContext } from "../../fixtures/scenario.js";

/** T-UT-DATA-02 (pricing separation) and T-UT-DATA-03 (geographic safety). */

const gen = {
  scenarioKey: "key",
  seed: "seed",
  generatorVersion: GENERATOR_VERSION,
  context: snapshotContext(),
};

describe("pricing", () => {
  it("separates Budget < Standard < Luxury for hotels and meals", () => {
    const budget = hotelBaseMinor("budget", 0.5);
    const standard = hotelBaseMinor("standard", 0.5);
    const luxury = hotelBaseMinor("luxury", 0.5);
    expect(budget).toBeLessThan(standard);
    expect(standard).toBeLessThan(luxury);
    expect(priceMeal("dinner", "budget", 1, 1)).toBeLessThan(priceMeal("dinner", "standard", 1, 1));
    expect(priceMeal("dinner", "standard", 1, 1)).toBeLessThan(priceMeal("dinner", "luxury", 1, 1));
  });

  it("prices flights monotonically in distance and adds connections", () => {
    const factors = { seasonFactor: 1, tierFactor: 1 };
    expect(priceFlightPerAdult(500, factors, 0)).toBeLessThan(
      priceFlightPerAdult(1500, factors, 0),
    );
    expect(priceFlightPerAdult(1000, factors, 1)).toBeGreaterThan(
      priceFlightPerAdult(1000, factors, 0),
    );
  });

  it("applies documented season factors without per-offer randomness", () => {
    const factors = { seasonFactor: 1.2, tierFactor: 1 };
    expect(priceFlightPerAdult(800, factors, 0)).toBe(priceFlightPerAdult(800, factors, 0));
  });

  it("bounds the seeded demand factor and prices peak departures higher", () => {
    expect(flightDemandFactor(0)).toBe(0.85);
    expect(flightDemandFactor(1)).toBe(1.2);
    expect(flightDemandFactor(-1)).toBe(0.85);
    expect(flightDemandFactor(2)).toBe(1.2);

    const base = { seasonFactor: 1, tierFactor: 1 };
    const peak = { ...base, demandFactor: flightScheduleDemandFactor(8) };
    const offPeak = { ...base, demandFactor: flightScheduleDemandFactor(22) };
    expect(priceFlightPerAdult(1000, peak, 0)).toBeGreaterThan(
      priceFlightPerAdult(1000, offPeak, 0),
    );
    const cheap = { ...base, demandFactor: 0.85 };
    const dear = { ...base, demandFactor: 1.2 };
    expect(priceFlightPerAdult(1000, cheap, 0)).toBeLessThan(priceFlightPerAdult(1000, dear, 0));
  });
});

describe("generators keep anchors inside the city envelope", () => {
  it("generates hotels within the envelope across all levels", () => {
    const hotels = generateHotels(gen);
    expect(hotels).toHaveLength(18);
    expect(new Set(hotels.map((hotel) => hotel.level))).toEqual(
      new Set(["budget", "standard", "luxury"]),
    );
    for (const hotel of hotels) {
      expect(
        withinEnvelope(hotel.anchor, {
          ...gen.context.center,
          envelopeRadiusKm: gen.context.envelopeRadiusKm,
        }),
      ).toBe(true);
      expect(hotel.synthetic).toBe(true);
      expect(hotel.demoLabels).toContain("Approximate location");
    }
  });

  it("generates independent meals per stream", () => {
    const breakfast = generateMeals({ ...gen, meal: "breakfast" });
    const dinner = generateMeals({ ...gen, meal: "dinner" });
    expect(breakfast.every((offer) => offer.meal === "breakfast")).toBe(true);
    expect(dinner.every((offer) => offer.meal === "dinner")).toBe(true);
    expect(breakfast.map((offer) => offer.id)).not.toEqual(dinner.map((offer) => offer.id));
  });

  it("labels every meal name with exactly one Demo prefix", () => {
    for (const meal of ["breakfast", "lunch", "dinner"] as const) {
      const offers = generateMeals({ ...gen, meal });
      expect(offers).toHaveLength(12);
      for (const offer of offers) {
        expect(offer.name.startsWith("Demo ")).toBe(true);
        expect(offer.name.startsWith("Demo Demo")).toBe(false);
        expect(offer.name.match(/\bDemo\b/g)).toHaveLength(1);
      }
    }
  });

  it("uses curated references for curated cities and generic categories otherwise", () => {
    const curated = generateActivities({
      ...gen,
      landmarks: [
        {
          id: "wikidata:Q1",
          name: "Demo Verified Museum",
          cityId: "geonames:3169070",
          lat: 41.9,
          lon: 12.5,
          sourceId: "Q1",
          sourceUrl: "https://www.wikidata.org/wiki/Q1",
        },
      ],
    });
    expect(curated[0]?.reference).toBe(true);
    expect(curated[0]?.synthetic).toBe(false);
    expect(curated[0]?.sourceId).toBe("Q1");

    const generic = generateActivities({
      ...gen,
      context: { ...gen.context, isCurated: false },
      landmarks: [],
    });
    expect(generic.map((activity) => activity.name)).toEqual([...GENERIC_ACTIVITY_CATEGORIES]);
    expect(generic.every((activity) => activity.synthetic && !activity.reference)).toBe(true);

    const events = generateEvents(gen);
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.synthetic)).toBe(true);
  });
});

describe("simulated routing provider", () => {
  it("is deterministic, labelled simulated, and never a navigation claim", () => {
    const provider = new SyntheticRoutingProvider();
    const input = {
      startRef: "hotel:1",
      endRef: "landmark:1",
      mode: "walking" as const,
      adults: 2,
      start: { lat: 41.9, lon: 12.5 },
      end: { lat: 41.905, lon: 12.51 },
      ruleVersion: "route-policy-v1",
    };
    const first = provider.estimate(input);
    const second = provider.estimate(input);
    expect(first).toEqual(second);
    expect(first.simulated).toBe(true);
    expect(first.estimatedMinutes).toBeGreaterThan(0);
    expect(first.partyTotalMinor).toBe(0);
    expect(first.pathFactor).toBeGreaterThan(1);

    const taxi = provider.estimate({ ...input, mode: "taxi" });
    expect(taxi.partyTotalMinor).toBeGreaterThan(0);
  });

  it("prices taxi from the estimated road distance, not the straight line", () => {
    const provider = new SyntheticRoutingProvider();
    const estimate = provider.estimate({
      startRef: "a",
      endRef: "b",
      mode: "taxi",
      adults: 2,
      start: { lat: 0, lon: 0 },
      end: { lat: 0, lon: 0.089932 }, // ~10 km at the equator
      ruleVersion: "route-policy-v1",
    });
    // Old bug used the 10 km straight line (17 EUR); the road estimate is ~21.2 EUR.
    expect(estimate.partyTotalMinor).toBeGreaterThan(1800);
    expect(estimate.partyTotalMinor).toBeLessThan(2300);
  });
});

describe("provider guards", () => {
  const context = snapshotContext();
  const gen = { scenarioKey: "key", seed: "seed", generatorVersion: GENERATOR_VERSION, context };

  function sourceFor(content: unknown) {
    return { getContent: async () => content as never };
  }

  function snapshotContent(overrides: Record<string, unknown>) {
    return {
      schemaVersion: SCHEMA_VERSION,
      scenarioKey: "key",
      seed: "seed",
      generatorVersion: GENERATOR_VERSION,
      fakerVersion: FAKER_VERSION,
      referenceVersion: REFERENCE_VERSION,
      routeFingerprint: "a".repeat(64),
      generatedAt: "2026-10-10T00:00:00.000Z",
      context,
      flights: [],
      hotels: [],
      restaurants: [],
      activities: [],
      events: [],
      ...overrides,
    };
  }

  it("restaurant provider distinguishes an unmaterialized meal from a party mismatch", async () => {
    const breakfastOnly = snapshotContent({
      restaurants: generateMeals({ ...gen, meal: "breakfast" }),
    });
    const provider = new SyntheticRestaurantSearchProvider(sourceFor(breakfastOnly));
    const dinner = await provider.search({
      snapshotId: "s",
      meal: "dinner",
      level: "standard",
      adults: 2,
    });
    expect(dinner.status).toBe("unsupported");

    const mismatch = await provider.search({
      snapshotId: "s",
      meal: "breakfast",
      level: "standard",
      adults: 6,
    });
    expect(mismatch.status).toBe("unavailable");

    const ok = await provider.search({
      snapshotId: "s",
      meal: "breakfast",
      level: "standard",
      adults: 2,
    });
    expect(ok.status).toBe("ok");
  });

  it("accommodation provider rejects a stay with different dates", async () => {
    const withHotels = snapshotContent({ hotels: generateHotels(gen) });
    const provider = new SyntheticAccommodationSearchProvider(sourceFor(withHotels));
    const matching = await provider.search({
      snapshotId: "s",
      level: "standard",
      adults: 2,
      dates: ["2026-11-30", "2026-12-01"],
    });
    expect(matching.status).toBe("ok");
    const wrongMonth = await provider.search({
      snapshotId: "s",
      level: "standard",
      adults: 2,
      dates: ["2026-06-14", "2026-06-15"],
    });
    expect(wrongMonth.status).toBe("unavailable");
  });

  it("flight provider rejects a snapshot generated for another route approval", async () => {
    const content = snapshotContent({
      routeFingerprint: "b".repeat(64),
      flights: [directCombination({ sightseeingDate: context.sightseeingDate })],
    });
    const provider = new SyntheticFlightSearchProvider(sourceFor(content));
    const result = await provider.search({
      snapshotId: "s",
      approval: flightApproval(),
      travelVariant: "two_nights",
      adults: 2,
    });
    expect(result.status).toBe("unavailable");
  });
});
