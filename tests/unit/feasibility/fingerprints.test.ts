import { describe, expect, it } from "vitest";
import {
  assertApprovalCurrent,
  computeRouteFingerprint,
  generateFlights,
  isApprovalCurrent,
  validateRoute,
} from "@odft/data";
import type { FeasibleRouteApproval } from "@odft/contracts";
import { DomainError } from "@odft/domain";
import { routeInputs } from "../../fixtures/feasibility.js";

/** T-UT-FEAS-02: route fingerprint sensitivity and approval freshness. */

function approvalFor(inputs = routeInputs()): FeasibleRouteApproval {
  const result = validateRoute(inputs);
  if (result.status !== "FEASIBLE") {
    throw new Error("fixture route must be feasible");
  }
  return {
    routeValidationId: "22222222-2222-4222-8222-222222222222",
    status: "FEASIBLE",
    fingerprint: result.fingerprint,
    policyVersion: result.policyVersion,
    approvedAirportPairs: result.approvedAirportPairs,
    approvedPairDetails: result.approvedPairDetails,
    expiresWithInputs: true,
  };
}

describe("route fingerprint", () => {
  it("changes for every bound input", () => {
    const base = routeInputs();
    const baseFp = computeRouteFingerprint(base);
    expect(computeRouteFingerprint(routeInputs({ sightseeingDate: "2026-12-02" }))).not.toBe(
      baseFp,
    );
    expect(computeRouteFingerprint(routeInputs({ travelVariant: "one_night" }))).not.toBe(baseFp);
    expect(computeRouteFingerprint(routeInputs({ adults: 3 }))).not.toBe(baseFp);
    expect(
      computeRouteFingerprint(
        routeInputs({ origin: { ...base.origin, airportId: "fixture:other", iata: "XXX" } }),
      ),
    ).not.toBe(baseFp);
    expect(
      computeRouteFingerprint(
        routeInputs({
          destinationAirports: [{ ...base.destinationAirports[0]!, transferMinutes: 50 }],
        }),
      ),
    ).not.toBe(baseFp);
    expect(
      computeRouteFingerprint(
        routeInputs({ transfer: { ...base.transfer, departureBufferMinutes: 90 } }),
      ),
    ).not.toBe(baseFp);
  });

  it("ignores unrelated evidence (a corridor for another city)", () => {
    const base = routeInputs();
    const withUnrelated = routeInputs({
      groundCorridors: [
        ...base.groundCorridors,
        {
          originRef: "airport:PRG",
          destinationRef: "geonames:999999",
          minutes: 120,
          evidenceRefs: [],
        },
      ],
    });
    expect(computeRouteFingerprint(withUnrelated)).toBe(computeRouteFingerprint(base));
  });
});

describe("approval freshness guard", () => {
  it("accepts a matching approval and rejects a stale one", () => {
    const inputs = routeInputs();
    const approval = approvalFor(inputs);
    expect(isApprovalCurrent(approval, inputs)).toBe(true);
    expect(isApprovalCurrent(approval, routeInputs({ sightseeingDate: "2026-12-02" }))).toBe(false);
    expect(() =>
      assertApprovalCurrent(approval, routeInputs({ sightseeingDate: "2026-12-02" })),
    ).toThrowError(DomainError);
    try {
      assertApprovalCurrent(approval, routeInputs({ sightseeingDate: "2026-12-02" }));
    } catch (error) {
      expect((error as DomainError).code).toBe("STALE_ROUTE_APPROVAL");
    }
  });
});

describe("flight generator", () => {
  const context = {
    scenarioKey: "key",
    seed: "seed",
    sightseeingDate: "2026-12-01",
    travelVariant: "two_nights" as const,
    adults: 2,
    generatorVersion: "generator-v1",
  };

  it("is deterministic and rejects a stale approval or a mismatched context", () => {
    const inputs = routeInputs();
    const approval = approvalFor(inputs);
    const first = generateFlights(approval, context, inputs);
    const second = generateFlights(approval, context, inputs);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThanOrEqual(6);
    expect(first.every((combination) => combination.synthetic && combination.adults === 2)).toBe(
      true,
    );

    // A stale approval (inputs changed) is rejected.
    expect(() =>
      generateFlights(approval, context, routeInputs({ sightseeingDate: "2026-12-02" })),
    ).toThrowError(DomainError);
    // A context that diverges from the current inputs is rejected even when the
    // approval itself is current.
    expect(() => generateFlights(approval, { ...context, adults: 4 }, inputs)).toThrowError(
      DomainError,
    );
    expect(() =>
      generateFlights(approval, { ...context, travelVariant: "one_night" }, inputs),
    ).toThrowError(DomainError);
    expect(() => generateFlights(approval, context, inputs)).not.toThrow();
  });

  it("produces order-independent offers for equal pairs", () => {
    const inputs = routeInputs();
    const approval = approvalFor(inputs);
    const forward = generateFlights(approval, context, inputs);
    const reversed = generateFlights(
      { ...approval, approvedPairDetails: [...approval.approvedPairDetails].reverse() },
      context,
      inputs,
    );
    expect(reversed).toEqual(forward);
  });

  it("varies the price across combinations of one pair inside bounded bands", () => {
    const inputs = routeInputs();
    const approval = approvalFor(inputs);
    const flights = generateFlights(approval, context, inputs);
    for (const pair of approval.approvedPairDetails) {
      const combinations = flights.filter(
        (flight) =>
          flight.outbound.segments[0]?.fromIata === pair.originIata &&
          flight.outbound.segments[flight.outbound.segments.length - 1]?.toIata ===
            pair.destinationIata,
      );
      expect(combinations.length).toBeGreaterThanOrEqual(6);
      const prices = combinations.map((flight) => flight.perAdultMinor);
      expect(new Set(prices).size).toBeGreaterThan(1);
      for (const flight of combinations) {
        // Per direction: clamped base (45..420 EUR) + 25 EUR per connection.
        const connectionFee = flight.outbound.segments.length > 1 ? 2_500 : 0;
        const inboundFee = flight.inbound.segments.length > 1 ? 2_500 : 0;
        expect(flight.perAdultMinor).toBeGreaterThanOrEqual(4_500 * 2 + connectionFee + inboundFee);
        expect(flight.perAdultMinor).toBeLessThanOrEqual(42_000 * 2 + connectionFee + inboundFee);
        expect(flight.partyTotalMinor).toBe(flight.perAdultMinor * flight.adults);
      }
    }
  });
});
