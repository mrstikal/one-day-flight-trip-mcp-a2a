import { describe, expect, it } from "vitest";
import {
  buildScenarioKey,
  computeDomainHashes,
  createDomainFaker,
  deriveDomainSeed,
  deriveOfferId,
  extendSnapshotContent,
  generateHotels,
  generateMeals,
} from "@odft/data";
import {
  FAKER_VERSION,
  SCHEMA_VERSION,
  REFERENCE_VERSION,
  GENERATOR_VERSION,
  type GenerationInputs,
} from "@odft/contracts";
import { directCombination, snapshotContext } from "../../fixtures/scenario.js";

/** T-UT-DATA-01: determinism, per-domain seeds, stable IDs, snapshot hashes. */

function generationInputs(overrides: Partial<GenerationInputs> = {}): GenerationInputs {
  return {
    seed: "seed-1",
    originAirportId: "ourairports:4408",
    originIata: "PRG",
    destinationCityId: "geonames:3169070",
    destinationCountryKey: "IT",
    destinationAirportIds: ["ourairports:4372", "ourairports:4370"],
    sightseeingDate: "2026-12-01",
    travelVariant: "two_nights",
    adults: 2,
    generatorVersion: GENERATOR_VERSION,
    referenceVersion: REFERENCE_VERSION,
    routePolicyVersion: "route-policy-v1",
    ...overrides,
  };
}

describe("scenario key", () => {
  it("is deterministic and order-insensitive for airport ids", () => {
    const a = buildScenarioKey(generationInputs());
    const b = buildScenarioKey(generationInputs());
    const reordered = buildScenarioKey(
      generationInputs({ destinationAirportIds: ["ourairports:4370", "ourairports:4372"] }),
    );
    expect(a).toBe(b);
    expect(a).toBe(reordered);
  });

  it("changes when a bound input changes", () => {
    const base = buildScenarioKey(generationInputs());
    expect(buildScenarioKey(generationInputs({ originIata: "BRQ" }))).not.toBe(base);
    expect(buildScenarioKey(generationInputs({ sightseeingDate: "2026-12-02" }))).not.toBe(base);
    expect(buildScenarioKey(generationInputs({ adults: 3 }))).not.toBe(base);
  });
});

describe("per-domain seeds and Faker streams", () => {
  it("derives independent, deterministic domain seeds", () => {
    const hotels = deriveDomainSeed("s", "key", "hotels", "v1");
    expect(hotels).toBe(deriveDomainSeed("s", "key", "hotels", "v1"));
    expect(deriveDomainSeed("s", "key", "flights", "v1")).not.toBe(hotels);
    expect(deriveDomainSeed("s", "key", "hotels", "v2")).not.toBe(hotels);
  });

  it("creates per-domain Faker instances that do not share the global singleton", () => {
    const a1 = createDomainFaker("s", "key", "hotels", "v1");
    const a2 = createDomainFaker("s", "key", "hotels", "v1");
    const b = createDomainFaker("s", "key", "activities", "v1");
    const seqA1 = [a1.number.int({ min: 0, max: 1e9 }), a1.number.int({ min: 0, max: 1e9 })];
    const seqA2 = [a2.number.int({ min: 0, max: 1e9 }), a2.number.int({ min: 0, max: 1e9 })];
    const seqB = [b.number.int({ min: 0, max: 1e9 }), b.number.int({ min: 0, max: 1e9 })];
    expect(seqA1).toEqual(seqA2);
    expect(seqB).not.toEqual(seqA1);
  });
});

describe("stable offer ids", () => {
  it("is deterministic and content-keyed", () => {
    expect(deriveOfferId("key", "flights", 0)).toBe(deriveOfferId("key", "flights", 0));
    expect(deriveOfferId("key", "flights", 0)).not.toBe(deriveOfferId("key", "flights", 1));
    expect(deriveOfferId("key", "hotels", 0)).not.toBe(deriveOfferId("key", "flights", 0));
  });
});

describe("snapshot domain hashes", () => {
  it("are stable and independent per domain and per meal", () => {
    const context = snapshotContext();
    const gen = { scenarioKey: "key", seed: "seed", generatorVersion: GENERATOR_VERSION, context };
    const base = {
      schemaVersion: SCHEMA_VERSION,
      scenarioKey: "key",
      seed: "seed",
      generatorVersion: GENERATOR_VERSION,
      fakerVersion: FAKER_VERSION,
      referenceVersion: REFERENCE_VERSION,
      routeFingerprint: "c".repeat(64),
      generatedAt: "2026-10-10T00:00:00.000Z",
      context,
      flights: [directCombination({ sightseeingDate: context.sightseeingDate })],
      hotels: generateHotels(gen),
      restaurants: [
        ...generateMeals({ ...gen, meal: "breakfast" }),
        ...generateMeals({ ...gen, meal: "lunch" }),
      ],
      activities: [],
      events: [],
    };
    const hashesBefore = computeDomainHashes(base);
    const extended = {
      ...extendSnapshotContent(base, { restaurants: generateMeals({ ...gen, meal: "dinner" }) }),
    };
    const hashesAfter = computeDomainHashes(extended);

    expect(hashesAfter.flights).toBe(hashesBefore.flights);
    expect(hashesAfter.hotels).toBe(hashesBefore.hotels);
    expect(hashesAfter.breakfast).toBe(hashesBefore.breakfast);
    expect(hashesAfter.lunch).toBe(hashesBefore.lunch);
    expect(hashesAfter.dinner).not.toBe(hashesBefore.dinner);

    // Recomputing hashes excludes generatedAt metadata.
    const regenerated = computeDomainHashes({ ...base, generatedAt: "2030-01-01T00:00:00.000Z" });
    expect(regenerated).toEqual(hashesBefore);
  });
});
