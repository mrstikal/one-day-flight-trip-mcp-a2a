import type { Pool } from "pg";
import { buildScenarioKey, generateFlights } from "@odft/data";
import {
  GENERATOR_VERSION,
  REFERENCE_VERSION,
  type FeasibleRouteApproval,
  type FlightCombination,
  type RouteInputs,
  type ScenarioManifest,
  type SnapshotContext,
} from "@odft/contracts";
import { getTrip } from "../trips.js";
import { buildRouteInputs, buildSnapshotContext } from "./route-inputs.js";
import { loadFeasibleRouteApproval } from "./validations.js";
import { initialSnapshotContent, persistSnapshotVersion, scenarioUuid } from "./snapshots.js";

/**
 * Deterministic flight materialization for the production graph (Phase 06).
 *
 * Reads the persisted FEASIBLE route approval and live route inputs, generates
 * the outbound/return combinations, and persists a flight-only snapshot version
 * (reusing the current version when nothing changed). Returns `undefined` when
 * no feasible approval exists, so the graph can render the gating decision card
 * instead of fabricating offers.
 */

export interface MaterializedFlightSnapshot {
  readonly scenarioKey: string;
  readonly snapshotId: string;
  readonly manifest: ScenarioManifest;
  readonly flights: FlightCombination[];
  readonly context: SnapshotContext;
  readonly inputs: RouteInputs;
  readonly approval: FeasibleRouteApproval;
}

/** Fixed per-route seed so the same route always yields the same schedule. */
function seedForFingerprint(fingerprint: string): string {
  return `odft-${fingerprint}`;
}

export async function materializeFlightSnapshot(
  pool: Pool,
  tripId: string,
  options: { readonly generatedAt?: string } = {},
): Promise<MaterializedFlightSnapshot | undefined> {
  const client = await pool.connect();
  let approval: FeasibleRouteApproval | undefined;
  let inputs: RouteInputs | undefined;
  let trip: Awaited<ReturnType<typeof getTrip>>;
  try {
    trip = await getTrip(client, tripId);
    if (!trip) {
      return undefined;
    }
    inputs = await buildRouteInputs(client, trip);
    if (!inputs) {
      return undefined;
    }
    approval = await loadFeasibleRouteApproval(client, tripId);
    if (!approval) {
      return undefined;
    }
  } finally {
    client.release();
  }

  const contextClient = await pool.connect();
  let context: SnapshotContext;
  try {
    context = await buildSnapshotContext(contextClient, trip, inputs);
  } finally {
    contextClient.release();
  }

  const seed = seedForFingerprint(approval.fingerprint);
  const scenarioKey = buildScenarioKey({
    seed,
    originAirportId: inputs.origin.airportId,
    originIata: inputs.origin.iata,
    destinationCityId: context.destinationCityId,
    destinationCountryKey: context.countryKey,
    destinationAirportIds: approval.approvedPairDetails.map((pair) => pair.destinationAirportId),
    sightseeingDate: context.sightseeingDate,
    travelVariant: context.travelVariant,
    adults: context.adults,
    generatorVersion: GENERATOR_VERSION,
    referenceVersion: REFERENCE_VERSION,
    routePolicyVersion: inputs.routePolicyVersion,
  });
  const flights = generateFlights(
    approval,
    {
      scenarioKey,
      seed,
      sightseeingDate: context.sightseeingDate,
      travelVariant: context.travelVariant,
      adults: context.adults,
      generatorVersion: GENERATOR_VERSION,
    },
    inputs,
  );
  const content = initialSnapshotContent({
    scenarioKey,
    seed,
    referenceVersion: REFERENCE_VERSION,
    routeFingerprint: approval.fingerprint,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    context,
    flights,
  });
  const { manifest } = await persistSnapshotVersion(pool, {
    tripId,
    scenarioId: scenarioUuid(scenarioKey),
    content,
  });
  return {
    scenarioKey,
    snapshotId: manifest.snapshotId,
    manifest,
    flights,
    context,
    inputs,
    approval,
  };
}
