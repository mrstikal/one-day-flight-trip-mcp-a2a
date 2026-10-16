import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  itineraryCostsSchema,
  itineraryEventSchema,
  itineraryRecordSchema,
  itineraryReviewSchema,
  itineraryValidationSchema,
  type ErrorCode,
  type ItineraryCosts,
  type ItineraryEvent,
  type ItineraryReview,
  type ItineraryValidation,
  type Meal,
  type SnapshotContent,
  type TripRecord,
} from "@odft/contracts";
import { withEffect } from "./admission.js";
import { assertOperationFence, type OperationFence } from "./effects.js";
import { loadSelfArrangedState } from "./self-arranged.js";
import { loadSnapshotContent } from "./scenario/snapshots.js";
import {
  dinnerSlotAvailable,
  loadAirportAnchor,
  loadPreferredActivityIds,
} from "./scenario/trip-services.js";
import { getTrip } from "./trips.js";

type Queryable = Pick<PoolClient, "query">;

/**
 * Immutable itinerary persistence (Phase 10): planning inputs, append-only
 * versions, reviewer findings, and the fenced approval that binds the current
 * source fingerprints (03-langgraph-design.md section 9).
 */

/** Typed itinerary persistence failure carrying a safe error code. */
export class ItineraryPersistenceError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ItineraryPersistenceError";
    this.code = code;
  }
}

/** Persisted meal selections may be incomplete before the program is applied. */
export interface ItineraryMealSelections {
  readonly breakfast: string | null;
  readonly lunch: string | null;
  readonly dinner: string | null;
}

export interface ItineraryPlanningData {
  readonly trip: TripRecord;
  readonly zone: string;
  readonly snapshotId: string;
  readonly content: SnapshotContent;
  readonly selectedMeals: ItineraryMealSelections;
  /** Confirmed meal offer id per service (locked reservation windows). */
  readonly confirmedMeals: ItineraryMealSelections;
  readonly confirmedMealIds: readonly string[];
  /** Meals the traveler arranges themselves: excluded from the plan. */
  readonly selfArrangedMeals: readonly Meal[];
  /** Activities the traveler arranges themselves: no activity candidates. */
  readonly selfArrangedActivities: boolean;
  /**
   * The planned flight/hotel offer: the confirmed reservation or, for a declined
   * booking ("I don't want to book"), the persisted selection. The plan is built
   * as if the service existed; `*Booked` tells whether a reservation confirms it.
   */
  readonly flightOfferId: string | null;
  readonly flightBooked: boolean;
  readonly hotelOfferId: string | null;
  readonly hotelBooked: boolean;
  readonly dinnerExcludedReason: string | null;
  readonly destinationAirportId: string | null;
  readonly destinationAirportAnchor: { lat: number; lon: number } | null;
  readonly preferredActivityIds: readonly string[];
}

async function loadMealSelections(
  client: Queryable,
  tripId: string,
): Promise<ItineraryMealSelections> {
  const result = await client.query<{ service_key: string; offer_id: string }>(
    `SELECT service_key, offer_id FROM odft_app.trip_selections
      WHERE trip_id = $1 AND service_key IN ('breakfast','lunch','dinner')`,
    [tripId],
  );
  const byService = new Map(result.rows.map((row) => [row.service_key, row.offer_id]));
  return {
    breakfast: byService.get("breakfast") ?? null,
    lunch: byService.get("lunch") ?? null,
    dinner: byService.get("dinner") ?? null,
  };
}

/** Load every persisted input the planner/assembly/validator needs. */
export async function loadItineraryPlanningData(
  pool: Pool,
  tripId: string,
): Promise<ItineraryPlanningData> {
  const client = await pool.connect();
  try {
    const trip = await getTrip(client, tripId);
    if (!trip) {
      throw new ItineraryPersistenceError("NOT_FOUND", `trip ${tripId} not found`);
    }
    const snapshotId = trip.activeScenarioSnapshotId;
    if (!snapshotId) {
      throw new ItineraryPersistenceError(
        "CONFLICT",
        "the trip has no materialized snapshot to plan the itinerary from",
      );
    }
    const content = await loadSnapshotContent(client, snapshotId);
    if (!content) {
      throw new ItineraryPersistenceError("CONFLICT", `snapshot ${snapshotId} is not materialized`);
    }

    const selectedMeals = await loadMealSelections(client, tripId);
    const reservations = await client.query<{ service_key: string; offer_id: string }>(
      `SELECT service_key, offer_id FROM odft_app.reservations
        WHERE trip_id = $1 AND status = 'confirmed'`,
      [tripId],
    );
    const selections = await client.query<{ service_key: string; offer_id: string }>(
      `SELECT service_key, offer_id FROM odft_app.trip_selections
        WHERE trip_id = $1 AND service_key IN ('flights','hotel')`,
      [tripId],
    );
    const confirmedByService = new Map(reservations.rows.map((row) => [row.service_key, row.offer_id]));
    const selectedByService = new Map(selections.rows.map((row) => [row.service_key, row.offer_id]));
    const confirmedMeals: ItineraryMealSelections = {
      breakfast: confirmedByService.get("breakfast") ?? null,
      lunch: confirmedByService.get("lunch") ?? null,
      dinner: confirmedByService.get("dinner") ?? null,
    };
    const confirmedMealIds = ["breakfast", "lunch", "dinner"]
      .map((service) => confirmedByService.get(service))
      .filter((value): value is string => typeof value === "string");
    // The plan is built around the confirmed reservation, or the selection when
    // the booking was declined ("I don't want to book").
    const flightOfferId =
      confirmedByService.get("flights") ?? selectedByService.get("flights") ?? null;
    const flightBooked = confirmedByService.has("flights");
    const hotelOfferId = confirmedByService.get("hotel") ?? selectedByService.get("hotel") ?? null;
    const hotelBooked = confirmedByService.has("hotel");

    const flight = flightOfferId
      ? content.flights.find((combination) => combination.id === flightOfferId)
      : undefined;
    const outboundLast = flight?.outbound.segments[flight.outbound.segments.length - 1];
    const destinationAirportId = outboundLast?.toAirportId ?? null;
    const destinationAirportAnchor = destinationAirportId
      ? ((await loadAirportAnchor(client, destinationAirportId)) ?? null)
      : null;

    const slot = await dinnerSlotAvailable(client, tripId, content);
    const selfArranged = await loadSelfArrangedState(client, tripId);
    const dinnerSelfArranged = selfArranged.meals.includes("dinner");
    const dinnerExcludedReason =
      !dinnerSelfArranged && selectedMeals.dinner === null && !slot.available ? slot.reason : null;

    return {
      trip,
      zone: content.context.cityZone,
      snapshotId,
      content,
      selectedMeals,
      confirmedMeals,
      confirmedMealIds,
      selfArrangedMeals: selfArranged.meals,
      selfArrangedActivities: selfArranged.activities,
      flightOfferId,
      flightBooked,
      hotelOfferId,
      hotelBooked,
      dinnerExcludedReason,
      destinationAirportId,
      destinationAirportAnchor,
      // Loaded through the already-held client: no second connection is acquired
      // while this one is checked out.
      preferredActivityIds: await loadPreferredActivityIds(client, tripId),
    };
  } finally {
    client.release();
  }
}

export interface PersistItineraryDraftInput {
  readonly tripId: string;
  readonly operationId: string;
  readonly attempt: number;
  readonly sightseeingDate: string;
  readonly zone: string;
  readonly adults: number;
  readonly pace: string;
  readonly travelVariant: string;
  readonly events: readonly ItineraryEvent[];
  readonly validation: ItineraryValidation;
  readonly costs: ItineraryCosts;
  readonly review: ItineraryReview | null;
  readonly simulatedFailure: boolean;
  readonly simulatedFailureNote: string | null;
}

export interface PersistedItineraryRef {
  readonly id: string;
  readonly version: number;
}

const ITINERARY_COLUMNS =
  "id, trip_id, version, status, events, validation, costs, review, simulated_failure, " +
  "simulated_failure_note, sightseeing_date::text AS sightseeing_date, zone, adults, pace, " +
  "travel_variant, created_at";

/**
 * Append one immutable draft version. Idempotent under the effect ledger
 * (`plan_itinerary` / `plan:<attempt>`): a replay after a commit-before-checkpoint
 * crash returns the stored version instead of inserting a duplicate.
 */
export async function persistItineraryDraft(
  pool: Pool,
  input: PersistItineraryDraftInput,
  fence: OperationFence,
): Promise<PersistedItineraryRef> {
  // The persisted contract is enforced BEFORE the insert: a record outside the
  // schema bounds would make `loadLatestItinerary` throw and break the whole trip
  // projection, so an out-of-contract draft is rejected as a typed conflict.
  try {
    itineraryEventSchema.array().max(80).parse(input.events);
    itineraryValidationSchema.parse(input.validation);
    itineraryCostsSchema.parse(input.costs);
    itineraryReviewSchema.nullable().parse(input.review);
  } catch {
    throw new ItineraryPersistenceError(
      "CONFLICT",
      "the assembled itinerary is outside the persisted contract bounds; no draft was written",
    );
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assertOperationFence(client, fence);
    const ref = await withEffect(
      client,
      { operationId: input.operationId, nodeName: "plan_itinerary", effectScope: `plan:${input.attempt}` },
      async () => {
        const maxVersion = await client.query<{ max: number | null }>(
          `SELECT max(version) AS max FROM odft_app.itineraries WHERE trip_id = $1`,
          [input.tripId],
        );
        const version = (maxVersion.rows[0]?.max ?? 0) + 1;
        const id = randomUUID();
        await client.query(
          `INSERT INTO odft_app.itineraries
             (id, trip_id, version, events, validation, costs, review, status,
              simulated_failure, simulated_failure_note, sightseeing_date, zone, adults, pace, travel_variant)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, 'draft', $8, $9, $10, $11, $12, $13, $14)`,
          [
            id,
            input.tripId,
            version,
            JSON.stringify(input.events),
            JSON.stringify(input.validation),
            JSON.stringify(input.costs),
            JSON.stringify(input.review),
            input.simulatedFailure,
            input.simulatedFailureNote,
            input.sightseeingDate,
            input.zone,
            input.adults,
            input.pace,
            input.travelVariant,
          ],
        );
        await client.query(`UPDATE odft_app.trips SET current_itinerary_id = $2 WHERE id = $1`, [
          input.tripId,
          id,
        ]);
        return { id, version };
      },
    );
    await client.query("COMMIT");
    return ref;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failures; the original error matters.
    }
    throw error;
  } finally {
    client.release();
  }
}

export interface SaveItineraryReviewInput {
  readonly tripId: string;
  readonly itineraryId: string;
  readonly operationId: string;
  readonly review: ItineraryReview;
  readonly validation: ItineraryValidation;
  readonly simulatedFailure: boolean;
  readonly simulatedFailureNote: string | null;
}

/** Persist reviewer findings and the (possibly warning-augmented) validation. */
export async function saveItineraryReview(
  pool: Pool,
  input: SaveItineraryReviewInput,
  fence: OperationFence,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assertOperationFence(client, fence);
    const result = await client.query(
      `UPDATE odft_app.itineraries
          SET review = $3::jsonb, validation = $4::jsonb,
              simulated_failure = $5, simulated_failure_note = $6
        WHERE id = $1 AND trip_id = $2 AND status = 'draft'`,
      [
        input.itineraryId,
        input.tripId,
        JSON.stringify(input.review),
        JSON.stringify(input.validation),
        input.simulatedFailure,
        input.simulatedFailureNote,
      ],
    );
    if (result.rowCount === 0) {
      throw new ItineraryPersistenceError(
        "CONFLICT",
        "the itinerary draft is no longer current; its review was not saved",
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failures; the original error matters.
    }
    throw error;
  } finally {
    client.release();
  }
}

export interface ApproveItineraryInput {
  readonly tripId: string;
  readonly itineraryId: string;
  readonly currentSourceFingerprint: string;
}

/**
 * Fenced approval of the current draft: verifies the draft status, the
 * deterministic validation, and the current source fingerprint, supersedes the
 * previous approved version, and is idempotent on replay.
 */
export async function approveItineraryDraft(
  pool: Pool,
  input: ApproveItineraryInput,
  fence: OperationFence,
): Promise<PersistedItineraryRef> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assertOperationFence(client, fence);
    const result = await client.query<{
      id: string;
      version: number;
      status: string;
      validation: unknown;
    }>(
      `SELECT id, version, status, validation FROM odft_app.itineraries
        WHERE id = $1 AND trip_id = $2 FOR UPDATE`,
      [input.itineraryId, input.tripId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ItineraryPersistenceError("NOT_FOUND", "the itinerary version was not found");
    }
    if (row.status === "approved") {
      // Idempotent replay: the same version is already approved.
      await client.query("COMMIT");
      return { id: row.id, version: row.version };
    }
    if (row.status !== "draft") {
      throw new ItineraryPersistenceError(
        "ITINERARY_NOT_APPROVABLE",
        "a superseded itinerary version cannot be approved",
      );
    }
    const validation = row.validation as { status?: string; sourceFingerprint?: string };
    if (validation.status !== "valid") {
      throw new ItineraryPersistenceError(
        "ITINERARY_NOT_APPROVABLE",
        "the draft still has blocking validation errors and cannot be approved",
      );
    }
    if (validation.sourceFingerprint !== input.currentSourceFingerprint) {
      throw new ItineraryPersistenceError(
        "STALE_ITINERARY",
        "the trip inputs changed after this draft was generated; build a fresh draft before approving",
      );
    }
    await client.query(
      `UPDATE odft_app.itineraries SET status = 'superseded'
        WHERE trip_id = $1 AND status = 'approved'`,
      [input.tripId],
    );
    await client.query(`UPDATE odft_app.itineraries SET status = 'approved' WHERE id = $1`, [
      input.itineraryId,
    ]);
    await client.query(
      `UPDATE odft_app.trips
          SET approved_itinerary_id = $2, current_itinerary_id = $2
        WHERE id = $1`,
      [input.tripId, input.itineraryId],
    );
    await client.query("COMMIT");
    return { id: row.id, version: row.version };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failures; the original error matters.
    }
    throw error;
  } finally {
    client.release();
  }
}

interface ItineraryRow {
  id: string;
  trip_id: string;
  version: number;
  status: string;
  events: unknown;
  validation: unknown;
  costs: unknown;
  review: unknown;
  simulated_failure: boolean;
  simulated_failure_note: string | null;
  sightseeing_date: string;
  zone: string;
  adults: number;
  pace: string;
  travel_variant: string;
  created_at: Date | string;
}

function toItineraryRecord(row: ItineraryRow) {
  return itineraryRecordSchema.parse({
    id: row.id,
    tripId: row.trip_id,
    version: row.version,
    status: row.status,
    sightseeingDate: row.sightseeing_date,
    zone: row.zone,
    adults: row.adults,
    pace: row.pace,
    travelVariant: row.travel_variant,
    events: row.events,
    validation: row.validation,
    costs: row.costs,
    review: row.review ?? null,
    simulatedFailure: row.simulated_failure,
    simulatedFailureNote: row.simulated_failure_note,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  });
}

export async function loadLatestItinerary(pool: Pool, tripId: string) {
  const result = await pool.query<ItineraryRow>(
    `SELECT ${ITINERARY_COLUMNS} FROM odft_app.itineraries
      WHERE trip_id = $1 ORDER BY version DESC LIMIT 1`,
    [tripId],
  );
  const row = result.rows[0];
  return row ? toItineraryRecord(row) : undefined;
}

export async function loadItineraryById(pool: Pool, itineraryId: string) {
  const result = await pool.query<ItineraryRow>(
    `SELECT ${ITINERARY_COLUMNS} FROM odft_app.itineraries WHERE id = $1`,
    [itineraryId],
  );
  const row = result.rows[0];
  return row ? toItineraryRecord(row) : undefined;
}

/** Latest approved version number (badge context for a newer draft). */
export async function loadApprovedItineraryVersion(
  pool: Pool,
  tripId: string,
): Promise<number | null> {
  const result = await pool.query<{ version: number }>(
    `SELECT version FROM odft_app.itineraries
      WHERE trip_id = $1 AND status = 'approved' ORDER BY version DESC LIMIT 1`,
    [tripId],
  );
  return result.rows[0]?.version ?? null;
}
