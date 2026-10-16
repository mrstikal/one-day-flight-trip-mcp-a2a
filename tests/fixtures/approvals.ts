import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { computeRouteFingerprint } from "@odft/data";
import { buildRouteInputs, getTrip } from "@odft/persistence";
import type { FeasibleRouteValidation } from "@odft/contracts";

/**
 * Minimal FEASIBLE/VALID approval rows so bookings have a current approval.
 * The route fingerprint is computed from the live trip + reference DB so it
 * satisfies the Phase 04 booking-side freshness guard (FR-FEAS-8).
 */

const HEX64 = "a".repeat(64);

export async function insertFeasibleRoute(
  client: Pick<PoolClient, "query">,
  tripId: string,
): Promise<string> {
  const id = randomUUID();
  const trip = await getTrip(client, tripId);
  if (!trip) {
    throw new Error(`fixture trip ${tripId} not found`);
  }
  const inputs = await buildRouteInputs(client, trip);
  if (!inputs) {
    throw new Error(`fixture route inputs for trip ${tripId} are unavailable`);
  }
  const fingerprint = computeRouteFingerprint(inputs);
  const result: FeasibleRouteValidation = {
    status: "FEASIBLE",
    fingerprint,
    policyVersion: inputs.routePolicyVersion,
    approvedAirportPairs: [["PRG", "FCO"]],
    approvedPairDetails: [],
    evidenceRefs: [],
    warnings: [],
    expiresWithInputs: true,
  };
  await client.query(
    `INSERT INTO odft_app.route_validations (id, trip_id, fingerprint, policy_version, status, result)
     VALUES ($1, $2, $3, $4, 'FEASIBLE', $5::jsonb)`,
    [id, tripId, fingerprint, inputs.routePolicyVersion, JSON.stringify(result)],
  );
  await client.query(`UPDATE odft_app.trips SET current_route_validation_id = $2 WHERE id = $1`, [
    tripId,
    id,
  ]);
  return id;
}

export async function insertValidSchedule(
  client: Pick<PoolClient, "query">,
  input: { tripId: string; routeValidationId: string; snapshotId: string },
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO odft_app.schedule_validations
       (id, route_validation_id, snapshot_id, fingerprint, status, result)
     VALUES ($1, $2, $3, $4, 'VALID', $5::jsonb)`,
    [
      id,
      input.routeValidationId,
      input.snapshotId,
      HEX64,
      JSON.stringify({
        id,
        status: "VALID",
        routeValidationId: input.routeValidationId,
        fingerprint: HEX64,
        validCombinationIds: ["fixture-combination"],
        rejected: [],
        explanation: "fixture valid schedule",
      }),
    ],
  );
  await client.query(
    `UPDATE odft_app.trips SET current_schedule_validation_id = $2 WHERE id = $1`,
    [input.tripId, id],
  );
  return id;
}
