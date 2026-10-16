import type { Pool, PoolClient } from "pg";
import type {
  BookableKey,
  BookingEventInput,
  BookingStore,
  BookingTx,
  CurrentApprovals,
  EffectKey,
  InsertProposalInput,
  InsertReservationInput,
  OfferRecord,
  OperationRef,
  ProposalStatus,
  SelectionUpsertInput,
  TripRecord,
} from "@odft/contracts";
import { loadDecision, resolveDecision } from "./decisions.js";
import { readEffect, writeEffect } from "./effects.js";
import { insertEvent } from "./events.js";
import { StaleFencingError } from "./operations/fencing.js";
import { loadOperationById } from "./operations.js";
import { getProposal, insertProposal, markProposalResolved } from "./proposals.js";
import {
  getActiveReservation,
  getReservationByConfirmationKey,
  insertReservationWithGeneratedReference,
  supersedeReservation,
} from "./reservations.js";
import { currentApprovalGuard } from "./scenario/validations.js";
import { lockTrip, upsertSelection } from "./trips.js";

/** Postgres-backed implementation of the `BookingStore` port (one tx per call). */
export class PostgresBookingStore implements BookingStore {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(fn: (tx: BookingTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tx = new PostgresBookingTx(client);
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Do not let a dead-connection rollback mask the original error.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

const VALID_VARIANTS = new Set(["one_night", "two_nights"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLegacyOffer(
  inventory: Record<string, unknown>,
  serviceKey: BookableKey,
  offerId: string,
): Record<string, unknown> | undefined {
  const offers = inventory["offers"];
  if (!isRecord(offers)) {
    return undefined;
  }
  const byService = offers[serviceKey];
  if (!isRecord(byService)) {
    return undefined;
  }
  const offer = byService[offerId];
  return isRecord(offer) ? offer : undefined;
}

function findById(list: unknown, id: string): Record<string, unknown> | undefined {
  if (!Array.isArray(list)) {
    return undefined;
  }
  return list.find((entry) => isRecord(entry) && entry["id"] === id) as
    Record<string, unknown> | undefined;
}

function findMeal(
  list: unknown,
  meal: BookableKey,
  id: string,
): Record<string, unknown> | undefined {
  if (!Array.isArray(list)) {
    return undefined;
  }
  return list.find((entry) => isRecord(entry) && entry["id"] === id && entry["meal"] === meal) as
    Record<string, unknown> | undefined;
}

function readContext(inventory: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(inventory["context"]) ? inventory["context"] : undefined;
}

function readContextVariant(
  inventory: Record<string, unknown>,
): "one_night" | "two_nights" | undefined {
  const variant = readContext(inventory)?.["travelVariant"];
  return typeof variant === "string" && VALID_VARIANTS.has(variant)
    ? (variant as "one_night" | "two_nights")
    : undefined;
}

function readContextAdults(inventory: Record<string, unknown>): number | undefined {
  const adults = readContext(inventory)?.["adults"];
  return typeof adults === "number" ? adults : undefined;
}

function buildOfferRecord(
  offerId: string,
  serviceKey: BookableKey,
  snapshotId: string,
  raw: Record<string, unknown>,
): OfferRecord | undefined {
  if (typeof raw["partyTotalMinor"] !== "number" || typeof raw["adults"] !== "number") {
    return undefined;
  }
  const variants = Array.isArray(raw["supportedVariants"])
    ? raw["supportedVariants"].filter((value): value is string => typeof value === "string")
    : [];
  if (variants.length === 0 || !variants.every((variant) => VALID_VARIANTS.has(variant))) {
    return undefined;
  }
  return {
    offerId,
    serviceKey,
    snapshotId,
    partyTotalMinor: raw["partyTotalMinor"],
    adults: raw["adults"],
    supportedVariants: variants as ("one_night" | "two_nights")[],
    synthetic: true,
  };
}

class PostgresBookingTx implements BookingTx {
  constructor(private readonly client: PoolClient) {}

  lockTrip(tripId: string): Promise<TripRecord | undefined> {
    return lockTrip(this.client, tripId);
  }

  loadOperation(operationId: string): Promise<OperationRef | undefined> {
    return loadOperationById(this.client, operationId);
  }

  async assertOperationOwnership(
    operationId: string,
    tripId: string,
    fencingToken: string,
  ): Promise<void> {
    const result = await this.client.query(
      `SELECT 1 FROM odft_app.workflow_operations
        WHERE id = $1 AND trip_id = $2 AND fencing_token = $3::bigint
        FOR SHARE`,
      [operationId, tripId, fencingToken],
    );
    if (result.rowCount !== 1) {
      throw new StaleFencingError(operationId);
    }
  }

  async loadCurrentApprovals(tripId: string): Promise<CurrentApprovals> {
    return currentApprovalGuard(this.client, tripId);
  }

  loadDecision(decisionId: string) {
    return loadDecision(this.client, decisionId);
  }

  loadProposal(tripId: string, proposalId: string) {
    return getProposal(this.client, tripId, proposalId);
  }

  async loadOffer(
    snapshotId: string,
    serviceKey: BookableKey,
    offerId: string,
  ): Promise<OfferRecord | undefined> {
    const result = await this.client.query<{ inventory: unknown }>(
      `SELECT inventory FROM odft_app.scenario_snapshots WHERE id = $1`,
      [snapshotId],
    );
    const inventory = result.rows[0]?.inventory as Record<string, unknown> | null | undefined;
    if (!inventory) {
      return undefined;
    }

    // Phase 03 fixture shape: inventory.offers[serviceKey][offerId].
    const legacy = readLegacyOffer(inventory, serviceKey, offerId);
    if (legacy) {
      return buildOfferRecord(offerId, serviceKey, snapshotId, legacy);
    }

    // Phase 04 SnapshotContent shape: flights/hotels/restaurants arrays.
    const contextVariant = readContextVariant(inventory);
    if (serviceKey === "flights") {
      const combination = findById(inventory["flights"], offerId);
      if (combination) {
        return buildOfferRecord(offerId, serviceKey, snapshotId, combination);
      }
      return undefined;
    }
    if (serviceKey === "hotel") {
      const hotel = findById(inventory["hotels"], offerId);
      if (hotel && contextVariant) {
        return buildOfferRecord(offerId, serviceKey, snapshotId, {
          ...hotel,
          supportedVariants: [contextVariant],
          adults: hotel["adults"],
        });
      }
      return undefined;
    }
    const meal = findMeal(inventory["restaurants"], serviceKey, offerId);
    if (meal && contextVariant) {
      return buildOfferRecord(offerId, serviceKey, snapshotId, {
        ...meal,
        supportedVariants: [contextVariant],
        adults: readContextAdults(inventory),
      });
    }
    return undefined;
  }

  getActiveReservation(tripId: string, serviceKey: BookableKey) {
    return getActiveReservation(this.client, tripId, serviceKey);
  }

  getReservationByConfirmationKey(tripId: string, confirmationKey: string) {
    return getReservationByConfirmationKey(this.client, tripId, confirmationKey);
  }

  async supersedeProposals(tripId: string, serviceKey: BookableKey): Promise<void> {
    await this.client.query(
      `UPDATE odft_app.selection_proposals SET status = 'superseded', resolved_at = now()
        WHERE trip_id = $1 AND service_key = $2 AND status = 'proposed'`,
      [tripId, serviceKey],
    );
  }

  insertProposal(input: InsertProposalInput) {
    return insertProposal(this.client, input);
  }

  markProposalResolved(proposalId: string, status: ProposalStatus) {
    return markProposalResolved(this.client, proposalId, status);
  }

  resolveDecision(decisionId: string): Promise<void> {
    return resolveDecision(this.client, decisionId, "resolved");
  }

  supersedeReservation(reservationId: string, supersededBy?: string) {
    return supersedeReservation(this.client, reservationId, supersededBy);
  }

  insertReservationWithGeneratedReference(
    input: InsertReservationInput,
    generateReference: (service: BookableKey) => string,
    attempts: number,
  ) {
    return insertReservationWithGeneratedReference(this.client, input, generateReference, attempts);
  }

  upsertSelection(input: SelectionUpsertInput): Promise<void> {
    return upsertSelection(this.client, input);
  }

  recordEvent(input: BookingEventInput): Promise<void> {
    return insertEvent(this.client, {
      tripId: input.tripId,
      type: input.type,
      payload: input.payload,
    });
  }

  readEffect(key: EffectKey) {
    return readEffect(this.client, key);
  }

  writeEffect(key: EffectKey, result: unknown) {
    return writeEffect(this.client, key, result);
  }
}
