import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/**
 * First serial node: confirm the trip exists and reset any state left over from a
 * previous completed run on the same thread. LangGraph keeps the checkpoint's
 * channel values when a new input starts at START, so without this reset a new
 * command would inherit the previous decision/proposal/reservation and could open
 * a stale `booking_confirmation` instead of a fresh `flight_choice`.
 */
export async function loadContextNode(state: TravelState, runtime: unknown): Promise<TravelUpdate> {
  const ports = travelPorts(runtime);
  const context = await ports.loadTrip(state.tripId);
  if (!context) {
    throw new Error(`trip ${state.tripId} was not found while loading graph context`);
  }
  return {
    tripLoaded: true,
    // Stage A / generation / Stage B
    routeStatus: "PENDING",
    routeValidationId: null,
    routeFingerprint: null,
    routeReasons: [],
    routeAlternatives: [],
    scenarioKey: null,
    snapshotId: null,
    scheduleValidationId: null,
    scheduleStatus: "PENDING",
    validCombinationIds: [],
    // Pending decision
    decisionKind: null,
    nextDecisionKind: "flight_choice",
    decisionFingerprint: null,
    proposalId: null,
    allowedOfferIds: [],
    allowedOptionIds: [],
    bookingService: null,
    // Decision results
    selectedOfferId: null,
    lastAction: null,
    lastOfferId: null,
    lastProposalId: null,
    lastDecisionId: null,
    lastOptionId: null,
    pendingReplacement: false,
    hasConfirmedFlight: false,
    hasConfirmedHotel: false,
    // Booking
    reservationId: null,
    demoReference: null,
    // Phase 07 research/program state
    domainsEnsured: false,
    researchStatus: "pending",
    // Phase 09 research fan-out: the keyed result map is deliberately NOT reset
    // here. It is pruned by `join_research` and carries the retained usable
    // results across operations, so a dinner-only change never reruns
    // breakfast/lunch; only the per-operation scope is reset.
    researchRunId: "",
    requiredDomains: [],
    researchAttempts: {},
    researchRound: 0,
    researchRetryPending: false,
    failedDomains: [],
    researchInputFingerprints: {},
    dispatchMode: "none",
    researchFailedDomains: [],
    researchReason: null,
    hotelOfferIds: [],
    mealOfferIds: { breakfast: [], lunch: [], dinner: [] },
    activityIds: [],
    programDefaults: { breakfast: null, lunch: null, dinner: null },
    dinnerNotIncludedReason: null,
    submittedMealSelections: null,
    submittedSelfArrangedMeals: [],
    submittedActivitiesSelfArranged: false,
    submittedActivityIds: [],
    programApplied: false,
    replacementStaged: false,
    logisticsStatus: "pending",
    logisticsReason: null,
    pendingStage: null,
    gate: "pending",
    lastOutcome: null,
    // Phase 10 itinerary planning/validation/review/approval
    planningAttempt: 0,
    itineraryId: null,
    itineraryVersion: null,
    itineraryStatus: null,
    itineraryValidationStatus: null,
    itineraryErrorCodes: [],
    itineraryWarningCodes: [],
    itineraryFeedback: [],
    itineraryReviewVerdict: null,
    itineraryReviewSuggestions: [],
    itineraryReviewFingerprint: null,
    itineraryBudgetConflict: false,
    itineraryTotalCostMinor: 0,
    recoveryOptionIds: [],
    // Phase 08 chat/intent/clarification
    chatMessage: null,
    intentStatus: "pending",
    intentInterpretation: null,
    intentPreserve: [],
    clarificationQuestion: null,
    clarificationOptions: [],
    clarificationRequestedCommands: [],
    modificationOperationId: null,
    // Phase 11 invalidation-matrix dispatch and route-change staging
    nextWork: "none",
    searchTargetDomains: [],
    searchIntent: null,
    confirmedServices: [],
    selectedServices: [],
    routeChangeProposalId: null,
    routeChangePreview: null,
    lastAffectedReservationIds: [],
  };
}
