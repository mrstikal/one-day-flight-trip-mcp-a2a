import { describe, expect, it } from "vitest";
import { generateFlights, validateRoute, validateSchedules } from "@odft/data";
import type {
  FeasibleRouteApproval,
  FlightCombination,
  ScheduleValidationInput,
} from "@odft/contracts";
import { directCombination, flightApproval } from "../../fixtures/scenario.js";
import { routeInputs } from "../../fixtures/feasibility.js";

/** T-UT-FEAS-03: Stage B schedule rules, no fabricated repairs. */

const SIGHTSEEING_DATE = "2026-12-01";

function scheduleInput(
  combinations: FlightCombination[],
  approval: FeasibleRouteApproval = flightApproval(),
  overrides: Partial<ScheduleValidationInput> = {},
): ScheduleValidationInput {
  return {
    approval,
    combinations,
    scenarioKey: "key",
    flightDomainVersion: 1,
    flightDomainHash: "b".repeat(64),
    scheduleRuleVersion: "schedule-rule-v1",
    sightseeingDate: SIGHTSEEING_DATE,
    travelVariant: "two_nights",
    destinationZone: "Europe/Rome",
    destinationTransferMinutes: 45,
    routeValidationId: approval.routeValidationId,
    ...overrides,
  };
}

function codesFor(result: ReturnType<typeof validateSchedules>, combinationId: string): string[] {
  return result.rejected.find((entry) => entry.combinationId === combinationId)?.codes ?? [];
}

function approvalWithHub(): FeasibleRouteApproval {
  return flightApproval({
    approvedPairDetails: [
      {
        ...flightApproval().approvedPairDetails[0]!,
        connectionHub: { iata: "FRA", lat: 50.033333, lon: 8.570556, zone: "Europe/Berlin" },
      },
    ],
  });
}

function connectionCombination(layoverMinutes: number): FlightCombination {
  // Elapsed values match the direct-leg duration formula for the PRG-FRA and
  // FRA-FCO great-circle distances, so only connection codes are exercised.
  const elapsed1 = 62;
  const elapsed2 = 108;
  const seg1Departure = "2026-11-30T13:00:00Z";
  const seg1Arrival = new Date(Date.parse(seg1Departure) + elapsed1 * 60_000)
    .toISOString()
    .replace(".000Z", "Z");
  const seg2Departure = new Date(Date.parse(seg1Arrival) + layoverMinutes * 60_000)
    .toISOString()
    .replace(".000Z", "Z");
  const seg2Arrival = new Date(Date.parse(seg2Departure) + elapsed2 * 60_000)
    .toISOString()
    .replace(".000Z", "Z");
  return {
    id: `demo-connection-${layoverMinutes}`,
    outbound: {
      direction: "outbound",
      segments: [
        {
          fromAirportId: "ourairports:4408",
          toAirportId: "hub:FRA",
          fromIata: "PRG",
          toIata: "FRA",
          departureInstant: seg1Departure,
          arrivalInstant: seg1Arrival,
          departureZone: "Europe/Prague",
          arrivalZone: "Europe/Berlin",
          elapsedMinutes: elapsed1,
          airlineName: "Demo Air",
          airlineCode: "DA",
          flightNumber: "D200A",
        },
        {
          fromAirportId: "hub:FRA",
          toAirportId: "ourairports:4372",
          fromIata: "FRA",
          toIata: "FCO",
          departureInstant: seg2Departure,
          arrivalInstant: seg2Arrival,
          departureZone: "Europe/Berlin",
          arrivalZone: "Europe/Rome",
          elapsedMinutes: elapsed2,
          airlineName: "Demo Air",
          airlineCode: "DA",
          flightNumber: "D200B",
        },
      ],
    },
    inbound: directCombination({ sightseeingDate: SIGHTSEEING_DATE }).inbound,
    adults: 2,
    supportedVariants: ["two_nights"],
    perAdultMinor: 18_000,
    partyTotalMinor: 36_000,
    synthetic: true,
    demoLabels: ["Demo offer", "Simulated schedule/price"],
  };
}

describe("Stage B schedule validation", () => {
  it("accepts a valid direct combination", () => {
    const combination = directCombination({ sightseeingDate: SIGHTSEEING_DATE });
    const result = validateSchedules(scheduleInput([combination]));
    expect(result.status).toBe("VALID");
    expect(result.validCombinationIds).toContain(combination.id);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a too-late outbound arrival", () => {
    const combination = directCombination({
      sightseeingDate: SIGHTSEEING_DATE,
      outboundArrivalLocalMinutes: 21 * 60 + 30,
    });
    const result = validateSchedules(scheduleInput([combination]));
    expect(result.status).toBe("NO_VALID_OFFERS");
    expect(codesFor(result, combination.id)).toContain("ARRIVAL_TOO_LATE");
  });

  it("rejects a too-early return", () => {
    const combination = directCombination({
      sightseeingDate: SIGHTSEEING_DATE,
      returnDepartureLocalMinutes: 19 * 60,
    });
    const result = validateSchedules(scheduleInput([combination]));
    const codes = codesFor(result, combination.id);
    expect(codes).toContain("RETURN_TOO_EARLY");
    expect(codes).toContain("INSUFFICIENT_SIGHTSEEING");
  });

  it("rejects connections that are too short or too long", () => {
    const short = connectionCombination(30);
    const long = connectionCombination(300);
    const result = validateSchedules(scheduleInput([short, long], approvalWithHub()));
    expect(codesFor(result, short.id)).toContain("CONNECTION_TOO_SHORT");
    expect(codesFor(result, long.id)).toContain("CONNECTION_TOO_LONG");
  });

  it("rejects implausible durations and mismatched timezones", () => {
    const combination = directCombination({ sightseeingDate: SIGHTSEEING_DATE });
    const segment = combination.outbound.segments[0]!;
    const wrongDuration: FlightCombination = {
      ...combination,
      id: "demo-wrong-duration",
      outbound: {
        ...combination.outbound,
        segments: [{ ...segment, elapsedMinutes: segment.elapsedMinutes + 40 }],
      },
    };
    const wrongZone: FlightCombination = {
      ...combination,
      id: "demo-wrong-zone",
      outbound: {
        ...combination.outbound,
        segments: [{ ...segment, departureZone: "America/New_York" }],
      },
    };
    const result = validateSchedules(scheduleInput([wrongDuration, wrongZone]));
    expect(codesFor(result, wrongDuration.id)).toContain("INVALID_DURATION");
    expect(codesFor(result, wrongZone.id)).toContain("INVALID_TIMEZONE");
  });

  it("rejects price inconsistencies and broken leg continuity", () => {
    const combination = directCombination({ sightseeingDate: SIGHTSEEING_DATE });
    const wrongPrice: FlightCombination = {
      ...combination,
      id: "demo-wrong-price",
      partyTotalMinor: 1,
    };
    const broken = connectionCombination(90);
    const brokenConnection: FlightCombination = {
      ...broken,
      id: "demo-broken-connection",
      outbound: {
        ...broken.outbound,
        segments: [
          broken.outbound.segments[0]!,
          { ...broken.outbound.segments[1]!, fromIata: "VIE", fromAirportId: "hub:VIE" },
        ],
      },
    };
    const result = validateSchedules(
      scheduleInput([wrongPrice, brokenConnection], approvalWithHub()),
    );
    expect(codesFor(result, wrongPrice.id)).toContain("PRICE_MISMATCH");
    expect(codesFor(result, brokenConnection.id)).toContain("INVALID_CONNECTION");
  });

  it("rejects an inbound leg that does not return to the origin", () => {
    const combination = directCombination({ sightseeingDate: SIGHTSEEING_DATE });
    const inboundSegment = combination.inbound.segments[0]!;
    const wrongReturn: FlightCombination = {
      ...combination,
      id: "demo-wrong-return",
      inbound: {
        ...combination.inbound,
        segments: [
          {
            ...inboundSegment,
            fromAirportId: "ourairports:4408",
            toAirportId: "ourairports:4372",
            fromIata: "PRG",
            toIata: "FCO",
          },
        ],
      },
    };
    const result = validateSchedules(scheduleInput([wrongReturn]));
    expect(result.status).toBe("NO_VALID_OFFERS");
    expect(codesFor(result, wrongReturn.id)).toContain("NO_MATCHING_SCHEDULE");
  });

  it("checks the return leg duration against its distance", () => {
    const combination = directCombination({ sightseeingDate: SIGHTSEEING_DATE });
    const inboundSegment = combination.inbound.segments[0]!;
    const departure = inboundSegment.departureInstant;
    const shortArrival = new Date(Date.parse(departure) + 35 * 60_000)
      .toISOString()
      .replace(".000Z", "Z");
    const shortReturn: FlightCombination = {
      ...combination,
      id: "demo-short-return",
      inbound: {
        ...combination.inbound,
        segments: [{ ...inboundSegment, arrivalInstant: shortArrival, elapsedMinutes: 35 }],
      },
    };
    const result = validateSchedules(scheduleInput([shortReturn]));
    expect(codesFor(result, shortReturn.id)).toContain("INVALID_DURATION");
  });

  it("uses the approved pair's transfer, not a caller-supplied value", () => {
    const combination = directCombination({
      sightseeingDate: SIGHTSEEING_DATE,
      returnDepartureLocalMinutes: 20 * 60 + 10,
    });
    // Caller tries to understate the transfer as 0; the pair's 45 minutes must win.
    const result = validateSchedules(
      scheduleInput([combination], flightApproval(), { destinationTransferMinutes: 0 }),
    );
    expect(codesFor(result, combination.id)).toContain("RETURN_TOO_EARLY");
  });

  it("rejects a combination that does not support the trip variant", () => {
    const combination = directCombination({
      sightseeingDate: SIGHTSEEING_DATE,
      variant: "one_night",
    });
    const result = validateSchedules(
      scheduleInput([{ ...combination, supportedVariants: ["one_night"] }]),
    );
    expect(codesFor(result, combination.id)).toContain("NO_MATCHING_SCHEDULE");
  });

  it("accepts an unambiguous UTC instant whose local time falls in a DST fold", () => {
    const combination = directCombination({
      sightseeingDate: "2026-10-26",
      variant: "one_night",
      outboundArrivalLocalMinutes: 2 * 60 + 30,
    });
    const result = validateSchedules(
      scheduleInput([combination], flightApproval(), {
        sightseeingDate: "2026-10-26",
        travelVariant: "one_night",
      }),
    );
    // 02:30 local on 2026-10-25 is repeated, but the UTC instant is unambiguous.
    expect(codesFor(result, combination.id)).not.toContain("INVALID_TIMEZONE");
    expect(result.validCombinationIds).toContain(combination.id);
  });

  it.each(["2026-07-15", "2026-12-01"])(
    "keeps at least three generated combinations valid in %s (DST-aware local anchors)",
    (sightseeingDate) => {
      const inputs = routeInputs({ sightseeingDate });
      const route = validateRoute(inputs);
      expect(route.status).toBe("FEASIBLE");
      if (route.status !== "FEASIBLE") {
        return;
      }
      const approval: FeasibleRouteApproval = {
        routeValidationId: "33333333-3333-4333-8333-333333333333",
        status: "FEASIBLE",
        fingerprint: route.fingerprint,
        policyVersion: route.policyVersion,
        approvedAirportPairs: route.approvedAirportPairs,
        approvedPairDetails: route.approvedPairDetails,
        expiresWithInputs: true,
      };
      const flights = generateFlights(
        approval,
        {
          scenarioKey: "key",
          seed: "seed",
          sightseeingDate,
          travelVariant: "two_nights",
          adults: 2,
          generatorVersion: "generator-v1",
        },
        inputs,
      );
      const result = validateSchedules(scheduleInput(flights, approval, { sightseeingDate }));
      expect(result.status).toBe("VALID");
      expect(result.validCombinationIds.length).toBeGreaterThanOrEqual(3);
    },
  );
});
