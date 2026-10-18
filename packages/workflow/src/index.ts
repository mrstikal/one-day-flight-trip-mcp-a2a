export const PACKAGE_ID = "@odft/workflow" as const;

// Phase 11: the coordinator is the only active orchestration runtime.
export * from "./coordinator/state.js";
export * from "./coordinator/delegations.js";
export * from "./coordinator/dispatch.js";
export {
  bridgePendingObservations,
  reconcileOutboxes,
  reconcilePendingCancels,
} from "./coordinator/reconcile.js";
export type {
  CancelReconcileSummary,
  CancelTaskTransport,
  ObservationBridgeSummary,
  ReconcileOutboxesResult,
} from "./coordinator/reconcile.js";

export {
  commandChange,
  mergeResolutions,
  nextWorkFor,
  resolveCommandRouting,
  routingRefs,
} from "./routing/invalidation-matrix.js";
export type { NextWork, ResolvedCommandRouting } from "./routing/invalidation-matrix.js";
export { orderCommandsForApplication } from "./routing/command-order.js";

export type {
  ProposalStatus,
  TravelItineraryApprovalResult,
  TravelItineraryPlanResult,
  TravelItineraryReviewResult,
  TravelLogisticsResult,
  TravelMaterializedFlights,
  TravelPorts,
  TravelProgramResult,
  TravelProgress,
  TravelRankDomainCandidates,
  TravelRankedServices,
  TravelResearchEvent,
  TravelResearchInputs,
  TravelResearchOutcome,
  TravelRouteChangePreview,
  TravelRouteChangeReservation,
  TravelTripContext,
} from "./coordinator/ports.js";
