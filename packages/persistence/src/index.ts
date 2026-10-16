export const PACKAGE_ID = "@odft/persistence" as const;

export { ConfigError, parseServerConfig, resolveVoiceRuntimeConfig } from "./config.js";
export type { AiMode, ServerConfig, VoiceRuntimeConfig } from "./config.js";

export { contentHash } from "./hash.js";

export { createPool } from "./pool.js";
export type { CreatePoolOptions } from "./pool.js";

export { listMigrationVersions, MIGRATION_VERSIONS, runMigrations } from "./migrate.js";
export type { MigrationResult } from "./migrate.js";

export {
  CHECKPOINT_SCHEMA,
  CHECKPOINT_TABLES,
  setupCheckpointer,
  verifyCheckpointerSetup,
} from "./checkpointer-setup.js";

export { createWorkerIdentity, writeWorkerHeartbeat } from "./heartbeat.js";
export type { WorkerIdentity } from "./heartbeat.js";

export { checkReadiness } from "./readiness.js";
export type { CheckStatus, ReadinessOptions, ReadinessReport } from "./readiness.js";

export {
  DATASET_LIMITATION,
  getCityAirports,
  getCuratedLandmarks,
  getReferenceCity,
  listRouteEvidence,
  loadReferenceData,
  persistDiscoveredLandmarks,
  resolveCatchment,
  searchAirports,
  searchCities,
  searchCountries,
  setReferenceCityCoverage,
} from "./reference/repository.js";
export type {
  AirportSearchInput,
  AirportSearchResult,
  CityAirportsResult,
  CitySearchInput,
  CitySearchResult,
  CuratedLandmarksResult,
  LoadResult,
  ReferenceCityRow,
  RouteEvidenceQuery,
} from "./reference/repository.js";

export { createSession, getSession, getSessionByTokenHash, renewSession } from "./sessions.js";
export type { SessionRecord } from "./sessions.js";

export {
  getTrip,
  insertTrip,
  lockTrip,
  setTripWorkflowStatus,
  toTripRecord,
  upsertSelection,
} from "./trips.js";
export type { InsertTripInput, TripRow } from "./trips.js";

export {
  getActiveOperation,
  getOperationByRequestId,
  getOperationPayload,
  insertOperation,
  loadOperationById,
  setOperationStatus,
} from "./operations.js";
export type { InsertOperationInput, StoredOperation } from "./operations.js";

export { readEffect, writeEffect } from "./effects.js";
export { insertEvent, listTripEvents, projectSafeEvent } from "./events.js";
export { deriveOperationFrontier, loadPublicInspector } from "./inspector.js";
export type { ExecutionEventInput, ProjectedEvent } from "./events.js";

export { getProposal, insertProposal, markProposalResolved } from "./proposals.js";

export {
  getActiveReservation,
  getReservationByConfirmationKey,
  getReservationByReference,
  insertReservationWithGeneratedReference,
  RefGenerationFailedError,
  supersedeReservation,
} from "./reservations.js";

export {
  insertDecision,
  getPendingDecisionForTrip,
  loadDecision,
  resolveDecision,
} from "./decisions.js";
export type { InsertDecisionInput } from "./decisions.js";

export { PostgresBookingStore } from "./booking-store.js";

export {
  claimNextOperation,
  claimOperationById,
  DEFAULT_LEASE_MS,
  LEASE_RENEW_MS,
  MAX_AUTO_CLAIMS_PER_ROUND,
  reapExhaustedOperations,
} from "./operations/claim.js";
export type { ClaimedOperation, ClaimedOperationKind, ClaimOptions } from "./operations/claim.js";

export {
  finalizeConflict,
  finalizeFailure,
  finalizeSuccess,
  finalizeWaiting,
} from "./operations/finalize.js";
export type {
  FailureSpec,
  FinalizeFence,
  SuccessSpec,
  WaitingSpec,
} from "./operations/finalize.js";

export { completeOperation, releaseClaim, renewLease } from "./operations/lease.js";
export type { CompleteOperationInput } from "./operations/lease.js";

export {
  acquireCheckpointGate,
  assertFencingCurrent,
  checkpointGateKey,
  isFencingCurrent,
  lockOperationFence,
  readOperationOwnership,
  StaleFencingError,
} from "./operations/fencing.js";
export type { OperationFencingContext, OperationOwnership } from "./operations/fencing.js";

export { retryOperation, setRecoveryRequired } from "./operations/control.js";
export type { RetryOperationOptions, RetryOperationResult } from "./operations/control.js";

export { GRAPH_VERSION, admitOperation, admitResume, createTrip, withEffect } from "./admission.js";
export type {
  AdmitOperationOptions,
  AdmitOperationResult,
  AdmitResumeOptions,
  AdmitResumeResult,
  CreateTripOptions,
  CreateTripResult,
} from "./admission.js";

export {
  buildRouteInputs,
  buildSnapshotContext,
  HUB_IATAS,
  TRANSFER_POLICY,
} from "./scenario/route-inputs.js";

export { materializeFlightSnapshot } from "./scenario/flight-materialization.js";
export type { MaterializedFlightSnapshot } from "./scenario/flight-materialization.js";

export {
  currentApprovalGuard,
  evaluateAndPersistRoute,
  loadFeasibleRouteApproval,
  loadRouteValidation,
  loadScheduleValidation,
  persistRouteValidation,
  persistScheduleValidation,
  validateAndPersistSchedules,
} from "./scenario/validations.js";
export type {
  ApprovalGuardState,
  EvaluatedRoute,
  PersistScheduleInput,
} from "./scenario/validations.js";

export {
  extendSnapshot,
  initialSnapshotContent,
  loadLatestManifest,
  loadSnapshotContent,
  loadSnapshotManifest,
  persistSnapshot,
  persistSnapshotVersion,
  PostgresSnapshotSource,
  ScenarioService,
  scenarioUuid,
} from "./scenario/snapshots.js";
export type { ExtensionInput } from "./scenario/snapshots.js";

export {
  loadOverlay,
  loadOverlaySummaries,
  recordFaultOutcome,
  upsertFault,
} from "./scenario/faults.js";
export type {
  FaultDomain,
  FaultOutcomeInput,
  FaultOutcomeRecord,
  OverlaySummary,
  UpsertFaultInput,
} from "./scenario/faults.js";

/* ---- Phase 10: immutable itinerary versions ---------------------------------- */

export {
  approveItineraryDraft,
  ItineraryPersistenceError,
  loadApprovedItineraryVersion,
  loadItineraryById,
  loadItineraryPlanningData,
  loadLatestItinerary,
  persistItineraryDraft,
  saveItineraryReview,
} from "./itineraries.js";
export type {
  ApproveItineraryInput,
  ItineraryMealSelections,
  ItineraryPlanningData,
  PersistItineraryDraftInput,
  PersistedItineraryRef,
  SaveItineraryReviewInput,
} from "./itineraries.js";

/* ---- Phase 09: parallel research fan-out ------------------------------------- */

export {
  artifactIdFor,
  listLatestRecommendationArtifacts,
  recordRecommendationArtifact,
} from "./recommendations.js";
export type {
  RecommendationArtifactInput,
  RecommendationArtifactRecord,
} from "./recommendations.js";

export {
  loadTripResearchInputs,
  overlayTargetsDomain,
  rankTripRecommendations,
  researchTripDomain,
} from "./scenario/research-domains.js";
export type {
  RankDomainCandidates,
  RankedTripServices,
  ResearchDomainOutcome,
  ResearchDomainRequest,
  TripResearchInputs,
} from "./scenario/research-domains.js";

export {
  applyTripCommand,
  applyTripCommands,
  commitRouteChange,
  previewRouteChange,
  TripCommandError,
} from "./trip-commands.js";
export type {
  ApplyTripCommandResult,
  ApplyTripCommandsResult,
  RouteChangePreviewResult,
  RouteChangeReservationPreview,
} from "./trip-commands.js";

export {
  dinnerSlotAvailable,
  loadPreferredActivityIds,
  loadTripProgress,
  parseClock,
  planProgramSelections,
  recordPreferredActivities,
  removeProgramSelections,
  ServiceSelectionError,
  upsertProgramSelections,
  validateTripLogistics,
} from "./scenario/trip-services.js";
export type {
  ProgramPlan,
  ProgramSelection,
  ResearchMeal,
  TripLogisticsResult,
  TripProgress,
} from "./scenario/trip-services.js";

export {
  EMPTY_SELF_ARRANGED_STATE,
  loadSelfArrangedState,
  replaceSelfArrangedStateIn,
  selfArrangedServiceKeys,
  setSelfArrangedState,
} from "./self-arranged.js";
export type { SelfArrangedService, SelfArrangedState } from "./self-arranged.js";

/* ---- Phase 08: AI call governance and persistent conversation ---------------- */

export {
  countTripLlmCalls,
  formatUsdAmount,
  parseUsdAmount,
  sumTripLlmCostUsd,
  usdFromDb,
} from "./usd.js";

export {
  getLlmCall,
  listTripLlmCalls,
  markCallUnknown,
  reconcileUnknownBilling,
  recordCallResult,
  reserveCall,
  type LlmCallRecord,
  type RecordCallResultInput,
  type ReserveCallInput,
  type ReserveCallOutcome,
} from "./llm-calls.js";

/* ---- Voice control: durable voice-call ledger (VOICE_CONTROLL.md section 9) -- */

export {
  countTripVoiceCalls,
  getVoiceCall,
  listTripVoiceCalls,
  markVoiceCallFailed,
  markVoiceCallUnknown,
  reconcileVoiceCallBilling,
  reserveVoiceCall,
  settleVoiceCallSuccess,
  sumTripVoiceCostUsd,
  type ReserveVoiceCallInput,
  type ReserveVoiceCallOutcome,
  type SettleVoiceCallInput,
  type VoiceCallFailureInput,
  type VoiceCallRecord,
  type VoiceCallStatus,
} from "./voice-calls.js";

export {
  appendConversationMessage,
  getConversationMessage,
  insertConversationMessage,
  latestClarification,
  listConversation,
  type AppendMessageInput,
  type ConversationMessageRecord,
} from "./conversations.js";

export {
  assertOperationFence,
  readEffectFenced,
  writeEffectFenced,
  type OperationFence,
} from "./effects.js";
