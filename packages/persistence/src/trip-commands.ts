import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  publicRouteChangePreviewSchema,
  tripPreferencesSchema,
  type BookableKey,
  type DomainCommand,
  type PublicRouteSummary,
  type RouteChangeField,
  type TripPreferences,
} from "@odft/contracts";
import { insertEvent } from "./events.js";
import { upsertFaultRow } from "./scenario/faults.js";
import { getTrip, lockTrip } from "./trips.js";

/**
 * Apply admitted domain commands to the trip's route/preference columns
 * (Phase 06). Worker writes never advance `trip.revision`; they only mutate the
 * trip inputs the graph then revalidates.
 *
 * A batch is applied in ONE transaction after the whole batch is validated in
 * memory, so a later command that cannot be honored (e.g. a route change after a
 * confirmed reservation) leaves none of the earlier commands applied.
 */

export interface ApplyTripCommandResult {
  readonly outcome: "applied" | "noop";
  /** True when origin/city/date/variant changed and route evidence is now stale. */
  readonly routeChanged: boolean;
}

export interface ApplyTripCommandsResult extends ApplyTripCommandResult {
  /** Number of commands that actually changed trip state. */
  readonly appliedCount: number;
}

/** An Error carrying a safe domain code that the worker maps to a conflict. */
export class TripCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

interface TripRouteState {
  originAirportId: string;
  destinationCityId: string;
  destinationCountryKey: string;
  sightseeingDate: string;
  travelVariant: string;
  preferences: TripPreferences;
}

/** Apply one command to the in-memory state; reference checks read, never write. */
async function applyCommandInMemory(
  client: PoolClient,
  state: TripRouteState,
  command: DomainCommand,
): Promise<{ state: TripRouteState; routeChanged: boolean; preferencesChanged: boolean }> {
  let { originAirportId, destinationCityId, destinationCountryKey, sightseeingDate, travelVariant } =
    state;
  let preferences = state.preferences;
  let routeChanged = false;
  const originalPreferences = JSON.stringify(preferences);

  switch (command.type) {
    case "set_route": {
      if (command.originAirportId !== undefined) {
        const row = await client.query<{ id: string }>(
          `SELECT id FROM odft_app.reference_airports WHERE id = $1 AND eligible_origin = true`,
          [command.originAirportId],
        );
        if (!row.rows[0]) {
          throw new Error("origin airport is not an admitted eligible origin");
        }
        if (originAirportId !== command.originAirportId) {
          originAirportId = command.originAirportId;
          routeChanged = true;
        }
      }
      if (command.destinationCityId !== undefined) {
        const row = await client.query<{ country_key: string }>(
          `SELECT country_key FROM odft_app.reference_cities WHERE id = $1`,
          [command.destinationCityId],
        );
        const found = row.rows[0];
        if (!found) {
          throw new Error("destination city is not an admitted reference city");
        }
        if (destinationCityId !== command.destinationCityId) {
          destinationCityId = command.destinationCityId;
          destinationCountryKey = found.country_key;
          routeChanged = true;
        }
      }
      if (command.sightseeingDate !== undefined && sightseeingDate !== command.sightseeingDate) {
        sightseeingDate = command.sightseeingDate;
        routeChanged = true;
      }
      if (command.travelVariant !== undefined && travelVariant !== command.travelVariant) {
        travelVariant = command.travelVariant;
        preferences = tripPreferencesSchema.parse({
          ...preferences,
          travelVariant: command.travelVariant,
        });
        routeChanged = true;
      }
      break;
    }
    case "set_default_service_level":
      preferences = tripPreferencesSchema.parse({
        ...preferences,
        defaultServiceLevel: command.level,
      });
      break;
    case "set_service_override": {
      const overrides = { ...preferences.serviceOverrides };
      if (command.level === null) {
        delete overrides[command.service];
      } else {
        overrides[command.service] = command.level;
      }
      preferences = tripPreferencesSchema.parse({ ...preferences, serviceOverrides: overrides });
      break;
    }
    case "set_activity_pace":
      preferences = tripPreferencesSchema.parse({ ...preferences, activityPace: command.pace });
      break;
    case "set_interests":
      preferences = tripPreferencesSchema.parse({
        ...preferences,
        interests: command.interests,
        preferredActivityTags: command.preferredTags,
      });
      break;
    case "set_activity_requirement": {
      const counts = { ...preferences.minimumActivityCounts };
      if (command.minimumCount === null) {
        delete counts[command.tag];
      } else {
        counts[command.tag] = command.minimumCount;
      }
      preferences = tripPreferencesSchema.parse({
        ...preferences,
        minimumActivityCounts: counts,
      });
      break;
    }
    case "set_budget": {
      const next = { ...preferences };
      if (command.maxBudgetMinor === null) {
        delete next.maxBudgetMinor;
      } else {
        next.maxBudgetMinor = command.maxBudgetMinor;
      }
      preferences = tripPreferencesSchema.parse(next);
      break;
    }
    case "set_simulation": {
      // Phase 10 scenario controls (05 section 12): the budget conflict persists
      // an explicit low budget, and the preference conflict persists the
      // six-museums-at-relaxed-pace request. `invalid_itinerary` is a fault
      // overlay written by the caller (no trip input change).
      if (command.mode === "budget_conflict") {
        preferences = tripPreferencesSchema.parse({ ...preferences, maxBudgetMinor: 100 });
      } else if (command.mode === "preference_conflict") {
        preferences = tripPreferencesSchema.parse({
          ...preferences,
          activityPace: "relaxed",
          minimumActivityCounts: { ...preferences.minimumActivityCounts, museum: 6 },
        });
      }
      break;
    }
    default:
      // Non-preference/non-route commands (find_alternatives, propose_selection,
      // set_program, build_itinerary, retry_failed_domains) are handled by later
      // phases; they do not mutate trip inputs here.
      break;
  }

  return {
    state: {
      originAirportId,
      destinationCityId,
      destinationCountryKey,
      sightseeingDate,
      travelVariant,
      preferences,
    },
    routeChanged,
    preferencesChanged: JSON.stringify(preferences) !== originalPreferences,
  };
}

/**
 * Apply a whole command batch atomically. Every command is validated and applied
 * in memory first; the single UPDATE and one event per applied command commit
 * together, so a batch either fully applies or leaves the trip untouched.
 */
export async function applyTripCommands(
  pool: Pool,
  input: { readonly tripId: string; readonly commands: readonly DomainCommand[] },
): Promise<ApplyTripCommandsResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const trip = await lockTrip(client, input.tripId);
    if (!trip) {
      throw new Error(`trip ${input.tripId} not found while applying commands`);
    }

    let state: TripRouteState = {
      originAirportId: trip.originAirportId,
      destinationCityId: trip.destinationCityId,
      destinationCountryKey: trip.destinationCountryKey,
      sightseeingDate: trip.sightseeingDate,
      travelVariant: trip.travelVariant,
      preferences: trip.preferences,
    };
    let routeChanged = false;
    const applied: DomainCommand[] = [];
    for (const command of input.commands) {
      const result = await applyCommandInMemory(client, state, command);
      state = result.state;
      routeChanged = routeChanged || result.routeChanged;
      if (result.routeChanged || result.preferencesChanged) {
        applied.push(command);
      }
    }

    // Phase 10 scenario E: the invalid-itinerary fault is a persisted overlay,
    // not a trip input change, so it is written here and still counts as applied.
    const itineraryFaultArmed = input.commands.some(
      (command) => command.type === "set_simulation" && command.mode === "invalid_itinerary",
    );

    if (applied.length === 0 && !itineraryFaultArmed) {
      await client.query("ROLLBACK");
      return { outcome: "noop", routeChanged: false, appliedCount: 0 };
    }

    // Changing the route (origin/destination/date/variant) invalidates the
    // confirmed reservations it is incompatible with. Replacing a booking needs an
    // explicit impact review (Phase 11), so refuse the WHOLE batch instead of
    // silently diverging. The affected-service set is the SAME one the impact
    // preview computes, so staging and this guard can never disagree (an
    // origin-only change leaves destination-bound bookings valid).
    if (routeChanged) {
      const from = routeSummary({
        originAirportId: trip.originAirportId,
        destinationCityId: trip.destinationCityId,
        destinationCountryKey: trip.destinationCountryKey,
        sightseeingDate: trip.sightseeingDate,
        travelVariant: trip.travelVariant,
        preferences: trip.preferences,
      });
      const affectedServices = affectedServiceKeys(changedRouteFields(from, routeSummary(state)));
      const reservations = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM odft_app.reservations
          WHERE trip_id = $1 AND status = 'confirmed' AND service_key = ANY($2::text[])`,
        [input.tripId, affectedServices],
      );
      if (Number(reservations.rows[0]?.count ?? "0") > 0) {
        throw new TripCommandError(
          "REPLACEMENT_CONFIRMATION_REQUIRED",
          "changing the route after a confirmed reservation requires an impact review",
        );
      }
    }

    await client.query(
      `UPDATE odft_app.trips
          SET origin_airport_id = $2, destination_city_id = $3, destination_country_key = $4,
              sightseeing_date = $5, travel_variant = $6, preferences = $7::jsonb, updated_at = now()
        WHERE id = $1`,
      [
        input.tripId,
        state.originAirportId,
        state.destinationCityId,
        state.destinationCountryKey,
        state.sightseeingDate,
        state.travelVariant,
        JSON.stringify(state.preferences),
      ],
    );
    for (const command of applied) {
      await insertEvent(client, {
        tripId: input.tripId,
        type: routeChanged ? "trip.route_changed" : "trip.preferences_changed",
        payload: { command: command.type },
      });
    }
    if (itineraryFaultArmed) {
      await upsertFaultRow(client, {
        tripId: input.tripId,
        domain: "itinerary",
        fault: "invalid_itinerary",
        state: { label: "Simulated failure: injected first-attempt overlap" },
      });
      await insertEvent(client, {
        tripId: input.tripId,
        type: "trip.simulation_armed",
        payload: { mode: "invalid_itinerary", domain: "itinerary" },
      });
    }
    await client.query("COMMIT");
    return {
      outcome: "applied",
      routeChanged,
      appliedCount: applied.length + (itineraryFaultArmed ? 1 : 0),
    };
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

/** Apply a single admitted command (atomic batch of one). */
export async function applyTripCommand(
  pool: Pool,
  input: { readonly tripId: string; readonly command: DomainCommand },
): Promise<ApplyTripCommandResult> {
  const result = await applyTripCommands(pool, {
    tripId: input.tripId,
    commands: [input.command],
  });
  return { outcome: result.outcome, routeChanged: result.routeChanged };
}

/* ---- Phase 11: route-change impact preview and atomic commit ---------------- */

/** One confirmed reservation a route change would cancel (safe fields only). */
export interface RouteChangeReservationPreview {
  readonly id: string;
  readonly serviceKey: BookableKey;
  readonly offerId: string;
  readonly demoReference: string;
  readonly partyTotalMinor: number;
}

export interface RouteChangePreviewResult {
  readonly proposalId: string;
  readonly changedFields: readonly RouteChangeField[];
  readonly from: PublicRouteSummary;
  readonly to: PublicRouteSummary;
  readonly affectedReservations: readonly RouteChangeReservationPreview[];
}

/** Deterministic RFC-4122-shaped id derived from a fingerprint (never random). */
function uuidFromHash(input: Record<string, unknown>): string {
  const hex = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function routeSummary(state: TripRouteState): PublicRouteSummary {
  return {
    originAirportId: state.originAirportId,
    destinationCityId: state.destinationCityId,
    destinationCountryKey: state.destinationCountryKey,
    sightseeingDate: state.sightseeingDate,
    travelVariant: state.travelVariant as PublicRouteSummary["travelVariant"],
  };
}

function changedRouteFields(from: PublicRouteSummary, to: PublicRouteSummary): RouteChangeField[] {
  const fields: RouteChangeField[] = [];
  if (from.originAirportId !== to.originAirportId) {
    fields.push("originAirportId");
  }
  if (from.destinationCityId !== to.destinationCityId) {
    fields.push("destinationCityId");
  }
  if (from.sightseeingDate !== to.sightseeingDate) {
    fields.push("sightseeingDate");
  }
  if (from.travelVariant !== to.travelVariant) {
    fields.push("travelVariant");
  }
  return fields;
}

/**
 * Which confirmed reservations a change invalidates. The scenario snapshot is
 * keyed by the origin airport (plus destination/date/variant/party), so ANY route
 * field change — including an origin-only change — regenerates every generated
 * offer id. A preserved reservation would therefore reference an offer that no
 * longer exists in the active inventory, so every confirmed service is affected
 * and must be named in the impact preview (Phase 11 review fix).
 */
function affectedServiceKeys(changed: readonly RouteChangeField[]): BookableKey[] {
  return changed.length === 0 ? [] : ["flights", "hotel", "breakfast", "lunch", "dinner"];
}

async function loadConfirmedReservations(
  client: PoolClient,
  tripId: string,
  services: readonly BookableKey[],
): Promise<RouteChangeReservationPreview[]> {
  if (services.length === 0) {
    return [];
  }
  const result = await client.query<{
    id: string;
    service_key: string;
    offer_id: string;
    demo_reference: string;
    party_total_minor: string;
  }>(
    `SELECT r.id, r.service_key, r.offer_id, r.demo_reference, r.party_total_minor::text AS party_total_minor
       FROM odft_app.reservations r
      WHERE r.trip_id = $1 AND r.status = 'confirmed' AND r.service_key = ANY($2::text[])
      ORDER BY r.service_key, r.id`,
    [tripId, services],
  );
  return result.rows.map((row) => ({
    id: row.id,
    serviceKey: row.service_key as BookableKey,
    offerId: row.offer_id,
    demoReference: row.demo_reference,
    partyTotalMinor: Number.parseInt(row.party_total_minor, 10),
  }));
}

/**
 * Compute the impact of a `set_route` batch without writing anything. The
 * proposal id is deterministic over the trip, the from/to route, and the
 * command batch, so a crash-replay stages the same confirmation.
 */
export async function previewRouteChange(
  pool: Pool,
  input: { readonly tripId: string; readonly commands: readonly DomainCommand[] },
): Promise<RouteChangePreviewResult> {
  const client = await pool.connect();
  try {
    const trip = await getTrip(client, input.tripId);
    if (!trip) {
      throw new Error(`trip ${input.tripId} not found while previewing a route change`);
    }
    const from = routeSummary({
      originAirportId: trip.originAirportId,
      destinationCityId: trip.destinationCityId,
      destinationCountryKey: trip.destinationCountryKey,
      sightseeingDate: trip.sightseeingDate,
      travelVariant: trip.travelVariant,
      preferences: trip.preferences,
    });
    let state: TripRouteState = {
      originAirportId: trip.originAirportId,
      destinationCityId: trip.destinationCityId,
      destinationCountryKey: trip.destinationCountryKey,
      sightseeingDate: trip.sightseeingDate,
      travelVariant: trip.travelVariant,
      preferences: trip.preferences,
    };
    for (const command of input.commands) {
      state = (await applyCommandInMemory(client, state, command)).state;
    }
    const to = routeSummary(state);
    const changedFields = changedRouteFields(from, to);
    const affectedReservations =
      changedFields.length === 0
        ? []
        : await loadConfirmedReservations(client, input.tripId, affectedServiceKeys(changedFields));
    return {
      proposalId: uuidFromHash({
        kind: "route_change",
        tripId: input.tripId,
        from,
        to,
        commands: input.commands,
      }),
      changedFields,
      from,
      to,
      affectedReservations,
    };
  } finally {
    client.release();
  }
}

/**
 * Commit a confirmed route change: apply the deferred command batch and cancel
 * exactly the named confirmed reservations in ONE transaction, then clear the
 * derived route/schedule/itinerary references so Stage A and Stage B are re-run
 * from scratch. A crash-replay after commit is idempotent: the route already
 * matches and the reservations are already cancelled.
 */
export async function commitRouteChange(
  pool: Pool,
  input: {
    readonly tripId: string;
    readonly operationId: string;
    readonly decisionId: string;
    readonly proposalId: string;
    readonly affectedReservationIds: readonly string[];
    readonly commands: readonly DomainCommand[];
    /** Exact fencing token: the commit is rejected after a lease rotation. */
    readonly fencingToken: string;
  },
): Promise<{ cancelledReservationIds: string[] }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const trip = await lockTrip(client, input.tripId);
    if (!trip) {
      throw new Error(`trip ${input.tripId} not found while committing a route change`);
    }
    // Single-writer rule: the committing worker must still own the exact fencing
    // token inside this transaction (same lock order as the booking store: trip
    // first, then the operation row).
    const owned = await client.query(
      `SELECT 1 FROM odft_app.workflow_operations
        WHERE id = $1 AND trip_id = $2 AND fencing_token = $3::bigint
        FOR SHARE`,
      [input.operationId, input.tripId, input.fencingToken],
    );
    if (owned.rowCount !== 1) {
      throw new TripCommandError(
        "STALE_DECISION",
        "the route change was committed by a worker that no longer owns the operation",
      );
    }
    // The confirmation is bound to the still-pending decision and to the exact
    // preview the decision carries (proposal id + affected reservation ids); a
    // stale confirmation can never cancel anything.
    const decision = await client.query<{
      kind: string;
      status: string;
      option_payload: unknown;
    }>(
      `SELECT kind, status, option_payload FROM odft_app.pending_decisions
        WHERE id = $1 AND trip_id = $2`,
      [input.decisionId, input.tripId],
    );
    const row = decision.rows[0];
    const persistedPreview = publicRouteChangePreviewSchema.safeParse(row?.option_payload);
    if (
      !row ||
      row.status !== "pending" ||
      row.kind !== "route_change_confirmation" ||
      !persistedPreview.success ||
      persistedPreview.data.proposalId !== input.proposalId ||
      [...persistedPreview.data.affectedReservations.map((entry) => entry.id)].sort().join(",") !==
        [...input.affectedReservationIds].sort().join(",")
    ) {
      throw new TripCommandError(
        "STALE_DECISION",
        "the route-change confirmation no longer matches the pending decision",
      );
    }

    const from = routeSummary({
      originAirportId: trip.originAirportId,
      destinationCityId: trip.destinationCityId,
      destinationCountryKey: trip.destinationCountryKey,
      sightseeingDate: trip.sightseeingDate,
      travelVariant: trip.travelVariant,
      preferences: trip.preferences,
    });
    let state: TripRouteState = {
      originAirportId: trip.originAirportId,
      destinationCityId: trip.destinationCityId,
      destinationCountryKey: trip.destinationCountryKey,
      sightseeingDate: trip.sightseeingDate,
      travelVariant: trip.travelVariant,
      preferences: trip.preferences,
    };
    const applied: DomainCommand[] = [];
    for (const command of input.commands) {
      const result = await applyCommandInMemory(client, state, command);
      state = result.state;
      if (result.routeChanged || result.preferencesChanged) {
        applied.push(command);
      }
    }
    const to = routeSummary(state);
    const changedFields = changedRouteFields(from, to);
    const namedIds = [...input.affectedReservationIds].sort();
    // Crash-replay idempotency: the route already matches the target and every
    // named reservation is already cancelled, so the commit already happened.
    const alreadyCancelled =
      namedIds.length === 0
        ? { rows: [] as { id: string }[] }
        : await client.query<{ id: string }>(
            `SELECT id FROM odft_app.reservations
              WHERE trip_id = $1 AND id = ANY($2::uuid[]) AND status = 'cancelled'`,
            [input.tripId, namedIds],
          );
    const alreadyCommitted =
      changedFields.length === 0 && alreadyCancelled.rows.length === namedIds.length;
    if (!alreadyCommitted) {
      const expected = await loadConfirmedReservations(
        client,
        input.tripId,
        affectedServiceKeys(changedFields),
      );
      const expectedIds = expected.map((entry) => entry.id).sort();
      if (expectedIds.join(",") !== namedIds.join(",")) {
        throw new TripCommandError(
          "STALE_DECISION",
          "the route-change impact changed; refresh and confirm the current preview",
        );
      }
    }

    if (changedFields.length > 0) {
      await client.query(
        `UPDATE odft_app.trips
            SET origin_airport_id = $2, destination_city_id = $3, destination_country_key = $4,
                sightseeing_date = $5, travel_variant = $6, preferences = $7::jsonb,
                current_route_validation_id = NULL, current_schedule_validation_id = NULL,
                current_itinerary_id = NULL, approved_itinerary_id = NULL,
                updated_at = now()
          WHERE id = $1`,
        [
          input.tripId,
          state.originAirportId,
          state.destinationCityId,
          state.destinationCountryKey,
          state.sightseeingDate,
          state.travelVariant,
          JSON.stringify(state.preferences),
        ],
      );
      // Selections reference the previous snapshot's offers; a route change
      // invalidates them (they are not bookings and carry no confirmation). The
      // self-arranged program state is reopened with the whole program.
      await client.query(`DELETE FROM odft_app.trip_selections WHERE trip_id = $1`, [input.tripId]);
      await client.query(`DELETE FROM odft_app.self_arranged_services WHERE trip_id = $1`, [
        input.tripId,
      ]);
    }

    let cancelledReservationIds: string[] = [];
    if (namedIds.length > 0) {
      if (!alreadyCommitted) {
        const cancelled = await client.query<{ id: string; service_key: string }>(
          `UPDATE odft_app.reservations
              SET status = 'cancelled', updated_at = now()
            WHERE trip_id = $1 AND id = ANY($2::uuid[]) AND status = 'confirmed'
            RETURNING id, service_key`,
          [input.tripId, namedIds],
        );
        const stillConfirmed = await client.query<{ id: string }>(
          `SELECT id FROM odft_app.reservations
            WHERE trip_id = $1 AND id = ANY($2::uuid[]) AND status = 'confirmed'`,
          [input.tripId, namedIds],
        );
        if (stillConfirmed.rows.length > 0) {
          throw new TripCommandError(
            "STALE_DECISION",
            "not all named reservations could be cancelled; refresh the trip",
          );
        }
        for (const entry of cancelled.rows) {
          await insertEvent(client, {
            tripId: input.tripId,
            type: "booking.cancelled",
            payload: { serviceKey: entry.service_key, reason: "route_change" },
          });
        }
      }
      cancelledReservationIds = [...namedIds];
    }

    if (!alreadyCommitted) {
      for (const command of applied) {
        await insertEvent(client, {
          tripId: input.tripId,
          type: "trip.route_changed",
          payload: { command: command.type },
        });
      }
      await insertEvent(client, {
        tripId: input.tripId,
        type: "route_change.committed",
        payload: {
          proposalId: input.proposalId,
          affectedReservationIds: namedIds,
          cancelledReservationIds,
        },
      });
    }
    await client.query("COMMIT");
    return { cancelledReservationIds };
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
