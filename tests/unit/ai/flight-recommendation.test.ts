import { describe, expect, it } from "vitest";
import {
  FixtureAdapter,
  flightRecommendationContextSchema,
  flightRecommendationRole,
  fixtureFlightRecommendation,
  recommendationOutputSchema,
} from "@odft/ai";
import { flightRecommendationsSchema } from "@odft/contracts";

/**
 * Phase 05 flight recommendation contract: the v2 role/context, deterministic
 * fixture ranking and the permutation/subset rule the governed runtime enforces.
 */

const candidates = [
  {
    id: "combo-b",
    partyTotalMinor: 42_000,
    perAdultMinor: 42_000,
    totalDurationMinutes: 300,
    stops: 0,
    outboundDeparture: "2026-12-01T06:00:00Z",
    outboundArrival: "2026-12-01T08:00:00Z",
    inboundDeparture: "2026-12-02T18:00:00Z",
    inboundArrival: "2026-12-02T20:00:00Z",
    supportedVariants: ["one_night" as const],
  },
  {
    id: "combo-a",
    partyTotalMinor: 39_000,
    perAdultMinor: 39_000,
    totalDurationMinutes: 360,
    stops: 1,
    outboundDeparture: "2026-12-01T05:00:00Z",
    outboundArrival: "2026-12-01T09:00:00Z",
    inboundDeparture: "2026-12-02T17:00:00Z",
    inboundArrival: "2026-12-02T21:00:00Z",
    supportedVariants: ["one_night" as const, "two_nights" as const],
  },
];

describe("flight recommendation role (v2)", () => {
  it("uses the v2 prompt with the flight context schema", () => {
    expect(flightRecommendationRole.promptVersion).toBe("recommendation-v2");
    expect(flightRecommendationRole.contextSchema).toBe(flightRecommendationContextSchema);
    expect(flightRecommendationRole.outputSchema).toBe(recommendationOutputSchema);
  });

  it("parses the flight context with schedule and price facts", () => {
    const context = flightRecommendationContextSchema.parse({
      role: "recommendation",
      tradeoff: "best price",
      target: "flights",
      baselineOfferId: null,
      candidates,
    });
    expect(context.candidates).toHaveLength(2);
  });

  it("ranks deterministically by price, then duration, then id", () => {
    const context = flightRecommendationContextSchema.parse({
      role: "recommendation",
      tradeoff: "best price",
      target: "flights",
      baselineOfferId: null,
      candidates,
    });
    const ranked = fixtureFlightRecommendation(context);
    expect(ranked.rankedOfferIds).toEqual(["combo-a", "combo-b"]);
    expect(ranked.reasons[0]?.offerId).toBe("combo-a");
    // The output is a permutation of the supplied ids.
    expect([...ranked.rankedOfferIds].sort()).toEqual(["combo-a", "combo-b"]);
  });

  it("serves the flight context through the fixture adapter", async () => {
    const adapter = new FixtureAdapter();
    const response = await adapter.generateObject({
      role: "recommendation",
      promptVersion: "recommendation-v2",
      operationId: "task-1",
      effectScope: "recommendation:1",
      systemPrompt: flightRecommendationRole.systemPrompt,
      context: {
        role: "recommendation",
        tradeoff: "best price",
        target: "flights",
        baselineOfferId: null,
        candidates,
      },
      outputSchema: recommendationOutputSchema,
      signal: new AbortController().signal,
    });
    expect(response.mode).toBe("fixture");
    expect(recommendationOutputSchema.parse(response.value).rankedOfferIds).toEqual([
      "combo-a",
      "combo-b",
    ]);
  });

  it("keeps the v1 artifact contract compatible with the flight envelope", () => {
    const artifact = flightRecommendationsSchema.parse({
      correlation: {
        schemaVersion: 1,
        skillId: "flight.recommend.v1",
        tripId: "11111111-1111-4111-8111-111111111111",
        operationId: "22222222-2222-4222-8222-222222222222",
        acceptedRevision: 1,
        delegationId: "33333333-3333-4333-8333-333333333333",
        traceId: "trace-1",
        snapshotId: "44444444-4444-4444-8444-444444444444",
        scenarioKey: "scenario-1",
        inputFingerprint: "a".repeat(64),
        domainFingerprints: { flights: "b".repeat(64) },
      },
      rankedCombinationIds: ["combo-a"],
      findings: [],
      priceFacts: [{ combinationId: "combo-a", partyTotalMinor: 39_000, currency: "EUR" }],
      explanations: ["cheapest"],
      reorderNote: null,
    });
    expect(artifact.correlation.domainFingerprints.flights).toHaveLength(64);
  });
});
