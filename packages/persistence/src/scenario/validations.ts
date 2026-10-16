import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  routeValidationSchema,
  scheduleValidationSchema,
  SCHEDULE_RULE_VERSION,
  type FeasibleRouteApproval,
  type RouteValidation,
  type ScheduleValidation,
  type TripRecord,
} from "@odft/contracts";
import { computeRouteFingerprint, validateRoute, validateSchedules } from "@odft/data";
import { getTrip } from "../trips.js";
import { buildRouteInputs } from "./route-inputs.js";
import { loadSnapshotContent, loadSnapshotManifest } from "./snapshots.js";

/**
 * Persistence for the two feasibility stages (04-domain-model section 4).
 * `route_validations`/`schedule_validations` are append-only evidence; the trip
 * points at the current rows. The booking guard reads the stored route
 * fingerprint and compares it with a fresh computation from live inputs.
 */

type Queryable = Pick<PoolClient, "query">;

interface RouteRow {
  id: string;
  fingerprint: string;
  policy_version: string;
  status: string;
  result: unknown;
}

export async function persistRouteValidation(
  pool: Pool,
  tripId: string,
  result: RouteValidation,
): Promise<string> {
  const id = result.id ?? randomUUID();
  const stored: RouteValidation = { ...result, id };
  const parsed = routeValidationSchema.parse(stored);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO odft_app.route_validations (id, trip_id, fingerprint, policy_version, status, result)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [id, tripId, parsed.fingerprint, parsed.policyVersion, parsed.status, JSON.stringify(parsed)],
    );
    await client.query(
      `UPDATE odft_app.trips SET current_route_validation_id = $2, updated_at = now() WHERE id = $1`,
      [tripId, id],
    );
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function loadRouteValidation(
  client: Queryable,
  id: string,
): Promise<RouteValidation | undefined> {
  const result = await client.query<RouteRow>(
    `SELECT id, fingerprint, policy_version, status, result FROM odft_app.route_validations WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) {
    return undefined;
  }
  return routeValidationSchema.parse(row.result);
}

/** Current persisted FEASIBLE route approval, or undefined. */
export async function loadFeasibleRouteApproval(
  client: Queryable,
  tripId: string,
): Promise<FeasibleRouteApproval | undefined> {
  const result = await client.query<RouteRow>(
    `SELECT rv.id, rv.fingerprint, rv.policy_version, rv.status, rv.result
       FROM odft_app.trips t
       JOIN odft_app.route_validations rv ON rv.id = t.current_route_validation_id
      WHERE t.id = $1`,
    [tripId],
  );
  const row = result.rows[0];
  if (!row || row.status !== "FEASIBLE") {
    return undefined;
  }
  const parsed = routeValidationSchema.parse(row.result);
  if (parsed.status !== "FEASIBLE") {
    return undefined;
  }
  return {
    routeValidationId: row.id,
    status: "FEASIBLE",
    fingerprint: parsed.fingerprint,
    policyVersion: parsed.policyVersion,
    approvedAirportPairs: parsed.approvedAirportPairs,
    approvedPairDetails: parsed.approvedPairDetails,
    expiresWithInputs: true,
  };
}

export interface ApprovalGuardState {
  readonly routeStatus: string | null;
  readonly scheduleStatus: string | null;
  readonly routeApprovalFingerprint: string | null;
  readonly currentRouteFingerprint: string | null;
  readonly currentRouteValidationId: string | null;
  readonly scheduleRouteValidationId: string | null;
  readonly activeSnapshotId: string | null;
  readonly scheduleSnapshotId: string | null;
  readonly scheduleValidCombinationIds: string[] | null;
}

/**
 * Recompares the stored route approval with the current route inputs and binds
 * the current schedule validation to that same route approval and snapshot.
 * Used as the booking service's independent guard (FR-FEAS-8 / T-INV-10b).
 */
export async function currentApprovalGuard(
  client: Queryable,
  tripId: string,
): Promise<ApprovalGuardState> {
  const result = await client.query<{
    current_route_validation_id: string | null;
    current_schedule_validation_id: string | null;
    active_scenario_snapshot_id: string | null;
    route_status: string | null;
    route_fingerprint: string | null;
    schedule_status: string | null;
    schedule_route_validation_id: string | null;
    schedule_snapshot_id: string | null;
    schedule_result: unknown;
  }>(
    `SELECT
       t.current_route_validation_id,
       t.current_schedule_validation_id,
       t.active_scenario_snapshot_id,
       (SELECT status FROM odft_app.route_validations WHERE id = t.current_route_validation_id) AS route_status,
       (SELECT fingerprint FROM odft_app.route_validations WHERE id = t.current_route_validation_id) AS route_fingerprint,
       (SELECT status FROM odft_app.schedule_validations WHERE id = t.current_schedule_validation_id) AS schedule_status,
       (SELECT route_validation_id FROM odft_app.schedule_validations WHERE id = t.current_schedule_validation_id) AS schedule_route_validation_id,
       (SELECT snapshot_id FROM odft_app.schedule_validations WHERE id = t.current_schedule_validation_id) AS schedule_snapshot_id,
       (SELECT result FROM odft_app.schedule_validations WHERE id = t.current_schedule_validation_id) AS schedule_result
     FROM odft_app.trips t WHERE t.id = $1`,
    [tripId],
  );
  const row = result.rows[0];
  const trip = await getTrip(client, tripId);
  let currentRouteFingerprint: string | null = null;
  if (trip) {
    const inputs = await buildRouteInputs(client, trip);
    if (inputs) {
      currentRouteFingerprint = computeRouteFingerprint(inputs);
    }
  }
  let scheduleValidCombinationIds: string[] | null = null;
  if (row?.schedule_result !== undefined && row?.schedule_result !== null) {
    const parsed = scheduleValidationSchema.safeParse(row.schedule_result);
    if (parsed.success) {
      scheduleValidCombinationIds = parsed.data.validCombinationIds;
    }
  }
  return {
    routeStatus: row?.route_status ?? null,
    scheduleStatus: row?.schedule_status ?? null,
    routeApprovalFingerprint: row?.route_fingerprint ?? null,
    currentRouteFingerprint,
    currentRouteValidationId: row?.current_route_validation_id ?? null,
    scheduleRouteValidationId: row?.schedule_route_validation_id ?? null,
    activeSnapshotId: row?.active_scenario_snapshot_id ?? null,
    scheduleSnapshotId: row?.schedule_snapshot_id ?? null,
    scheduleValidCombinationIds,
  };
}

export interface PersistScheduleInput {
  readonly tripId: string;
  readonly snapshotId: string;
  readonly result: ScheduleValidation;
}

export async function persistScheduleValidation(
  pool: Pool,
  input: PersistScheduleInput,
): Promise<string> {
  const id = input.result.id ?? randomUUID();
  const stored: ScheduleValidation = { ...input.result, id };
  const parsed = scheduleValidationSchema.parse(stored);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO odft_app.schedule_validations (id, route_validation_id, snapshot_id, fingerprint, status, result)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        id,
        input.result.routeValidationId,
        input.snapshotId,
        parsed.fingerprint,
        parsed.status,
        JSON.stringify(parsed),
      ],
    );
    await client.query(
      `UPDATE odft_app.trips SET current_schedule_validation_id = $2, updated_at = now() WHERE id = $1`,
      [input.tripId, id],
    );
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function loadScheduleValidation(
  client: Queryable,
  id: string,
): Promise<ScheduleValidation | undefined> {
  const result = await client.query<{ result: unknown }>(
    `SELECT result FROM odft_app.schedule_validations WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? scheduleValidationSchema.parse(row.result) : undefined;
}

export interface EvaluatedRoute {
  readonly id: string;
  readonly result: RouteValidation;
}

/** Rebuild inputs from the live trip + reference DB and persist the decision. */
export async function evaluateAndPersistRoute(
  pool: Pool,
  tripId: string,
): Promise<EvaluatedRoute | undefined> {
  const client = await pool.connect();
  let trip: TripRecord | undefined;
  let inputs: Awaited<ReturnType<typeof buildRouteInputs>>;
  try {
    trip = await getTrip(client, tripId);
    inputs = trip ? await buildRouteInputs(client, trip) : undefined;
  } finally {
    client.release();
  }
  if (!trip || !inputs) {
    return undefined;
  }
  const result = validateRoute(inputs);
  const id = await persistRouteValidation(pool, tripId, result);
  return { id, result: { ...result, id } };
}

/**
 * Stage B for the production graph: re-read the persisted snapshot and approval,
 * run the independent schedule validator, and persist the result as the trip's
 * current schedule validation. Returns `undefined` when prerequisites are gone.
 */
export async function validateAndPersistSchedules(
  pool: Pool,
  tripId: string,
  snapshotId: string,
): Promise<ScheduleValidation | undefined> {
  const client = await pool.connect();
  let inputs: Awaited<ReturnType<typeof buildRouteInputs>>;
  let approval: FeasibleRouteApproval | undefined;
  let content: Awaited<ReturnType<typeof loadSnapshotContent>>;
  let manifest: Awaited<ReturnType<typeof loadSnapshotManifest>>;
  try {
    const trip = await getTrip(client, tripId);
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
    content = await loadSnapshotContent(client, snapshotId);
    manifest = await loadSnapshotManifest(client, snapshotId);
  } finally {
    client.release();
  }
  if (!content) {
    return undefined;
  }
  const result = validateSchedules({
    approval,
    combinations: content.flights,
    scenarioKey: content.scenarioKey,
    flightDomainVersion: manifest.domainVersions.flights,
    flightDomainHash: manifest.domainContentHashes.flights,
    scheduleRuleVersion: SCHEDULE_RULE_VERSION,
    sightseeingDate: inputs.sightseeingDate,
    travelVariant: inputs.travelVariant,
    destinationZone: inputs.destination.zone as string,
    destinationTransferMinutes: approval.approvedPairDetails[0]?.destinationTransferMinutes ?? 0,
    routeValidationId: approval.routeValidationId,
  });
  const id = await persistScheduleValidation(pool, { tripId, snapshotId, result });
  return { ...result, id };
}
