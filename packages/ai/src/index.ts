export const PACKAGE_ID = "@odft/ai" as const;

export {
  AdapterError,
  assertRoleContext,
  type AdapterErrorCode,
  type AdapterUsage,
  type CallGovernor,
  type LLMAdapter,
  type RoleContextMap,
  type StructuredRequest,
  type StructuredResponse,
} from "./adapter.js";

export {
  aiConfigRepoRoot,
  AiConfigError,
  ConfigFileNotFoundError,
  loadRoleProfiles,
  resolveAiConfigPath,
  resolveRepoConfigPath,
  ROLE_DEFAULT_LIMITS,
  stampPricingVersion,
  type LoadedAiConfig,
  type LoadRoleProfilesOptions,
} from "./config.js";

export {
  assertModelCapable,
  CAPABILITY_CACHE_TTL_MS,
  capabilityEntrySchema,
  capabilityEndpointSchema,
  capabilityManifestSchema,
  loadCapabilityManifest,
  normalizeEndpointEntry,
  OPENROUTER_MODELS_URL,
  refreshCapabilityManifest,
  type CapabilityCheck,
  type CapabilityEndpoint,
  type CapabilityFetch,
  type CapabilityFetchResponse,
  type CapabilityManifest,
  type LoadCapabilityOptions,
  type RefreshCapabilityOptions,
} from "./capabilities.js";

export {
  addUsd,
  assertProfileWithinCeiling,
  compareUsd,
  formatUsd,
  parseUsd,
  worstCaseCostUsd,
  type CostBounds,
} from "./costs.js";

export {
  combineAbortSignals,
  readBodyWithCap,
  SpeechError,
  usageCostFromNumber,
  type SpeechAdapter,
  type SpeechErrorCode,
  type SpeechFetch,
  type SpeechSynthesisRequest,
  type SpeechSynthesisResult,
  type SpeechTranscriptionRequest,
  type SpeechTranscriptionResult,
  type SpeechUsage,
} from "./speech-adapter.js";

export {
  billedAudioSeconds,
  billedCharacters,
  ceilExactToInteger,
  compareExactDecimals,
  costNanos,
  maxExactDecimal,
  parseExactDecimal,
  reserveSttCostNanos,
  reserveTtsCostNanos,
  SPEECH_AUDIO_SAMPLE_RATE,
  SPEECH_UNIT_BY_KIND,
  worstCallCostUsd,
  type ExactDecimal,
  type SpeechTariff,
} from "./speech-costs.js";

export {
  assertDocumentedSpeechDefaults,
  assertSpeechCapable,
  assertSpeechManifestFresh,
  DOCUMENTED_SPEECH_MODELS,
  DOCUMENTED_STT_ENDPOINT_PROVIDER_ID,
  loadSpeechCapabilityManifest,
  normalizeSpeechCapability,
  refreshSpeechCapabilityManifest,
  revalidateSpeechTariffs,
  speechCapabilityEntrySchema,
  speechCapabilityManifestSchema,
  SPEECH_CAPABILITY_CACHE_TTL_MS,
  SPEECH_EXPECTED_MODALITY,
  SPEECH_NORMALIZATION_VERSION,
  type RefreshSpeechCapabilityOptions,
  type SpeechCapabilityCheck,
  type SpeechCapabilityEntry,
  type SpeechCapabilityFetch,
  type SpeechCapabilityFetchResponse,
  type SpeechCapabilityManifest,
} from "./speech-capabilities.js";

export {
  loadVoiceProfiles,
  resolveVoiceConfigPath,
  speechCapabilitiesPath,
  stampVoicePricingVersion,
  VoiceConfigError,
  writeVoiceProfiles,
} from "./speech-config.js";

export {
  FixtureSpeechAdapter,
  fixtureWavBytes,
  FIXTURE_TONE_HZ,
  FIXTURE_TRANSCRIPT,
  FIXTURE_TTS_SECONDS,
} from "./fixture-speech-adapter.js";

export {
  MAX_STT_RESPONSE_BYTES,
  OpenRouterSpeechAdapter,
  OPENROUTER_SPEECH_URL,
  OPENROUTER_TRANSCRIPTIONS_URL,
  type OpenRouterSpeechAdapterOptions,
} from "./openrouter-speech-adapter.js";

export {
  buildCompactContext,
  compactContextSourceSchema,
  DEFAULT_CONTEXT_BUDGET,
  estimateTokens,
  intentContextSchema,
  ReducedScopeError,
  type ActivityCounts,
  type CompactContextSource,
  type ContextBudget,
  type IntentContext,
} from "./context/compact-context.js";

export {
  plannerContextSchema,
  recommendationContextSchema,
  reviewerContextSchema,
  type PlannerContext,
  type RecommendationContext,
  type ReviewerContext,
} from "./context/role-contexts.js";

export {
  toCanonicalIntentResult,
  validateIntentSemantics,
  type AuthorizedIntentContext,
} from "./semantic.js";

export {
  FixtureAdapter,
  fixtureIntent,
  fixturePlanner,
  fixtureRecommendation,
  fixtureReviewer,
  FIXTURE_INVALID_FIRST_ITINERARY,
  type FixtureCounters,
} from "./fixture-adapter.js";

export {
  buildTransportSchema,
  OpenRouterAdapter,
  OPENROUTER_CHAT_URL,
  OPTIONAL_TRANSPORT_FIELDS,
  stripOptionalTransportNulls,
  type FetchLike,
  type OpenRouterAdapterOptions,
  type TransportSchema,
} from "./openrouter-adapter.js";

export {
  assertTelemetrySafe,
  FORBIDDEN_TELEMETRY_KEYS,
  sanitizeTelemetry,
  TELEMETRY_ALLOWED_KEYS,
  toPublicLlmCall,
  type LlmCallTelemetryRow,
} from "./telemetry.js";

export { ROLE_CONTEXT_SCHEMAS, ROLE_CONTRACTS } from "./roles/registry.js";
export { INTENT_LIMITS, intentRole } from "./roles/intent.js";
export {
  RECOMMENDATION_LIMITS,
  recommendationRole,
  recommendationOutputSchema,
  type RecommendationOutput,
} from "./roles/recommendation.js";
export {
  PLANNER_LIMITS,
  plannerRole,
  plannerOutputSchema,
  type PlannerOutput,
  type ProposedStop,
} from "./roles/planner.js";
export {
  REVIEWER_LIMITS,
  reviewerRole,
  reviewerOutputSchema,
  reviewIssueCodeSchema,
  type ReviewIssueCode,
  type ReviewerOutput,
} from "./roles/reviewer.js";
export type { RoleDefaultLimits } from "./roles/limits.js";

export { INTENT_PROMPT_VERSION, INTENT_SYSTEM_PROMPT } from "./prompts/intent-v1.js";
export {
  RECOMMENDATION_PROMPT_VERSION,
  RECOMMENDATION_SYSTEM_PROMPT,
} from "./prompts/recommendation-v1.js";
export { PLANNER_PROMPT_VERSION, PLANNER_SYSTEM_PROMPT } from "./prompts/planner-v2.js";
export { REVIEWER_PROMPT_VERSION, REVIEWER_SYSTEM_PROMPT } from "./prompts/reviewer-v2.js";
export { enforceOptInVisits } from "./opt-in-visits.js";
