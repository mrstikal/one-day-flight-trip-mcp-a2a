import type { PoolClient } from "pg";
import {
  tripPreferencesSchema,
  type SelectionUpsertInput,
  type TravelVariant,
  type TripPreferences,
  type TripRecord,
  type WorkflowStatus,
} from "@odft/contracts";

type Queryable = Pick<PoolClient, "query">;

const TRIP_COLUMNS =
  "id, session_id, revision, adults, origin_airport_id, destination_city_id, destination_country_key, " +
  "sightseeing_date::text AS sightseeing_date, travel_variant, preferences, active_scenario_snapshot_id, " +
  "current_route_validation_id, current_schedule_validation_id, workflow_status, recovery_required, " +
  "last_unfinished_operation_id";

export interface TripRow {
  id: string;
  session_id: string;
  revision: number;
  adults: number;
  origin_airport_id: string;
  destination_city_id: string;
  destination_country_key: string;
  sightseeing_date: string;
  travel_variant: TravelVariant;
  preferences: unknown;
  active_scenario_snapshot_id: string | null;
  current_route_validation_id: string | null;
  current_schedule_validation_id: string | null;
  workflow_status: WorkflowStatus;
  recovery_required: boolean;
  last_unfinished_operation_id: string | null;
}

export function toTripRecord(row: TripRow): TripRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    revision: row.revision,
    adults: row.adults,
    originAirportId: row.origin_airport_id,
    destinationCityId: row.destination_city_id,
    destinationCountryKey: row.destination_country_key,
    sightseeingDate: row.sightseeing_date,
    travelVariant: row.travel_variant,
    preferences: tripPreferencesSchema.parse(row.preferences),
    ...(row.active_scenario_snapshot_id ? { activeScenarioSnapshotId: row.active_scenario_snapshot_id } : {}),
    ...(row.current_route_validation_id
      ? { currentRouteValidationId: row.current_route_validation_id }
      : {}),
    ...(row.current_schedule_validation_id
      ? { currentScheduleValidationId: row.current_schedule_validation_id }
      : {}),
    workflowStatus: row.workflow_status,
    recoveryRequired: row.recovery_required,
    ...(row.last_unfinished_operation_id
      ? { lastUnfinishedOperationId: row.last_unfinished_operation_id }
      : {}),
  };
}

export async function getTrip(client: Queryable, id: string): Promise<TripRecord | undefined> {
  const result = await client.query<TripRow>(
    `SELECT ${TRIP_COLUMNS} FROM odft_app.trips WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? toTripRecord(row) : undefined;
}

/** Lock the trip row for the duration of the transaction. */
export async function lockTrip(client: Queryable, id: string): Promise<TripRecord | undefined> {
  const result = await client.query<TripRow>(
    `SELECT ${TRIP_COLUMNS} FROM odft_app.trips WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const row = result.rows[0];
  return row ? toTripRecord(row) : undefined;
}

export interface InsertTripInput {
  readonly id: string;
  readonly sessionId: string;
  readonly userName: string;
  readonly adults: number;
  readonly originAirportId: string;
  readonly destinationCityId: string;
  readonly destinationCountryKey: string;
  readonly sightseeingDate: string;
  readonly travelVariant: TravelVariant;
  readonly preferences: TripPreferences;
  readonly graphVersion: string;
  readonly creationRequestId: string;
  readonly creationPayloadHash: string;
}

export async function insertTrip(client: Queryable, input: InsertTripInput): Promise<void> {
  await client.query(
    `INSERT INTO odft_app.trips
       (id, session_id, revision, user_name, adults, origin_airport_id, destination_city_id,
        destination_country_key, sightseeing_date, travel_variant, preferences, workflow_status,
        graph_version, creation_request_id, creation_payload_hash)
     VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'queued', $11, $12, $13)`,
    [
      input.id,
      input.sessionId,
      input.userName,
      input.adults,
      input.originAirportId,
      input.destinationCityId,
      input.destinationCountryKey,
      input.sightseeingDate,
      input.travelVariant,
      JSON.stringify(tripPreferencesSchema.parse(input.preferences)),
      input.graphVersion,
      input.creationRequestId,
      input.creationPayloadHash,
    ],
  );
}

export async function setTripWorkflowStatus(
  client: Queryable,
  tripId: string,
  status: WorkflowStatus,
): Promise<void> {
  await client.query(
    `UPDATE odft_app.trips SET workflow_status = $2, updated_at = now() WHERE id = $1`,
    [tripId, status],
  );
}

/** Upsert the per-service selection flags later phases consume. */
export async function upsertSelection(
  client: Queryable,
  input: SelectionUpsertInput,
): Promise<void> {
  await client.query(
    `INSERT INTO odft_app.trip_selections
       (id, trip_id, service_key, offer_id, snapshot_id, selected_by, source_fingerprint,
        active_proposal_id, active_reservation_id, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (trip_id, service_key) DO UPDATE SET
       offer_id = EXCLUDED.offer_id, snapshot_id = EXCLUDED.snapshot_id,
       selected_by = EXCLUDED.selected_by, source_fingerprint = EXCLUDED.source_fingerprint,
       active_proposal_id = EXCLUDED.active_proposal_id,
       active_reservation_id = EXCLUDED.active_reservation_id, updated_at = now()`,
    [
      input.tripId,
      input.serviceKey,
      input.offerId,
      input.snapshotId,
      input.selectedBy,
      input.sourceFingerprint,
      input.activeProposalId,
      input.activeReservationId,
    ],
  );
}
