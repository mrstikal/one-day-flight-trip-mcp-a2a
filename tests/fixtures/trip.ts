import { randomUUID } from "node:crypto";
import type { CreationInput } from "@odft/contracts";

/**
 * Fixture trip input referencing real admitted reference IDs (Phase 02). Not
 * generated engine output; sightseeing dates use a fixed future date so tests
 * are deterministic.
 */
export const FIXTURE_ORIGIN_AIRPORT = "ourairports:4408"; // PRG
export const FIXTURE_DESTINATION_CITY = "geonames:3169070"; // Rome
export const FIXTURE_DESTINATION_COUNTRY = "IT";
export const FIXTURE_SIGHTSEEING_DATE = "2026-12-01";

export function fixtureCreationInput(overrides: Partial<CreationInput> = {}): CreationInput {
  return {
    creationRequestId: randomUUID(),
    userName: "Ada",
    adults: 2,
    originAirportId: FIXTURE_ORIGIN_AIRPORT,
    destinationCityId: FIXTURE_DESTINATION_CITY,
    destinationCountryKey: FIXTURE_DESTINATION_COUNTRY,
    sightseeingDate: FIXTURE_SIGHTSEEING_DATE,
    travelVariant: "two_nights",
    ...overrides,
  };
}
