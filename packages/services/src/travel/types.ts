import type {
  BookableKey,
  DeclinedBookingResult,
  IntentResult,
  ItineraryIssue,
  ItineraryMetrics,
  Meal,
  MealSelections,
  ProposalResult,
  PublicRouteChangeReservation,
  PublicRouteSummary,
  ResearchDomain,
  ResearchDomainStatus,
  ResearchSearchIntent,
  ReservationResult,
  RouteChangeField,
  RouteValidation,
  ScheduleValidation,
  TripRecord,
} from "@odft/contracts";
import type { ItineraryConflictDecision } from "@odft/domain";

/**
 * Phase 02: local typed service inputs/outputs.
 *
 * These are the composition-layer shapes the extracted services produce and
 * consume. They are structurally identical to the graph-facing port types in
 * `@odft/workflow` (which re-export them), but they are defined here so the
 * services package has no dependency on the graph package or on graph state.
 * A service must never import from `@odft/workflow`.
 */

export interface TripContext {
  readonly trip: TripRecord;
}

export interface MaterializedFlights {
  readonly scenarioKey: string;
  readonly snapshotId: string;
}

/** Phase 09: deterministic per-domain research input fingerprints. */
export interface ResearchInputs {
  readonly snapshotId: string;
  readonly fingerprints: Record<ResearchDomain, string>;
}

/** Phase 09: one domain's tagged research outcome (never a dataset). */
export interface ResearchOutcome {
  readonly domain: ResearchDomain;
  readonly status: ResearchDomainStatus;
  readonly artifactId: string | null;
  readonly offerIds: string[];
  readonly simulatedFailure: boolean;
  readonly reason: string | null;
  readonly attempt: number;
}

export interface RankDomainCandidates {
  readonly domain: ResearchDomain;
  readonly artifactId: string;
  readonly inputFingerprint: string;
  readonly offerIds: readonly string[];
}

export interface RankedServices {
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
export interface ResearchEvent {
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

export interface ProgramResult {
  readonly applied: boolean;
  readonly replacementStaged: boolean;
  readonly replacementProposalId: string | null;
  readonly replacementService: BookableKey | null;
  readonly replacementSourceFingerprint: string | null;
}

export interface TripProgress {
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
export type RouteChangeReservation = PublicRouteChangeReservation;

/** Phase 11: server-built route-change impact preview (safe fields only). */
export interface RouteChangePreview {
  readonly proposalId: string;
  readonly changedFields: readonly RouteChangeField[];
  readonly from: PublicRouteSummary;
  readonly to: PublicRouteSummary;
  readonly affectedReservations: readonly RouteChangeReservation[];
}

export interface LogisticsResult {
  readonly status: "valid" | "conflict";
  readonly reason: string | null;
}

/* ---- Phase 10: itinerary planning, validation, review, approval -------------- */

/**
 * One bounded planning attempt result. The proposal is persisted as an immutable
 * draft version (or rejected before persistence when the planner invented ids);
 * validation errors are normal routing, never an exception.
 */
export interface ItineraryPlanResult {
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

export interface ItineraryReviewResult {
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

export interface ItineraryApprovalResult {
  readonly itineraryId: string;
  readonly version: number;
}

export interface IntentInterpretation {
  readonly result: IntentResult;
  readonly mode: "fixture" | "openrouter";
}

/* ---- Service infrastructure --------------------------------------------------- */

/** One safe progress event persisted under the operation's fencing token. */
export interface ServiceEvent {
  readonly type: string;
  readonly payload: unknown;
}

/** Fenced event writer bound to the granted authority. */
export type ServiceEventWriter = (event: ServiceEvent) => Promise<void>;

export type {
  BookableKey,
  DeclinedBookingResult,
  Meal,
  MealSelections,
  ProposalResult,
  ResearchDomain,
  ResearchSearchIntent,
  ReservationResult,
  RouteValidation,
  ScheduleValidation,
};
