import { randomUUID } from "node:crypto";
import type {
  BookableKey,
  BookingStore,
  BookingTx,
  ConfirmBookingInput,
  DecisionKind,
  DeclineBookingInput,
  DeclinedBookingResult,
  EffectKey,
  ProposalResult,
  ProposeSelectionInput,
  ReplaceConfirmedInput,
  ReservationRecord,
  ReservationResult,
  ReservationTerms,
  TripRecord,
} from "@odft/contracts";
import { nightsForVariant } from "../dates.js";
import { DomainError } from "../errors.js";
import { fingerprint } from "../fingerprints.js";
import { isProposalActionable } from "./lifecycle.js";
import { DEMO_REFERENCE_ATTEMPTS, generateDemoReference } from "./references.js";

/**
 * Deterministic booking orchestration over a persistence port.
 *
 * `BookingService` is the only code path allowed to create/supersede/cancel a
 * demo reservation. The atomic SQL (savepoint-bounded references, partial unique
 * index ordering) lives behind the injected `BookingStore` port, so this module
 * stays free of DB imports.
 */

const DEFAULT_PROPOSAL_TTL_MS = 30 * 60 * 1000;

export class BookingService {
  constructor(
    private readonly store: BookingStore,
    private readonly options: { now?: () => Date } = {},
  ) {}

  generateDemoReference(service: BookableKey, randomHex?: () => string): string {
    return randomHex ? generateDemoReference(service, randomHex) : generateDemoReference(service);
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  async propose(input: ProposeSelectionInput): Promise<ProposalResult> {
    return this.store.transaction(async (tx) => {
      const trip = await this.requireTrip(tx, input.tripId, input.sessionId);
      const operation = await tx.loadOperation(input.operationId);
      if (!operation || operation.tripId !== input.tripId) {
        throw new DomainError("CONFLICT", "proposal requires an admitted operation for this trip");
      }
      if (operation.status === "failed" || operation.status === "cancelled") {
        throw new DomainError("CONFLICT", "operation is no longer active");
      }
      if (input.fencingToken) {
        await tx.assertOperationOwnership(input.operationId, input.tripId, input.fencingToken);
      }
      // Idempotent effect: a crash-replay returns the stored proposal instead of
      // superseding it and minting a new id with a fresh expiry.
      const effectKey: EffectKey = {
        operationId: input.operationId,
        nodeName: "stage_selection",
        effectScope: `${input.service}:${input.offerId}`,
      };
      const stored = await tx.readEffect(effectKey);
      if (stored !== undefined) {
        if (!isProposalResult(stored)) {
          throw new DomainError("INTERNAL_ERROR", "stored proposal effect is malformed");
        }
        return stored;
      }
      const snapshotId = trip.activeScenarioSnapshotId;
      if (!snapshotId) {
        throw new DomainError("OFFER_UNAVAILABLE", "trip has no active scenario snapshot");
      }
      const offer = await tx.loadOffer(snapshotId, input.service, input.offerId);
      if (!offer) {
        throw new DomainError(
          "OFFER_UNAVAILABLE",
          `offer ${input.offerId} is not in the active snapshot`,
        );
      }
      this.assertOfferMatchesTrip(offer, trip);
      const expiresAt = new Date(
        this.now().getTime() + (input.expiresInMs ?? DEFAULT_PROPOSAL_TTL_MS),
      ).toISOString();
      // A new review supersedes any previous proposal for the same service.
      await tx.supersedeProposals(input.tripId, input.service);
      const proposal = await tx.insertProposal({
        tripId: input.tripId,
        serviceKey: input.service,
        offerId: offer.offerId,
        snapshotId,
        partyTotalMinor: offer.partyTotalMinor,
        expiresAt,
        sourceFingerprint: input.sourceFingerprint,
      });
      const result: ProposalResult = {
        status: "proposed",
        proposalId: proposal.id,
        serviceKey: proposal.serviceKey,
        offerId: proposal.offerId,
        partyTotalMinor: proposal.partyTotalMinor,
        expiresAt: proposal.expiresAt,
      };
      await tx.writeEffect(effectKey, result);
      return result;
    });
  }

  confirm(input: ConfirmBookingInput): Promise<ReservationResult> {
    return this.runConfirmation(input, false);
  }

  replaceConfirmed(input: ReplaceConfirmedInput): Promise<ReservationResult> {
    return this.runConfirmation(input, true);
  }

  /**
   * Phase 12 "I don't want to book": decline the staged flight/hotel booking
   * while keeping the offer as the trip's selection. No reservation is created
   * and the proposal is closed as rejected; the plan treats the service exactly
   * as if it existed, and the selection can still be booked later.
   */
  async declineBooking(input: DeclineBookingInput): Promise<DeclinedBookingResult> {
    return this.store.transaction(async (tx) => {
      const effectKey: EffectKey = {
        operationId: input.operationId,
        nodeName: "decline_booking",
        effectScope: input.proposalId,
      };
      // Lock the trip first so concurrent duplicate declines serialize; the loser
      // then observes the stored effect instead of racing.
      await this.requireTrip(tx, input.tripId, input.sessionId);
      const operation = await tx.loadOperation(input.operationId);
      if (!operation || operation.tripId !== input.tripId) {
        throw new DomainError("CONFLICT", "operation is not admitted for this trip");
      }
      if (operation.status === "failed" || operation.status === "cancelled") {
        throw new DomainError("CONFLICT", "operation is no longer active");
      }
      if (input.fencingToken) {
        await tx.assertOperationOwnership(input.operationId, input.tripId, input.fencingToken);
      }
      const stored = await tx.readEffect(effectKey);
      if (stored !== undefined) {
        if (!isDeclinedBookingResult(stored)) {
          throw new DomainError("INTERNAL_ERROR", "stored decline effect is malformed");
        }
        await tx.resolveDecision(input.decisionId);
        return { ...stored, idempotent: true };
      }

      const decision = await tx.loadDecision(input.decisionId);
      if (!decision || decision.tripId !== input.tripId || decision.status !== "pending") {
        throw new DomainError(
          "STALE_DECISION",
          "decision is missing, resolved, or owned by another trip",
        );
      }
      if (decision.kind !== "booking_confirmation") {
        throw new DomainError("STALE_DECISION", "decision kind must be booking_confirmation");
      }
      if (decision.proposalId !== input.proposalId) {
        throw new DomainError("STALE_DECISION", "decision is not bound to the requested proposal");
      }
      const proposal = await tx.loadProposal(input.tripId, input.proposalId);
      if (!proposal) {
        throw new DomainError("STALE_DECISION", "proposal not found");
      }
      if (decision.sourceFingerprint !== proposal.sourceFingerprint) {
        throw new DomainError("STALE_DECISION", "decision fingerprint does not match the proposal");
      }
      if (proposal.serviceKey !== "flights" && proposal.serviceKey !== "hotel") {
        throw new DomainError(
          "CONFLICT",
          "only a flight or hotel booking can be declined and kept as a selection",
        );
      }
      if (!isProposalActionable(proposal.status)) {
        throw new DomainError("STALE_DECISION", `proposal is ${proposal.status}`);
      }
      if (Date.parse(proposal.expiresAt) <= this.now().getTime()) {
        throw new DomainError("PROPOSAL_EXPIRED", "proposal has expired");
      }

      const result: DeclinedBookingResult = {
        status: "declined",
        serviceKey: proposal.serviceKey,
        offerId: proposal.offerId,
        idempotent: false,
      };
      // The declined offer becomes the trip's selection: the plan is built as if
      // the service existed, and the overviews mark it "Not booked".
      await tx.upsertSelection({
        tripId: input.tripId,
        serviceKey: proposal.serviceKey,
        offerId: proposal.offerId,
        snapshotId: proposal.snapshotId,
        selectedBy: "user",
        sourceFingerprint: proposal.sourceFingerprint,
        activeProposalId: null,
        activeReservationId: null,
      });
      await tx.markProposalResolved(proposal.id, "rejected");
      await tx.resolveDecision(input.decisionId);
      await tx.recordEvent({
        tripId: input.tripId,
        type: "booking.declined",
        payload: {
          serviceKey: proposal.serviceKey,
          offerId: proposal.offerId,
        },
      });
      await tx.writeEffect(effectKey, result);
      return result;
    });
  }

  private async runConfirmation(
    input: ConfirmBookingInput | ReplaceConfirmedInput,
    replacement: boolean,
  ): Promise<ReservationResult> {
    try {
      return await this.performConfirmation(input, replacement);
    } catch (error) {
      // Persist proposal withdrawal after the failed transaction has rolled back,
      // so no nested transaction is opened while the trip lock is held.
      if (error instanceof DomainError && error.code === "PROPOSAL_EXPIRED") {
        await this.withdraw(input.tripId, input.proposalId, "expired");
      } else if (error instanceof DomainError && error.code === "OFFER_UNAVAILABLE") {
        await this.withdraw(input.tripId, input.proposalId, "rejected");
      } else if (error instanceof DomainError && error.code === "OFFER_MISMATCH") {
        await this.withdraw(input.tripId, input.proposalId, "rejected");
      }
      throw error;
    }
  }

  private async performConfirmation(
    input: ConfirmBookingInput | ReplaceConfirmedInput,
    replacement: boolean,
  ): Promise<ReservationResult> {
    return this.store.transaction(async (tx) => {
      const effectKey: EffectKey = {
        operationId: input.operationId,
        nodeName: "commit_booking",
        effectScope: input.proposalId,
      };

      // Lock the trip first so concurrent duplicate confirmations serialize; the
      // loser then observes the stored effect/reservation instead of racing.
      const trip = await this.requireTrip(tx, input.tripId, input.sessionId);

      // The operation must be admitted, belong to this trip, and match the
      // accepted revision the caller claims.
      const operation = await tx.loadOperation(input.operationId);
      if (!operation || operation.tripId !== input.tripId) {
        throw new DomainError("CONFLICT", "operation is not admitted for this trip");
      }
      if (operation.status === "failed" || operation.status === "cancelled") {
        throw new DomainError("CONFLICT", "operation is no longer active");
      }
      if (operation.acceptedRevision !== input.acceptedRevision) {
        throw new DomainError(
          "STALE_REVISION",
          "operation accepted revision does not match the request",
        );
      }
      if (input.fencingToken) {
        await tx.assertOperationOwnership(input.operationId, input.tripId, input.fencingToken);
      }

      const stored = await tx.readEffect(effectKey);
      if (stored !== undefined) {
        if (!isReservationResult(stored)) {
          throw new DomainError("INTERNAL_ERROR", "stored booking effect is malformed");
        }
        await tx.resolveDecision(input.decisionId);
        return { ...stored, idempotent: true };
      }

      if (trip.revision !== input.acceptedRevision) {
        throw new DomainError(
          "STALE_REVISION",
          "accepted revision does not match the current trip",
        );
      }
      if (input.acceptedDemoDisclaimer !== true) {
        throw new DomainError("DISCLAIMER_REQUIRED", "the demo disclaimer must be acknowledged");
      }

      const expectedKind: DecisionKind = replacement
        ? "replacement_confirmation"
        : "booking_confirmation";
      const decision = await tx.loadDecision(input.decisionId);
      if (!decision || decision.tripId !== input.tripId || decision.status !== "pending") {
        throw new DomainError(
          "STALE_DECISION",
          "decision is missing, resolved, or owned by another trip",
        );
      }
      if (decision.kind !== expectedKind) {
        throw new DomainError("STALE_DECISION", `decision kind must be ${expectedKind}`);
      }
      if (decision.proposalId !== input.proposalId) {
        throw new DomainError("STALE_DECISION", "decision is not bound to the requested proposal");
      }

      const proposal = await tx.loadProposal(input.tripId, input.proposalId);
      if (!proposal) {
        throw new DomainError("STALE_DECISION", "proposal not found");
      }
      if (decision.sourceFingerprint !== proposal.sourceFingerprint) {
        throw new DomainError("STALE_DECISION", "decision fingerprint does not match the proposal");
      }

      // Idempotent paths first: an existing reservation for this confirmation key
      // (bound to the same proposal) or for the same offer returns without a new reference.
      const byKey = await tx.getReservationByConfirmationKey(input.tripId, input.confirmationKey);
      if (byKey) {
        if (byKey.proposalId !== input.proposalId || byKey.serviceKey !== proposal.serviceKey) {
          throw new DomainError(
            "CONFLICT",
            "confirmation key is already bound to another proposal",
          );
        }
        await this.completeEffect(tx, effectKey, proposal.id, byKey, input.decisionId);
        return toResult(byKey, true);
      }

      const active = await tx.getActiveReservation(input.tripId, proposal.serviceKey);
      if (active && active.offerId === proposal.offerId) {
        await this.completeEffect(tx, effectKey, proposal.id, active, input.decisionId);
        return toResult(active, true);
      }
      if (active && !replacement) {
        throw new DomainError(
          "REPLACEMENT_CONFIRMATION_REQUIRED",
          "a different offer is already confirmed for this service",
        );
      }

      // A genuinely new confirmation must act on an actionable, unexpired proposal.
      if (!isProposalActionable(proposal.status)) {
        throw new DomainError("STALE_DECISION", `proposal is ${proposal.status}`);
      }
      if (Date.parse(proposal.expiresAt) <= this.now().getTime()) {
        throw new DomainError("PROPOSAL_EXPIRED", "proposal has expired");
      }

      // Current approvals must be present.
      const approvals = await tx.loadCurrentApprovals(input.tripId);
      if (approvals.routeStatus !== "FEASIBLE" || approvals.scheduleStatus !== "VALID") {
        throw new DomainError(
          "STALE_DECISION",
          "current route/schedule approvals are missing or stale",
        );
      }
      // Independent freshness guard (FR-FEAS-8): the persisted approval must
      // match the fingerprint recomputed from the live route inputs.
      if (
        approvals.routeApprovalFingerprint === null ||
        approvals.currentRouteFingerprint === null ||
        approvals.routeApprovalFingerprint !== approvals.currentRouteFingerprint
      ) {
        throw new DomainError(
          "STALE_ROUTE_APPROVAL",
          "the current route approval does not match the live route inputs and must be revalidated",
        );
      }
      // The current schedule validation must be bound to the same route approval
      // and to the snapshot the proposal was built from.
      if (
        approvals.currentRouteValidationId === null ||
        approvals.scheduleRouteValidationId === null ||
        approvals.scheduleRouteValidationId !== approvals.currentRouteValidationId ||
        approvals.activeSnapshotId === null ||
        approvals.scheduleSnapshotId === null ||
        approvals.scheduleSnapshotId !== approvals.activeSnapshotId ||
        proposal.snapshotId !== approvals.activeSnapshotId
      ) {
        throw new DomainError(
          "STALE_ROUTE_APPROVAL",
          "the current schedule validation is not bound to the current route approval and snapshot",
        );
      }
      // A confirmed flight must be one of the schedule-valid combinations.
      if (proposal.serviceKey === "flights") {
        const validIds = approvals.scheduleValidCombinationIds ?? [];
        if (!validIds.includes(proposal.offerId)) {
          throw new DomainError(
            "STALE_ROUTE_APPROVAL",
            "the proposed flight is not an independently validated schedule combination",
          );
        }
      }

      const offer = await tx.loadOffer(proposal.snapshotId, proposal.serviceKey, proposal.offerId);
      if (!offer) {
        throw new DomainError(
          "OFFER_UNAVAILABLE",
          "the proposed offer is no longer in the snapshot",
        );
      }
      this.assertOfferMatchesTrip(offer, trip);
      if (
        decision.allowedOfferIds.length === 0 ||
        !decision.allowedOfferIds.includes(offer.offerId)
      ) {
        throw new DomainError("STALE_DECISION", "offer is not among the decision's allowed offers");
      }

      const terms: ReservationTerms = {
        snapshotId: proposal.snapshotId,
        offerContentHash: fingerprint({
          snapshotId: proposal.snapshotId,
          offerId: offer.offerId,
          partyTotalMinor: offer.partyTotalMinor,
        }),
        serviceKey: proposal.serviceKey,
        sightseeingDate: trip.sightseeingDate,
        travelVariant: trip.travelVariant,
        nights: nightsForVariant(trip.travelVariant),
        adults: trip.adults,
        partyTotalMinor: offer.partyTotalMinor,
        demoLabels: ["Demo offer", "Simulated price"],
        disclaimerAcknowledged: true,
      };
      const reservationId = randomUUID();
      if (replacement) {
        if (!active) {
          throw new DomainError("CONFLICT", "there is no active reservation to replace");
        }
        if (!("affectedReservationId" in input) || active.id !== input.affectedReservationId) {
          throw new DomainError(
            "CONFLICT",
            "affected reservation does not match the active reservation",
          );
        }
        // Supersede before insert: partial unique indexes are checked immediately.
        await tx.supersedeReservation(active.id, reservationId);
      }

      const reservation = await tx.insertReservationWithGeneratedReference(
        {
          id: reservationId,
          tripId: input.tripId,
          serviceKey: proposal.serviceKey,
          offerId: offer.offerId,
          snapshotId: proposal.snapshotId,
          proposalId: proposal.id,
          decisionId: input.decisionId,
          confirmationKey: input.confirmationKey,
          termsHash: fingerprint(terms),
          terms,
          partyTotalMinor: offer.partyTotalMinor,
        },
        (service) => this.generateDemoReference(service),
        DEMO_REFERENCE_ATTEMPTS,
      );

      await tx.markProposalResolved(proposal.id, "accepted");
      await tx.resolveDecision(input.decisionId);
      await tx.upsertSelection({
        tripId: input.tripId,
        serviceKey: proposal.serviceKey,
        offerId: offer.offerId,
        snapshotId: proposal.snapshotId,
        selectedBy: "user",
        sourceFingerprint: proposal.sourceFingerprint,
        activeProposalId: proposal.id,
        activeReservationId: reservation.id,
      });
      await tx.recordEvent({
        tripId: input.tripId,
        type: "booking.confirmed",
        payload: {
          reservationId: reservation.id,
          serviceKey: proposal.serviceKey,
          demoReference: reservation.demoReference,
        },
      });
      const result = toResult(reservation, false);
      await tx.writeEffect(effectKey, result);
      return result;
    });
  }

  private assertOfferMatchesTrip(
    offer: { adults: number; supportedVariants: readonly string[] },
    trip: TripRecord,
  ): void {
    if (offer.adults !== trip.adults || !offer.supportedVariants.includes(trip.travelVariant)) {
      throw new DomainError("OFFER_MISMATCH", "offer does not match the trip's party/variant");
    }
  }

  private async withdraw(
    tripId: string,
    proposalId: string,
    status: "expired" | "rejected",
  ): Promise<void> {
    // Persist the withdrawal in its own transaction so it survives the throw.
    await this.store.transaction(async (tx) => {
      const proposal = await tx.loadProposal(tripId, proposalId);
      if (proposal && isProposalActionable(proposal.status)) {
        await tx.markProposalResolved(proposalId, status);
      }
    });
  }

  private async completeEffect(
    tx: BookingTx,
    effectKey: EffectKey,
    proposalId: string,
    reservation: ReservationRecord,
    decisionId: string,
  ): Promise<void> {
    const proposal = await tx.loadProposal(reservation.tripId, proposalId);
    if (proposal && isProposalActionable(proposal.status)) {
      await tx.markProposalResolved(proposalId, "accepted");
    }
    await tx.resolveDecision(decisionId);
    await tx.writeEffect(effectKey, toResult(reservation, true));
  }

  private async requireTrip(tx: BookingTx, tripId: string, sessionId: string): Promise<TripRecord> {
    const trip = await tx.lockTrip(tripId);
    if (!trip) {
      throw new DomainError("NOT_FOUND", "trip not found");
    }
    if (trip.sessionId !== sessionId) {
      throw new DomainError("FORBIDDEN", "trip is not owned by this session");
    }
    return trip;
  }
}

function toResult(reservation: ReservationRecord, idempotent: boolean): ReservationResult {
  return {
    status: "confirmed",
    reservationId: reservation.id,
    demoReference: reservation.demoReference,
    serviceKey: reservation.serviceKey,
    offerId: reservation.offerId,
    partyTotalMinor: reservation.partyTotalMinor,
    idempotent,
  };
}

function isProposalResult(value: unknown): value is ProposalResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.status === "proposed" &&
    typeof candidate.proposalId === "string" &&
    typeof candidate.offerId === "string" &&
    typeof candidate.serviceKey === "string" &&
    typeof candidate.partyTotalMinor === "number" &&
    typeof candidate.expiresAt === "string"
  );
}

function isReservationResult(value: unknown): value is ReservationResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.status === "confirmed" &&
    typeof candidate.reservationId === "string" &&
    typeof candidate.demoReference === "string" &&
    typeof candidate.serviceKey === "string"
  );
}

function isDeclinedBookingResult(value: unknown): value is DeclinedBookingResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.status === "declined" &&
    typeof candidate.serviceKey === "string" &&
    typeof candidate.offerId === "string"
  );
}
