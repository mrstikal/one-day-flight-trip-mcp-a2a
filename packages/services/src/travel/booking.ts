import type { Pool } from "pg";
import { BookingService, fingerprint } from "@odft/domain";
import {
  getActiveReservation,
  getTrip,
  planProgramSelections,
  PostgresBookingStore,
  recordPreferredActivities,
  removeProgramSelections,
  setSelfArrangedState,
  upsertProgramSelections,
  validateTripLogistics,
} from "@odft/persistence";
import type { OperationAuthority } from "../ai/authority.js";
import { fencingContextFor } from "../ai/authority.js";
import type {
  BookableKey,
  DeclinedBookingResult,
  LogisticsResult,
  Meal,
  MealSelections,
  ProgramResult,
  ProposalResult,
  ReservationResult,
  ServiceEventWriter,
} from "./types.js";

/**
 * Phase 02 booking service: proposals, demo confirmations, replacements,
 * declines, the meal/activity program and the selected-logistics check.
 *
 * BookingService keeps its own independent short transactions (Phase 02 step 2);
 * this module adds no transaction around or across its calls.
 */

export interface TravelBookingServiceDeps {
  readonly pool: Pool;
  readonly authority: OperationAuthority;
  readonly writeEvent: ServiceEventWriter;
}

export interface TravelBookingService {
  propose(input: {
    tripId: string;
    operationId: string;
    service: BookableKey;
    offerId: string;
    sourceFingerprint: string;
  }): Promise<ProposalResult>;
  confirm(input: {
    tripId: string;
    operationId: string;
    proposalId: string;
    decisionId: string;
    acceptedRevision: number;
    confirmationKey: string;
  }): Promise<ReservationResult>;
  /** Replace a confirmed reservation with a staged replacement proposal. */
  replace(input: {
    tripId: string;
    operationId: string;
    service: BookableKey;
    proposalId: string;
    decisionId: string;
    acceptedRevision: number;
    confirmationKey: string;
  }): Promise<ReservationResult>;
  /**
   * Phase 12 "I don't want to book": decline the staged flight/hotel booking but
   * keep the offer as the persisted selection (no reservation is created).
   */
  declineBooking(input: {
    tripId: string;
    operationId: string;
    proposalId: string;
    decisionId: string;
  }): Promise<DeclinedBookingResult>;
  /** Phase 07: apply a `submit_program` selection without moving bookings. */
  applyProgram(input: {
    tripId: string;
    operationId: string;
    mealSelections: MealSelections;
    /** Meals the traveler arranges themselves: never selected or planned. */
    selfArrangedMeals: Meal[];
    preferredActivityIds: string[];
    /** Activities the traveler arranges themselves: never planned. */
    activitiesSelfArranged: boolean;
  }): Promise<ProgramResult>;
  /**
   * Validate a program without writing anything. Callers use it before
   * committing the rest of a command batch, so a deterministic conflict (for
   * example removing a confirmed meal) cannot leave preferences applied.
   */
  validateProgram(input: {
    tripId: string;
    mealSelections: MealSelections;
    selfArrangedMeals: Meal[];
  }): Promise<void>;
  /** Phase 07: deterministic hotel/airport transfer and confirmed-meal window check. */
  validateSelectedLogistics(input: { tripId: string }): Promise<LogisticsResult>;
}

export function createTravelBookingService(deps: TravelBookingServiceDeps): TravelBookingService {
  const { pool, authority, writeEvent } = deps;
  const booking = new BookingService(new PostgresBookingStore(pool));

  return {
    async propose(input) {
      const trip = await getTrip(pool, input.tripId);
      if (!trip) {
        throw new Error(`trip ${input.tripId} not found while staging a proposal`);
      }
      return booking.propose({
        tripId: input.tripId,
        sessionId: trip.sessionId,
        service: input.service,
        offerId: input.offerId,
        operationId: input.operationId,
        sourceFingerprint: input.sourceFingerprint,
        fencingToken: authority.fencingToken,
      });
    },

    async confirm(input) {
      const trip = await getTrip(pool, input.tripId);
      if (!trip) {
        throw new Error(`trip ${input.tripId} not found while confirming a booking`);
      }
      return booking.confirm({
        tripId: input.tripId,
        sessionId: trip.sessionId,
        proposalId: input.proposalId,
        decisionId: input.decisionId,
        operationId: input.operationId,
        acceptedRevision: input.acceptedRevision,
        confirmationKey: input.confirmationKey,
        acceptedDemoDisclaimer: true,
        fencingToken: authority.fencingToken,
      });
    },

    async replace(input) {
      const trip = await getTrip(pool, input.tripId);
      if (!trip) {
        throw new Error(`trip ${input.tripId} not found while confirming a replacement`);
      }
      const active = await getActiveReservation(pool, input.tripId, input.service);
      if (!active) {
        throw new Error(`no active ${input.service} reservation to replace`);
      }
      return booking.replaceConfirmed({
        tripId: input.tripId,
        sessionId: trip.sessionId,
        proposalId: input.proposalId,
        decisionId: input.decisionId,
        operationId: input.operationId,
        acceptedRevision: input.acceptedRevision,
        confirmationKey: input.confirmationKey,
        acceptedDemoDisclaimer: true,
        affectedReservationId: active.id,
        fencingToken: authority.fencingToken,
      });
    },

    async declineBooking(input) {
      const trip = await getTrip(pool, input.tripId);
      if (!trip) {
        throw new Error(`trip ${input.tripId} not found while declining a booking`);
      }
      return booking.declineBooking({
        tripId: input.tripId,
        sessionId: trip.sessionId,
        proposalId: input.proposalId,
        decisionId: input.decisionId,
        operationId: input.operationId,
        fencingToken: authority.fencingToken,
      });
    },

    async validateProgram(input) {
      await planProgramSelections(pool, {
        tripId: input.tripId,
        mealSelections: input.mealSelections,
        selfArrangedMeals: input.selfArrangedMeals,
      });
    },

    async applyProgram(input) {
      const plan = await planProgramSelections(pool, {
        tripId: input.tripId,
        mealSelections: input.mealSelections,
        selfArrangedMeals: input.selfArrangedMeals,
      });
      let firstReplacement: {
        proposalId: string;
        service: (typeof plan.replacements)[number]["serviceKey"];
        sourceFingerprint: string;
      } | null = null;
      for (const replacement of plan.replacements) {
        const trip = await getTrip(pool, input.tripId);
        if (!trip) {
          throw new Error(`trip ${input.tripId} not found while staging a meal replacement`);
        }
        const sourceFingerprint = fingerprint({
          kind: "replacement_confirmation",
          tripId: input.tripId,
          operationId: input.operationId,
          service: replacement.serviceKey,
          offerId: replacement.offerId,
        });
        const proposal = await booking.propose({
          tripId: input.tripId,
          sessionId: trip.sessionId,
          service: replacement.serviceKey,
          offerId: replacement.offerId,
          operationId: input.operationId,
          sourceFingerprint,
          fencingToken: authority.fencingToken,
        });
        firstReplacement ??= {
          proposalId: proposal.proposalId,
          service: replacement.serviceKey,
          sourceFingerprint,
        };
      }
      const fence = fencingContextFor(authority, input.operationId, input.tripId);
      await upsertProgramSelections(pool, input.tripId, plan.selections, fence);
      // A meal the traveler now arranges themselves loses its unbooked selection
      // (planProgramSelections refused this for any confirmed reservation).
      await removeProgramSelections(pool, input.tripId, plan.selfArrangedMeals, fence);
      await setSelfArrangedState(
        pool,
        input.tripId,
        {
          meals: plan.selfArrangedMeals,
          activities: input.activitiesSelfArranged,
        },
        fence,
      );
      // Self-arranged activities keep the previously recorded preferences (they
      // return unchanged when the traveler opts back in).
      if (!input.activitiesSelfArranged) {
        await recordPreferredActivities(
          pool,
          {
            tripId: input.tripId,
            preferredActivityIds: input.preferredActivityIds,
          },
          fence,
        );
      }
      await writeEvent({ type: "program.saved", payload: {} });
      return {
        applied: true,
        replacementStaged: firstReplacement !== null,
        replacementProposalId: firstReplacement?.proposalId ?? null,
        replacementService: firstReplacement?.service ?? null,
        replacementSourceFingerprint: firstReplacement?.sourceFingerprint ?? null,
      };
    },

    async validateSelectedLogistics(input) {
      return validateTripLogistics(pool, input.tripId);
    },
  };
}
