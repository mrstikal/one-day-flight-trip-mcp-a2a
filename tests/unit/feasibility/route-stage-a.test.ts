import { describe, expect, it } from "vitest";
import { validateRoute } from "@odft/data";
import {
  bcnToPmiRoute,
  ceskeBudejoviceRoute,
  routeInputs,
  sameCatchmentCrossBorderRoute,
} from "../../fixtures/feasibility.js";

/** T-UT-FEAS-01: Stage A ordered rule table and reason codes. */

function reasonCodes(result: ReturnType<typeof validateRoute>): string[] {
  return result.status === "FEASIBLE" ? [] : result.reasons.map((reason) => reason.code);
}

describe("Stage A route policy", () => {
  it("approves the curated PRG -> Rome route", () => {
    const result = validateRoute(routeInputs());
    expect(result.status).toBe("FEASIBLE");
    if (result.status === "FEASIBLE") {
      expect(result.approvedAirportPairs).toContainEqual(["PRG", "FCO"]);
      expect(result.approvedAirportPairs).toContainEqual(["PRG", "CIA"]);
      expect(result.expiresWithInputs).toBe(true);
      expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("rejects PRG -> Ceske Budejovice as GROUND_TRAVEL_PREFERRED (with and without a candidate airport)", () => {
    expect(reasonCodes(validateRoute(ceskeBudejoviceRoute()))).toContain("GROUND_TRAVEL_PREFERRED");
    expect(reasonCodes(validateRoute(ceskeBudejoviceRoute({ destinationAirports: [] })))).toContain(
      "GROUND_TRAVEL_PREFERRED",
    );
  });

  it("admits BCN -> PMI through the explicit island exception, never on distance alone", () => {
    const result = validateRoute(bcnToPmiRoute());
    expect(result.status).toBe("FEASIBLE");
    if (result.status === "FEASIBLE") {
      expect(result.warnings.map((warning) => warning.code)).toContain("SHORT_ROUTE_UNJUSTIFIED");
    }
  });

  it("returns UNDETERMINED for a short route without a reviewed exception", () => {
    const result = validateRoute(ceskeBudejoviceRoute({ groundCorridors: [] }));
    expect(result.status).toBe("UNDETERMINED");
    expect(reasonCodes(result)).toContain("SHORT_ROUTE_UNJUSTIFIED");
  });

  it("rejects same-catchment across borders and same-airport routes", () => {
    const crossBorder = validateRoute(sameCatchmentCrossBorderRoute());
    expect(crossBorder.status).toBe("INFEASIBLE");
    expect(reasonCodes(crossBorder)).toContain("SAME_CATCHMENT");

    const sameAirport = validateRoute(
      routeInputs({
        destinationAirports: [
          {
            ...routeInputs().destinationAirports[0]!,
            airportId: routeInputs().origin.airportId,
            iata: "PRG",
            metroCatchmentId: "prague",
          },
        ],
      }),
    );
    expect(reasonCodes(sameAirport)).toContain("SAME_AIRPORT");
  });

  it("returns UNDETERMINED for unknown references and unresolved timezones", () => {
    expect(reasonCodes(validateRoute(routeInputs({ originKnown: false })))).toContain(
      "NO_REFERENCE_AIRPORT",
    );
    expect(reasonCodes(validateRoute(routeInputs({ destinationKnown: false })))).toContain(
      "MISSING_GEOGRAPHIC_EVIDENCE",
    );
    expect(
      reasonCodes(
        validateRoute(
          routeInputs({
            destination: { ...routeInputs().destination, zoneResolved: false, zone: null },
          }),
        ),
      ),
    ).toContain("UNKNOWN_TIMEZONE");
  });

  it("rejects when every candidate transfer exceeds the bound", () => {
    const inputs = routeInputs();
    const shifted = inputs.destinationAirports.map((airport) => ({
      ...airport,
      transferMinutes: 200,
    }));
    expect(reasonCodes(validateRoute(routeInputs({ destinationAirports: shifted })))).toContain(
      "TRANSFER_TOO_LONG",
    );
  });

  it("returns UNDETERMINED when no defensible destination airport remains", () => {
    expect(reasonCodes(validateRoute(routeInputs({ destinationAirports: [] })))).toContain(
      "NO_REFERENCE_AIRPORT",
    );
  });

  it("rejects implausibly long door-to-door routes", () => {
    const airport = {
      ...routeInputs().destinationAirports[0]!,
      airportId: "fixture:longhaul",
      iata: "LHA",
      lat: 1,
      lon: 1,
      transferMinutes: 45,
    };
    const result = validateRoute(routeInputs({ destinationAirports: [airport] }));
    expect(result.status).toBe("INFEASIBLE");
    expect(reasonCodes(result)).toContain("DOOR_TO_DOOR_TOO_LONG");
  });

  it("returns INFEASIBLE NO_PLAUSIBLE_ROUTE when no hub can connect a long pair", () => {
    const airport = {
      ...routeInputs().destinationAirports[0]!,
      airportId: "fixture:longhaul",
      iata: "LHA",
      lat: 1,
      lon: 1,
    };
    const result = validateRoute(routeInputs({ destinationAirports: [airport], hubAirports: [] }));
    expect(result.status).toBe("INFEASIBLE");
    expect(reasonCodes(result)).toContain("NO_PLAUSIBLE_ROUTE");
  });

  it("does not authorize a connection with an unjustified short sub-leg", () => {
    const base = routeInputs();
    const farAirport = {
      ...base.destinationAirports[0]!,
      airportId: "fixture:far",
      iata: "LHA",
      lat: 1,
      lon: 1,
      eligibleDestination: true,
      largeAirport: true,
    };
    const result = validateRoute(
      routeInputs({
        origin: {
          ...base.origin,
          airportId: "ourairports:4409",
          iata: "BRQ",
          lat: 49.151276,
          lon: 16.693972,
          metroCatchmentId: "brno",
          largeAirport: false,
        },
        destinationAirports: [farAirport],
        hubAirports: [{ iata: "VIE", lat: 48.110298, lon: 16.5697, zone: "Europe/Vienna" }],
      }),
    );
    // BRQ -> VIE is ~116 km (< 350 km) with no exception: never a valid connection.
    expect(result.status).toBe("UNDETERMINED");
    expect(reasonCodes(result)).toContain("SHORT_ROUTE_UNJUSTIFIED");
  });
});
