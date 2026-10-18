import type {
  BookableKey,
  DeclinedBookingResult,
  DomainCommand,
  IntentResult,
  ItineraryStop,
  Meal,
  MealSelections,
  ProposalResult,
  ProposalStatus,
  PublicRouteChangeReservation,
  ResearchDomain,
  ResearchSearchIntent,
  ReservationResult,
  RouteValidation,
  ScheduleValidation,
} from "@odft/contracts";
import type {
  ItineraryApprovalResult as ServiceItineraryApprovalResult,
  ItineraryPlanResult as ServiceItineraryPlanResult,
  ItineraryPreparedTask as ServiceItineraryPreparedTask,
  ItineraryReviewResult as ServiceItineraryReviewResult,
  LogisticsResult as ServiceLogisticsResult,
  MaterializedFlights as ServiceMaterializedFlights,
  ProgramResult as ServiceProgramResult,
  RankDomainCandidates as ServiceRankDomainCandidates,
  RankedServices as ServiceRankedServices,
  ResearchEvent as ServiceResearchEvent,
  ResearchInputs as ServiceResearchInputs,
  ResearchOutcome as ServiceResearchOutcome,
  RouteChangePreview as ServiceRouteChangePreview,
  TripContext as ServiceTripContext,
  TripProgress as ServiceTripProgress,
} from "@odft/services";

/**
 * Server-side dependencies for the coordinator dispatcher. They are built per
 * claimed operation, never persisted, and never a security boundary. All
 * domain/persistence access goes through these ports so the coordinator stays
 * orchestration-only (docs/architecture/coordinator.md).
 *
 * Phase 11: the file moved out of the removed legacy travel graph; the port
 * shapes are still the canonical service types from `@odft/services`.
 */

export type TravelTripContext = ServiceTripContext;
export type TravelMaterializedFlights = ServiceMaterializedFlights;
export type TravelResearchInputs = ServiceResearchInputs;
export type TravelResearchOutcome = ServiceResearchOutcome;
export type TravelRankDomainCandidates = ServiceRankDomainCandidates;
export type TravelRankedServices = ServiceRankedServices;
export type TravelResearchEvent = ServiceResearchEvent;
export type TravelProgramResult = ServiceProgramResult;
export type TravelProgress = ServiceTripProgress;
export type TravelRouteChangeReservation = PublicRouteChangeReservation;
export type TravelRouteChangePreview = ServiceRouteChangePreview;
export type TravelLogisticsResult = ServiceLogisticsResult;
export type TravelItineraryPlanResult = ServiceItineraryPlanResult;
export type TravelItineraryReviewResult = ServiceItineraryReviewResult;
export type TravelItineraryApprovalResult = ServiceItineraryApprovalResult;

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
  /** Validate a program without writing (pre-flight for a command batch). */
  validateProgram(input: {
    tripId: string;
    mealSelections: MealSelections;
    selfArrangedMeals: Meal[];
  }): Promise<void>;
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
   * Phase 08: prepare one delegated itinerary attempt (planner context + MCP
   * tool context). No AI call happens in the coordinator.
   */
  prepareItineraryTask(input: {
    tripId: string;
    attempt: number;
    feedback: readonly string[];
  }): Promise<ServiceItineraryPreparedTask>;
  /**
   * Phase 08: deterministically accept a City Guide proposal (membership,
   * opt-in, normalization, assembly, validation, draft persistence).
   */
  acceptItineraryProposal(input: {
    tripId: string;
    operationId: string;
    attempt: number;
    stops: readonly ItineraryStop[];
  }): Promise<TravelItineraryPlanResult>;
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
