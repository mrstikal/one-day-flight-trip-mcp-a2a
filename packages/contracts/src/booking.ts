import type {
  BookableKey,
  DecisionKind,
  ProposalStatus,
  ReservationStatus,
  TravelVariant,
} from "./enums.js";
import type { TripPreferences } from "./preferences.js";

/**
 * Shared booking persistence port types. Living in `@odft/contracts` keeps the
 * domain service (orchestration) and the persistence adapter (SQL) decoupled
 * without a domain<->persistence dependency edge.
 */

export interface TripRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly adults: number;
  readonly originAirportId: string;
  readonly destinationCityId: string;
  readonly destinationCountryKey: string;
  readonly sightseeingDate: string;
  readonly travelVariant: TravelVariant;
  readonly preferences: TripPreferences;
  readonly activeScenarioSnapshotId?: string;
  readonly currentRouteValidationId?: string;
  readonly currentScheduleValidationId?: string;
  readonly workflowStatus: string;
  readonly recoveryRequired: boolean;
  /** Failed unfinished operation the owner must recover (set with recoveryRequired). */
  readonly lastUnfinishedOperationId?: string;
}

export interface OfferRecord {
  readonly offerId: string;
  readonly serviceKey: BookableKey;
  readonly snapshotId: string;
  readonly partyTotalMinor: number;
  readonly adults: number;
  readonly supportedVariants: TravelVariant[];
  readonly synthetic: true;
}

/** Immutable terms snapshot persisted with a confirmed reservation. */
export interface ReservationTerms {
  readonly snapshotId: string;
  readonly offerContentHash: string;
  readonly serviceKey: BookableKey;
  readonly sightseeingDate: string;
  readonly travelVariant: TravelVariant;
  readonly nights: number;
  readonly adults: number;
  readonly partyTotalMinor: number;
  readonly demoLabels: readonly string[];
  readonly disclaimerAcknowledged: true;
}

export interface OperationRef {
  readonly id: string;
  readonly tripId: string;
  readonly status: string;
  readonly acceptedRevision: number;
}

export interface SelectionUpsertInput {
  readonly tripId: string;
  readonly serviceKey: BookableKey;
  readonly offerId: string;
  readonly snapshotId: string;
  readonly selectedBy: "user" | "default";
  readonly sourceFingerprint: string;
  /** Null for a declined booking ("I don't want to book"): selection only. */
  readonly activeProposalId: string | null;
  readonly activeReservationId: string | null;
}

export interface BookingEventInput {
  readonly tripId: string;
  readonly type: string;
  readonly payload: unknown;
}

export interface ProposalRecord {
  readonly id: string;
  readonly tripId: string;
  readonly serviceKey: BookableKey;
  readonly offerId: string;
  readonly snapshotId: string;
  readonly status: ProposalStatus;
  readonly partyTotalMinor: number;
  readonly expiresAt: string;
  readonly sourceFingerprint: string;
}

export interface ReservationRecord {
  readonly id: string;
  readonly tripId: string;
  readonly serviceKey: BookableKey;
  readonly offerId: string;
  readonly snapshotId: string;
  readonly status: ReservationStatus;
  readonly demoReference: string;
  readonly confirmationKey: string;
  readonly proposalId: string;
  readonly decisionId: string;
  readonly termsHash: string;
  readonly partyTotalMinor: number;
}

export interface DecisionBindingRecord {
  readonly id: string;
  readonly tripId: string;
  readonly kind: DecisionKind;
  readonly proposalId?: string;
  readonly status: "pending" | "resolved" | "cancelled";
  readonly sourceFingerprint: string;
  readonly allowedOfferIds: string[];
  /** Option ids a `choose_option` response may select (empty = not offered). */
  readonly allowedOptionIds?: string[];
}

export interface InsertProposalInput {
  readonly tripId: string;
  readonly serviceKey: BookableKey;
  readonly offerId: string;
  readonly snapshotId: string;
  readonly partyTotalMinor: number;
  readonly expiresAt: string;
  readonly sourceFingerprint: string;
}

export interface InsertReservationInput {
  readonly id: string;
  readonly tripId: string;
  readonly serviceKey: BookableKey;
  readonly offerId: string;
  readonly snapshotId: string;
  readonly proposalId: string;
  readonly decisionId: string;
  readonly confirmationKey: string;
  readonly termsHash: string;
  readonly terms: ReservationTerms;
  readonly partyTotalMinor: number;
}

export interface EffectKey {
  readonly operationId: string;
  readonly nodeName: string;
  readonly effectScope: string;
}

/** Current approval status plus the independent route/schedule freshness checks. */
export interface CurrentApprovals {
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

/** One database transaction's operations, implemented by `@odft/persistence`. */
export interface BookingTx {
  lockTrip(tripId: string): Promise<TripRecord | undefined>;
  loadOperation(operationId: string): Promise<OperationRef | undefined>;
  /**
   * Take a shared lock on the operation row and require the exact fencing token.
   * Used by booking writes so a stale worker cannot mutate domain state after a
   * takeover. Throws (fencing loss) when the token does not match.
   */
  assertOperationOwnership(
    operationId: string,
    tripId: string,
    fencingToken: string,
  ): Promise<void>;
  loadCurrentApprovals(tripId: string): Promise<CurrentApprovals>;
  loadDecision(decisionId: string): Promise<DecisionBindingRecord | undefined>;
  loadProposal(tripId: string, proposalId: string): Promise<ProposalRecord | undefined>;
  loadOffer(
    snapshotId: string,
    serviceKey: BookableKey,
    offerId: string,
  ): Promise<OfferRecord | undefined>;
  getActiveReservation(
    tripId: string,
    serviceKey: BookableKey,
  ): Promise<ReservationRecord | undefined>;
  getReservationByConfirmationKey(
    tripId: string,
    confirmationKey: string,
  ): Promise<ReservationRecord | undefined>;
  supersedeProposals(tripId: string, serviceKey: BookableKey): Promise<void>;
  insertProposal(input: InsertProposalInput): Promise<ProposalRecord>;
  markProposalResolved(proposalId: string, status: ProposalStatus): Promise<void>;
  resolveDecision(decisionId: string): Promise<void>;
  supersedeReservation(reservationId: string, supersededBy?: string): Promise<void>;
  insertReservationWithGeneratedReference(
    input: InsertReservationInput,
    generateReference: (service: BookableKey) => string,
    attempts: number,
  ): Promise<ReservationRecord>;
  upsertSelection(input: SelectionUpsertInput): Promise<void>;
  recordEvent(input: BookingEventInput): Promise<void>;
  readEffect(key: EffectKey): Promise<unknown | undefined>;
  writeEffect(key: EffectKey, result: unknown): Promise<void>;
}

export interface BookingStore {
  transaction<T>(fn: (tx: BookingTx) => Promise<T>): Promise<T>;
}

export interface ProposalResult {
  readonly status: "proposed";
  readonly proposalId: string;
  readonly serviceKey: BookableKey;
  readonly offerId: string;
  readonly partyTotalMinor: number;
  readonly expiresAt: string;
}

export interface ReservationResult {
  readonly status: "confirmed";
  readonly reservationId: string;
  readonly demoReference: string;
  readonly serviceKey: BookableKey;
  readonly offerId: string;
  readonly partyTotalMinor: number;
  readonly idempotent: boolean;
}

/**
 * Phase 12 "I don't want to book": the staged flight/hotel booking was declined
 * and the offer kept as the trip's selection. No reservation exists; the plan is
 * built as if it did and it can be booked later.
 */
export interface DeclinedBookingResult {
  readonly status: "declined";
  readonly serviceKey: BookableKey;
  readonly offerId: string;
  readonly idempotent: boolean;
}

export interface DeclineBookingInput {
  readonly tripId: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly proposalId: string;
  readonly decisionId: string;
  readonly fencingToken?: string;
}

export interface ProposeSelectionInput {
  readonly tripId: string;
  readonly sessionId: string;
  readonly service: BookableKey;
  readonly offerId: string;
  readonly operationId: string;
  readonly sourceFingerprint: string;
  /** Fencing token of the claiming worker; when set, the write is fenced. */
  readonly fencingToken?: string;
  readonly expiresInMs?: number;
}

export interface ConfirmBookingInput {
  readonly tripId: string;
  readonly sessionId: string;
  readonly proposalId: string;
  readonly decisionId: string;
  readonly operationId: string;
  readonly acceptedRevision: number;
  readonly acceptedDemoDisclaimer: true;
  readonly confirmationKey: string;
  /** Fencing token of the claiming worker; when set, the write is fenced. */
  readonly fencingToken?: string;
}

export interface ReplaceConfirmedInput extends ConfirmBookingInput {
  readonly affectedReservationId: string;
}
