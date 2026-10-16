import type {
  DomainCommand,
  IntentResult,
  ItineraryIssue,
  ItineraryMetrics,
  Meal,
  MealSelections,
  ResearchDomain,
  ResearchDomainStatus,
  RouteValidation,
  ScheduleValidation,
  ReservationResult,
  DeclinedBookingResult,
  ProposalResult,
  ProposalStatus,
  TripRecord,
  BookableKey,
  PublicRouteSummary,
  PublicRouteChangeReservation,
  ResearchSearchIntent,
  RouteChangeField,
} from "@odft/contracts";
import type { ItineraryConflictDecision } from "@odft/domain";

/**
 * Server-side dependencies for the production travel graph, passed through the
 * non-checkpointed invocation `context`. Never persisted and never a security
 * boundary. All domain/persistence access goes through these ports so the graph
 * nodes stay orchestration-only (03-langgraph-design.md section 5).
 */

export interface TravelTripContext {
  readonly trip: TripRecord;
}

export interface TravelMaterializedFlights {
  readonly scenarioKey: string;
  readonly snapshotId: string;
}

/** Phase 09: deterministic per-domain research input fingerprints. */
export interface TravelResearchInputs {
  readonly snapshotId: string;
  readonly fingerprints: Record<ResearchDomain, string>;
}

/** Phase 09: one domain's tagged research outcome (never a dataset). */
export interface TravelResearchOutcome {
  readonly domain: ResearchDomain;
  readonly status: ResearchDomainStatus;
  readonly artifactId: string | null;
  readonly offerIds: string[];
  readonly simulatedFailure: boolean;
  readonly reason: string | null;
  readonly attempt: number;
}

export interface TravelRankDomainCandidates {
  readonly domain: ResearchDomain;
  readonly artifactId: string;
  readonly inputFingerprint: string;
  readonly offerIds: readonly string[];
}

export interface TravelRankedServices {
  readonly hotelOfferIds: string[];
  readonly mealOfferIds: {
    readonly breakfast: string[];
    readonly lunch: string[];
    readonly dinner: string[];
  };
  readonly activityIds: string[];
  /** Deterministic default meal offer per meal (null dinner = deterministic no-slot). */
  readonly mealDefaults: {
    readonly breakfast: string | null;
    readonly lunch: string | null;
    readonly dinner: string | null;
  };
  readonly dinnerNotIncludedReason: string | null;
}

/** Phase 09: safe domain timing/attempt event persisted for the projection. */
export interface TravelResearchEvent {
  readonly tripId: string;
  readonly operationId: string;
  readonly domain: ResearchDomain;
  readonly phase: "started" | "finished";
  readonly attempt: number;
  readonly durationMs: number | null;
  readonly status: ResearchDomainStatus | null;
  readonly simulatedFailure: boolean;
  readonly reason: string | null;
  /**
   * The research input fingerprint this result was computed from (finished only).
   * A hash is internal evidence: the projection uses it to select the matching
   * artifact and never exposes it in a public DTO.
   */
  readonly fingerprint: string | null;
}

export interface TravelProgramResult {
  readonly applied: boolean;
  readonly replacementStaged: boolean;
  readonly replacementProposalId: string | null;
  readonly replacementService: BookableKey | null;
  readonly replacementSourceFingerprint: string | null;
}

export interface TravelProgress {
  readonly flightConfirmed: boolean;
  readonly hotelConfirmed: boolean;
  /** Phase 11: services with an active confirmed reservation. */
  readonly confirmedServices: readonly BookableKey[];
  /** Phase 11: services with an active (unbooked) selection. */
  readonly selectedServices: readonly BookableKey[];
  /** Phase 12: the offer each unbooked selection keeps (see `TripProgress`). */
  readonly selectionOfferIds: Readonly<Partial<Record<BookableKey, string>>>;
  /** Phase 11: true when the meal/activity program has been applied. */
  readonly programApplied: boolean;
}

/** Phase 11: one confirmed reservation a route change would cancel. */
export type TravelRouteChangeReservation = PublicRouteChangeReservation;

/** Phase 11: server-built route-change impact preview (safe fields only). */
export interface TravelRouteChangePreview {
  readonly proposalId: string;
  readonly changedFields: readonly RouteChangeField[];
  readonly from: PublicRouteSummary;
  readonly to: PublicRouteSummary;
  readonly affectedReservations: readonly TravelRouteChangeReservation[];
}

export interface TravelLogisticsResult {
  readonly status: "valid" | "conflict";
  readonly reason: string | null;
}

/* ---- Phase 10: itinerary planning, validation, review, approval -------------- */

/**
 * One bounded planning attempt result. The proposal is persisted as an immutable
 * draft version (or rejected before persistence when the planner invented ids);
 * validation errors are normal routing, never an exception.
 */
export interface TravelItineraryPlanResult {
  readonly itineraryId: string | null;
  readonly version: number | null;
  readonly status: "valid" | "invalid";
  readonly errors: readonly ItineraryIssue[];
  readonly warnings: readonly ItineraryIssue[];
  readonly metrics: ItineraryMetrics;
  /** True when the deterministic validator reported `budget_exceeded`. */
  readonly budgetConflict: boolean;
  /** Ready-made conflict decision when the plan is invalid (null when valid). */
  readonly conflictDecision: ItineraryConflictDecision | null;
  readonly simulatedFailure: boolean;
  readonly simulatedFailureNote: string | null;
  readonly mode: "fixture" | "openrouter";
}

export interface TravelItineraryReviewResult {
  readonly verdict: "acceptable" | "revise" | "conflict";
  readonly revisionFingerprint: string;
  readonly suggestions: readonly string[];
  readonly issueCount: number;
  /** Suggested event order (known ids only) passed back to the planner. */
  readonly suggestedOrder: readonly string[];
  /** Suggested order translated to stable planner candidate refIds. */
  readonly suggestedCandidateOrder: readonly string[];
  /**
   * Nonblocking advice, including suppressed repeated or bounded revisions.
   */
  readonly warnings: readonly ItineraryIssue[];
  /** Ready-made decision when the reviewer reported a blocking conflict. */
  readonly conflictDecision: ItineraryConflictDecision | null;
  readonly mode: "fixture" | "openrouter";
}

export interface TravelItineraryApprovalResult {
  readonly itineraryId: string;
  readonly version: number;
}

export interface TravelPorts {
  now(): Date;
  /**
   * Run one idempotent effect through the durable effect ledger. On a replay
   * after a commit-before-checkpoint crash the stored result is returned and the
   * callback never runs again.
   */
  runEffect<T>(nodeName: string, effectScope: string, fn: () => Promise<T>): Promise<T>;

  loadTrip(tripId: string): Promise<TravelTripContext | undefined>;
  /** Apply a whole admitted command batch atomically (idempotent under the effect ledger). */
  applyCommands(input: {
    tripId: string;
    operationId: string;
    commands: readonly DomainCommand[];
  }): Promise<{ routeChanged: boolean; appliedCount: number }>;
  evaluateRoute(tripId: string): Promise<RouteValidation>;
  materializeFlights(tripId: string): Promise<TravelMaterializedFlights | undefined>;
  validateSchedules(input: { tripId: string; snapshotId: string }): Promise<ScheduleValidation>;
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

  /** Phase 07/09: idempotently materialize hotels/meals/activities/events. */
  ensureDomains(tripId: string): Promise<{ materializedDomains: string[]; snapshotId: string }>;
  /** Phase 09: deterministic per-domain research input fingerprints (the
   * operation id resolves operation-scoped fault overlays exactly as the task will). */
  loadResearchInputs(
    tripId: string,
    operationId: string,
    searchIntent?: ResearchSearchIntent | null,
  ): Promise<TravelResearchInputs>;
  /** Phase 09: research one domain (provider + idempotent artifact write). */
  researchDomain(input: {
    tripId: string;
    operationId: string;
    domain: ResearchDomain;
    attempt: number;
    inputFingerprint: string;
    /** Phase 11: operation-scoped level override / cheaper comparison. */
    searchIntent?: ResearchSearchIntent | null;
  }): Promise<TravelResearchOutcome>;
  /** Phase 09: deterministic re-filter/re-order + artifact persistence. */
  rankRecommendations(input: {
    tripId: string;
    operationId: string;
    domains: readonly TravelRankDomainCandidates[];
    /** Phase 11: operation-scoped level override / cheaper comparison. */
    searchIntent?: ResearchSearchIntent | null;
  }): Promise<TravelRankedServices>;
  /** Phase 09: persist one safe domain timing/attempt event. */
  recordResearchEvent(event: TravelResearchEvent): Promise<void>;
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
  }): Promise<TravelProgramResult>;
  /** Phase 07: deterministic hotel/airport transfer and confirmed-meal window check. */
  validateSelectedLogistics(input: { tripId: string }): Promise<TravelLogisticsResult>;
  /** Confirmed flight/hotel progress so a preference change resumes at the right step. */
  loadProgress(tripId: string): Promise<TravelProgress>;

  /**
   * Phase 11: compute the impact of a `set_route` batch without applying it.
   * Returns the confirmed reservations that would be cancelled (empty when the
   * change is safe to apply directly) and a deterministic proposal id.
   */
  previewRouteChange(input: {
    tripId: string;
    operationId: string;
    commands: readonly DomainCommand[];
  }): Promise<TravelRouteChangePreview>;
  /**
   * Phase 11: apply a confirmed route change atomically — the deferred command
   * batch is applied and the named confirmed reservations are cancelled in one
   * transaction. The route/schedule validations are re-run from scratch by the
   * graph afterwards.
   */
  commitRouteChange(input: {
    tripId: string;
    operationId: string;
    decisionId: string;
    acceptedRevision: number;
    proposalId: string;
    affectedReservationIds: readonly string[];
    commands: readonly DomainCommand[];
  }): Promise<{ cancelledReservationIds: string[] }>;

  /**
   * Phase 10: run one bounded planning attempt (planner role or fixture, then
   * deterministic assembly + validation + immutable draft persistence).
   */
  planItinerary(input: {
    tripId: string;
    operationId: string;
    attempt: number;
    feedback: readonly string[];
  }): Promise<TravelItineraryPlanResult>;
  /**
   * Phase 10: review the deterministically valid draft through the reviewer role
   * (or fixture); persists typed findings and demotes nonblocking suggestions.
   */
  reviewItinerary(input: {
    tripId: string;
    operationId: string;
    attempt: number;
    atBound: boolean;
    previousRevisionFingerprint: string | null;
  }): Promise<TravelItineraryReviewResult>;
  /** Phase 10: fenced approval of the current draft (fingerprint-bound). */
  approveItinerary(input: {
    tripId: string;
    operationId: string;
    decisionId: string;
    acceptedRevision: number;
    itineraryId: string;
  }): Promise<TravelItineraryApprovalResult>;

  /** Phase 08: interpret one chat message through the configured AI role. */
  interpretIntent(input: {
    tripId: string;
    operationId: string;
    message: string;
    /** Admission request id, so a duplicate reuses the stored message/result. */
    requestId?: string;
  }): Promise<{ result: IntentResult; mode: "fixture" | "openrouter" }>;
  /** Phase 08: read the admitted chat message of an internal `modify` operation. */
  loadChatMessage(operationId: string): Promise<string | undefined>;
  /** Phase 11: the admitted operation payload, so a typed modification applies
   * through the deterministic dispatcher without an LLM call. */
  loadOperationPayload(operationId: string): Promise<unknown>;
}

export type { ProposalStatus };
