import type { Pool } from "pg";
import {
  AdapterError,
  buildCompactContext,
  fixtureFlightRecommendation,
  flightRecommendationContextSchema,
  RECOMMENDATION_V2_PROMPT_VERSION,
  RECOMMENDATION_V2_SYSTEM_PROMPT,
  recommendationOutputSchema,
  CAPABILITY_CACHE_TTL_MS,
  DEFAULT_CONTEXT_BUDGET,
  FixtureAdapter,
  formatUsd,
  intentRole,
  loadCapabilityManifest,
  loadRoleProfiles,
  OpenRouterAdapter,
  plannerOutputSchema,
  plannerRole,
  resolveAiConfigPath,
  reviewerOutputSchema,
  reviewerRole,
  validateIntentSemantics,
  worstCaseCostUsd,
  type AuthorizedIntentContext,
  type CallGovernor,
  type CapabilityManifest,
  type CompactContextSource,
  type LLMAdapter,
  type PlannerContext,
  type PlannerOutput,
  type FlightRecommendationContext,
  type ReviewerContext,
  type ReviewerOutput,
  type RoleContextMap,
} from "@odft/ai";
import {
  domainCommandSchema,
  intentResultSchema,
  modelFacingIntentResultSchema,
  preservableKeySchema,
  snapshotContentSchema,
  tripPreferencesSchema,
  type AIRole,
  type DomainCommand,
  type IntentResult,
  type PreservableKey,
  type RoleProfile,
  type RoleProfiles,
  type TripRecord,
} from "@odft/contracts";
import {
  getPendingDecisionForTrip,
  getTrip,
  listConversation,
  markCallUnknown,
  markDelegatedCallUnknown,
  readEffectFenced,
  recordCallResult,
  reserveCall,
  reserveDelegatedCall,
  settleDelegatedCall,
  writeEffectFenced,
  type ServerConfig,
} from "@odft/persistence";
import { DelegatedCallError, type DelegatedAuthority } from "./authority.js";

/**
 * Governed AI runtime (06-ai-agent-design.md), extracted into the services layer
 * (Phase 02) without behavior changes.
 *
 * Wraps the provider-independent adapter with durable call governance, the
 * effect ledger (a crash replay reuses the validated result and performs no
 * second billable call), and deterministic semantic validation. It performs no
 * SQL writes for domain state — only the AI ledger, conversation, and effects.
 */

export interface AiService {
  interpret(input: {
    readonly tripId: string;
    readonly operationId: string;
    /** Fencing token of the claiming worker; every write verifies it. */
    readonly fencingToken: string;
    readonly message: string;
    /** Driver abort signal (shutdown/lease loss), forwarded to the transport. */
    readonly signal?: AbortSignal;
  }): Promise<{ readonly result: IntentResult; readonly mode: "fixture" | "openrouter" }>;
  /**
   * Phase 10: one planner-role call (or the deterministic fixture) under the
   * effect ledger. Candidate membership is enforced here: a stop that references
   * an id outside the supplied bounded context is rejected before validation.
   */
  plan(input: {
    readonly tripId: string;
    readonly operationId: string;
    readonly fencingToken: string;
    readonly attempt: number;
    readonly context: PlannerContext;
    readonly signal?: AbortSignal;
  }): Promise<
    | {
        readonly kind: "planned";
        readonly output: PlannerOutput;
        readonly mode: "fixture" | "openrouter";
      }
    | {
        readonly kind: "rejected";
        readonly reason: string;
        readonly mode: "fixture" | "openrouter";
      }
  >;
  /**
   * Phase 10: one reviewer-role call (or fixture) over the deterministically
   * valid draft; unknown event ids in suggestions are dropped deterministically.
   */
  review(input: {
    readonly tripId: string;
    readonly operationId: string;
    readonly fencingToken: string;
    readonly attempt: number;
    readonly context: ReviewerContext;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly output: ReviewerOutput; readonly mode: "fixture" | "openrouter" }>;
  /** Fixture-only counter accessor (real token/cost counters stay in the ledger). */
  readonly fixtureCounters?: () => { calls: number };
}

const FIXTURE_ADAPTER = new FixtureAdapter();

function usdString(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "0";
  }
  return formatUsd(BigInt(Math.ceil(value * 1e9)));
}

/** Resolve the config (cwd, then repo root) so worker and root scripts agree. */
function resolvedConfigPath(config: ServerConfig): string | undefined {
  return config.aiConfigPath ? resolveAiConfigPath(config.aiConfigPath) : undefined;
}

function capabilityCachePath(config: ServerConfig): string {
  const resolved = resolvedConfigPath(config);
  return resolved ? `${resolved}.capabilities.json` : ".ai/capabilities.json";
}

interface InterpretDeps {
  readonly pool: Pool;
  readonly config: ServerConfig;
}

async function loadIntentSource(
  pool: Pool,
  trip: TripRecord,
  message: string,
): Promise<CompactContextSource> {
  const cities = await pool.query<{ id: string }>(
    `SELECT id FROM odft_app.reference_cities
      WHERE country_key = $1 ORDER BY id LIMIT 200`,
    [trip.destinationCountryKey],
  );
  const airports = await pool.query<{ airport_id: string }>(
    `SELECT airport_id FROM odft_app.reference_city_airports
      WHERE city_id = $1 ORDER BY airport_id LIMIT 50`,
    [trip.destinationCityId],
  );
  const selections = await pool.query<{
    service_key: string;
    offer_id: string;
    confirmed: boolean;
  }>(
    `SELECT s.service_key, s.offer_id,
            EXISTS (
              SELECT 1 FROM odft_app.reservations r
               WHERE r.trip_id = s.trip_id AND r.service_key = s.service_key AND r.status = 'confirmed'
            ) AS confirmed
       FROM odft_app.trip_selections s
      WHERE s.trip_id = $1 AND s.service_key NOT IN ('activities','events')`,
    [trip.id],
  );
  // Authoritative id sets for set_program membership (snapshot-wide, uncapped).
  const snapshotContent = await loadSnapshotContent(pool, trip.id);
  const knownActivityIds = snapshotContent?.activities.map((activity) => activity.id) ?? [];
  const knownRestaurantIds = snapshotContent?.restaurants.map((restaurant) => restaurant.id) ?? [];
  const validCombinations = trip.currentScheduleValidationId
    ? await pool.query<{ result: unknown }>(
        `SELECT result FROM odft_app.schedule_validations WHERE id = $1`,
        [trip.currentScheduleValidationId],
      )
    : undefined;
  const validIds = (() => {
    const result = validCombinations?.rows[0]?.result as { validCombinationIds?: unknown } | undefined;
    return Array.isArray(result?.validCombinationIds)
      ? result.validCombinationIds.filter((value): value is string => typeof value === "string")
      : [];
  })();
  const messages = await listConversation(pool, trip.id, 6);
  const userNameResult = await pool.query<{ user_name: string }>(
    `SELECT user_name FROM odft_app.trips WHERE id = $1`,
    [trip.id],
  );
  const pending = await getPendingDecisionForTrip(pool, trip.id);
  const outcomes = await pool.query<{ payload: unknown }>(
    `SELECT payload FROM odft_app.execution_events
      WHERE trip_id = $1 AND type = 'operation.succeeded'
      ORDER BY id DESC LIMIT 10`,
    [trip.id],
  );

  const knownAirportIds = [trip.originAirportId, ...airports.rows.map((row) => row.airport_id)];
  const knownOfferIds = [...selections.rows.map((row) => row.offer_id), ...validIds].slice(0, 50);

  const offerPrices = new Map<string, number>();
  const offerLevels = new Map<string, "budget" | "standard" | "luxury">();
  if (snapshotContent) {
    for (const offer of [...snapshotContent.hotels, ...snapshotContent.restaurants]) {
      offerPrices.set(offer.id, offer.partyTotalMinor);
      offerLevels.set(offer.id, offer.level);
    }
  }

  return {
    message,
    userName: userNameResult.rows[0]?.user_name ?? "Traveler",
    today: new Date().toISOString().slice(0, 10),
    route: {
      originAirportId: trip.originAirportId,
      destinationCityId: trip.destinationCityId,
      destinationCountryKey: trip.destinationCountryKey,
      sightseeingDate: trip.sightseeingDate,
      travelVariant: trip.travelVariant,
    },
    preferences: tripPreferencesSchema.parse(trip.preferences),
    ...(pending?.kind === "clarification"
      ? {
          pendingClarification: await loadPendingClarification(pool, pending),
        }
      : {}),
    selectedServices: selections.rows
      .filter((row) => row.service_key !== "activities" && row.service_key !== "events")
      .slice(0, 7)
      .map((row) => ({
        service: row.service_key as CompactContextSource["selectedServices"][number]["service"],
        offerId: row.offer_id,
        confirmed: row.confirmed,
        ...(offerPrices.has(row.offer_id) ? { partyTotalMinor: offerPrices.get(row.offer_id) } : {}),
        ...(offerLevels.has(row.offer_id) ? { level: offerLevels.get(row.offer_id) } : {}),
      })),
    currentActivityCounts: await loadActivityCounts(pool, trip.id),
    pendingDecisionKind: pending?.kind ?? null,
    budgetMinor: trip.preferences.maxBudgetMinor ?? null,
    recentMessages: messages.map((entry) => ({ role: entry.role, content: entry.content })),
    summary: outcomes.rows
      .map((row) => {
        const summary = (row.payload as { summary?: unknown } | null)?.summary;
        return typeof summary === "string"
          ? { request: "previous request", outcome: summary.slice(0, 500) }
          : undefined;
      })
      .filter((value): value is { request: string; outcome: string } => value !== undefined)
      .slice(0, 20),
    knownCityIds: cities.rows.map((row) => row.id),
    knownAirportIds,
    knownOfferIds,
    knownActivityIds,
    knownRestaurantIds,
  };
}

/** Active-snapshot content (activities/restaurants) for membership and prices. */
async function loadSnapshotContent(
  pool: Pool,
  tripId: string,
): Promise<ReturnType<typeof snapshotContentSchema.parse> | undefined> {
  const result = await pool.query<{ inventory: unknown }>(
    `SELECT s.inventory FROM odft_app.scenario_snapshots s
       JOIN odft_app.trips t ON t.active_scenario_snapshot_id = s.id
      WHERE t.id = $1`,
    [tripId],
  );
  if (!result.rows[0]?.inventory) {
    return undefined;
  }
  const parsed = snapshotContentSchema.safeParse(result.rows[0].inventory);
  return parsed.success ? parsed.data : undefined;
}

/** The typed pending clarification, so a follow-up can refer to its options. */
async function loadPendingClarification(
  pool: Pool,
  pending: { id: string },
): Promise<CompactContextSource["pendingClarification"]> {
  const result = await pool.query<{ option_payload: unknown }>(
    `SELECT option_payload FROM odft_app.pending_decisions WHERE id = $1`,
    [pending.id],
  );
  const payload = result.rows[0]?.option_payload as
    | { question?: unknown; options?: unknown; requestedCommands?: unknown; preserve?: unknown }
    | undefined;
  if (!payload || typeof payload.question !== "string" || !Array.isArray(payload.options)) {
    return null;
  }
  const options = payload.options
    .map((option) => {
      const record = option as { id?: unknown; label?: unknown };
      return typeof record.id === "string" && typeof record.label === "string"
        ? { id: record.id, label: record.label }
        : undefined;
    })
    .filter((option): option is { id: string; label: string } => option !== undefined)
    .slice(0, 4);
  const requestedCommands = Array.isArray(payload.requestedCommands)
    ? payload.requestedCommands
        .map((command) => domainCommandSchema.safeParse(command))
        .filter((parsed): parsed is { success: true; data: DomainCommand } => parsed.success)
        .map((parsed) => parsed.data)
        .slice(0, 4)
    : [];
  const preserve = Array.isArray(payload.preserve)
    ? payload.preserve
        .map((key) => preservableKeySchema.safeParse(key))
        .filter((parsed): parsed is { success: true; data: PreservableKey } => parsed.success)
        .map((parsed) => parsed.data)
    : [];
  return { question: payload.question, requestedCommands, preserve, options };
}

/** Current per-tag activity counts from the persisted preferred activities. */
async function loadActivityCounts(
  pool: Pool,
  tripId: string,
): Promise<CompactContextSource["currentActivityCounts"]> {
  const preferred = await pool.query<{ ranked_offers: unknown }>(
    `SELECT ranked_offers FROM odft_app.recommendation_artifacts
      WHERE trip_id = $1 AND service_key = 'activities' AND explanation LIKE 'User program%'
      ORDER BY created_at DESC LIMIT 1`,
    [tripId],
  );
  const preferredIds = new Set(
    Array.isArray(preferred.rows[0]?.ranked_offers)
      ? (preferred.rows[0]?.ranked_offers as unknown[]).filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  );
  if (preferredIds.size === 0) {
    return {};
  }
  const snapshot = await pool.query<{ inventory: unknown }>(
    `SELECT s.inventory FROM odft_app.scenario_snapshots s
       JOIN odft_app.trips t ON t.active_scenario_snapshot_id = s.id
      WHERE t.id = $1`,
    [tripId],
  );
  const parsed = snapshot.rows[0]?.inventory
    ? snapshotContentSchema.safeParse(snapshot.rows[0].inventory)
    : undefined;
  if (!parsed?.success) {
    return {};
  }
  const counts: Record<string, number> = {};
  for (const activity of parsed.data.activities) {
    if (!preferredIds.has(activity.id)) {
      continue;
    }
    // Count real activity tags (not the coarse culture/relaxation/entertainment
    // category), so `minimumActivityCounts` stays in the tag vocabulary.
    for (const tag of activity.tags) {
      counts[tag] = Math.min(7, (counts[tag] ?? 0) + 1);
    }
  }
  return counts as CompactContextSource["currentActivityCounts"];
}

async function loadAuthorizedContext(pool: Pool, trip: TripRecord): Promise<AuthorizedIntentContext> {
  const source = await loadIntentSource(pool, trip, "");
  return {
    knownCityIds: source.knownCityIds,
    knownAirportIds: source.knownAirportIds,
    knownOfferIds: source.knownOfferIds,
    knownActivityIds: source.knownActivityIds ?? [],
    knownRestaurantIds: source.knownRestaurantIds ?? [],
    todayIsoDate: source.today,
    currentActivityCounts: source.currentActivityCounts,
  };
}

function createGovernor(
  pool: Pool,
  config: ServerConfig,
  input: {
    readonly tripId: string;
    readonly operationId: string;
    readonly fencingToken: string;
    readonly role: AIRole;
    readonly profile: RoleProfile;
    readonly promptVersion: string;
    readonly effectScope: string;
  },
): CallGovernor {
  return {
    async reserve() {
      const worst = worstCaseCostUsd(input.profile, {
        inputTokens: input.profile.maxInputTokens,
        outputTokens: input.profile.maxOutputTokens,
      });
      const outcome = await reserveCall(pool, {
        tripId: input.tripId,
        operationId: input.operationId,
        fencingToken: input.fencingToken,
        role: input.role,
        model: input.profile.model,
        provider: input.profile.provider,
        promptVersion: input.promptVersion,
        mode: "openrouter",
        effectScope: input.effectScope,
        pricingVersion: input.profile.pricingVersion,
        reservedTokens: input.profile.maxInputTokens + input.profile.maxOutputTokens,
        reservedCostUsd: formatUsd(worst),
        maxCallCostUsd: input.profile.maxCallCostUsd,
        maxCallsPerTrip: config.maxLlmCallsPerTrip,
        maxCostUsdPerTrip: usdString(config.maxLlmCostUsdPerTrip),
        maxAttemptsPerScope: 2,
      });
      if (!outcome.ok) {
        throw new AdapterError(
          outcome.code === "AI_PRICING_UNKNOWN" ? "AI_PRICING_UNKNOWN" : "AI_BUDGET_EXCEEDED",
          outcome.message,
          false,
        );
      }
      return { callId: outcome.callId };
    },
    async settle(callId, usage) {
      await recordCallResult(pool, callId, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        reasoningOutputTokens: usage.reasoningOutputTokens,
        costUsd: usage.costUsd,
        costStatus: usage.costStatus,
        latencyMs: usage.latencyMs,
        finishReason: usage.finishReason,
        attempts: usage.attempts,
        validationStatus: usage.validationStatus,
        errorCode: usage.errorCode,
      });
    },
    async markUnknown(callId, reason, latencyMs) {
      await markCallUnknown(pool, callId, reason, latencyMs);
    },
  };
}

export function createAiService(deps: InterpretDeps): AiService {
  const { pool, config } = deps;
  const loaded =
    config.aiMode === "openrouter"
      ? loadRoleProfiles({ mode: "openrouter", configPath: config.aiConfigPath })
      : ({ mode: "fixture" } as const);
  let manifest: CapabilityManifest | undefined;

  async function resolveAdapter(
    role: AIRole,
    promptVersion: string,
    operationId: string,
    tripId: string,
    fencingToken: string,
    effectScope: string,
  ): Promise<LLMAdapter> {
    if (loaded.mode === "fixture" || !loaded.profiles) {
      return FIXTURE_ADAPTER;
    }
    const configuredModels = Object.values(loaded.profiles).map((profile) => profile.model);
    // The 24-hour capability TTL also applies to a long-lived process: re-read the
    // cached manifest once the loaded snapshot is older than the policy allows, so
    // reservations never use prices older than the cache policy permits. The worker
    // never refreshes the manifest itself: an automatic refresh would write a new
    // `pricingVersion` that no longer matches the operator-stamped profile pins and
    // would fail every call closed. A missing, stale, or non-covering cache fails
    // closed with an actionable `ai:validate-models` error instead.
    const manifestAgeMs = manifest
      ? Date.now() - Date.parse(manifest.fetchedAt)
      : Number.POSITIVE_INFINITY;
    const activeManifest =
      manifest === undefined ||
      !Number.isFinite(manifestAgeMs) ||
      manifestAgeMs >= CAPABILITY_CACHE_TTL_MS
        ? await loadCapabilityManifest({
          cachePath: capabilityCachePath(config),
          models: configuredModels,
        })
        : manifest;
    manifest = activeManifest;
    const profile = loaded.profiles[role];
    return new OpenRouterAdapter({
      apiKey: config.openrouterApiKey ?? "",
      manifest: activeManifest,
      profiles: loaded.profiles,
      governor: createGovernor(pool, config, {
        tripId,
        operationId,
        fencingToken,
        role,
        profile,
        promptVersion,
        effectScope,
      }),
    });
  }

  return {
    ...(loaded.mode === "fixture"
      ? { fixtureCounters: () => ({ calls: FIXTURE_ADAPTER.fixtureCounters.calls }) }
      : {}),
    async interpret(input) {
      const effectScope = "intent";
      const fence = {
        operationId: input.operationId,
        tripId: input.tripId,
        fencingToken: input.fencingToken,
      };
      const effectKey = {
        operationId: input.operationId,
        nodeName: "interpret_intent",
        effectScope,
      };
      // Replay (fenced): a stored validated result performs no second billable call,
      // and a worker that lost its lease reads/writes nothing.
      const cached = await readEffectFenced(pool, fence, effectKey);
      if (cached !== undefined) {
        return { result: intentResultSchema.parse(cached), mode: loaded.mode };
      }
      const trip = await getTrip(pool, input.tripId);
      if (!trip) {
        throw new AdapterError("AI_TRANSPORT_FAILED", `trip ${input.tripId} not found`, false);
      }
      const source = await loadIntentSource(pool, trip, input.message);
      const intentProfile = loaded.mode === "openrouter" ? loaded.profiles?.intent : undefined;
      // Bound the context by the profile's own input cap (minus the system prompt)
      // so the reservation always covers what is actually sent.
      const context = buildCompactContext(
        source,
        intentProfile
          ? {
              maxInputTokens: Math.max(512, intentProfile.maxInputTokens - 512),
              maxHistoryTokens: Math.min(
                DEFAULT_CONTEXT_BUDGET.maxHistoryTokens,
                Math.max(256, intentProfile.maxInputTokens - 512),
              ),
            }
          : undefined,
      );
      const adapter = await resolveAdapter(
        "intent",
        intentRole.promptVersion,
        input.operationId,
        input.tripId,
        input.fencingToken,
        effectScope,
      );
      const response = await adapter.generateObject({
        role: "intent",
        promptVersion: intentRole.promptVersion,
        operationId: input.operationId,
        effectScope,
        systemPrompt: intentRole.systemPrompt,
        context,
        outputSchema: modelFacingIntentResultSchema,
        signal: input.signal ?? new AbortController().signal,
      });
      const authorized = await loadAuthorizedContext(pool, trip);
      const result = validateIntentSemantics(response.value, authorized);
      await writeEffectFenced(pool, fence, effectKey, result);
      return { result, mode: loaded.mode };
    },
    async plan(input) {
      const effectScope = `itinerary:plan:${input.attempt}`;
      const fence = {
        operationId: input.operationId,
        tripId: input.tripId,
        fencingToken: input.fencingToken,
      };
      const effectKey = {
        operationId: input.operationId,
        nodeName: "plan_itinerary",
        effectScope,
      };
      const cached = await readEffectFenced(pool, fence, effectKey);
      if (cached !== undefined) {
        const stored = cached as { kind?: unknown };
        if (stored?.kind === "planned") {
          return {
            kind: "planned",
            output: plannerOutputSchema.parse((stored as { output: unknown }).output),
            mode: loaded.mode,
          };
        }
        if (stored?.kind === "rejected") {
          return {
            kind: "rejected",
            reason: String((stored as { reason?: unknown }).reason ?? "planner output rejected"),
            mode: loaded.mode,
          };
        }
      }
      const adapter = await resolveAdapter(
        "planner",
        plannerRole.promptVersion,
        input.operationId,
        input.tripId,
        input.fencingToken,
        effectScope,
      );
      const response = await adapter.generateObject({
        role: "planner",
        promptVersion: plannerRole.promptVersion,
        operationId: input.operationId,
        effectScope,
        systemPrompt: plannerRole.systemPrompt,
        context: input.context,
        outputSchema: plannerOutputSchema,
        signal: input.signal ?? new AbortController().signal,
      });
      const output = plannerOutputSchema.parse(response.value);
      const candidateIds = new Set(input.context.candidates.map((candidate) => candidate.id));
      const invented = output.stops.find(
        (stop) =>
          (stop.kind === "meal" || stop.kind === "activity") &&
          (!stop.refId || !candidateIds.has(stop.refId)),
      );
      if (invented && (invented.kind === "meal" || invented.kind === "activity")) {
        const reason = `the planner referenced an unknown candidate id ${invented.refId ?? "(missing)"}; the proposal was rejected before validation`;
        const rejection = { kind: "rejected", reason };
        await writeEffectFenced(pool, fence, effectKey, rejection);
        return { kind: "rejected", reason, mode: loaded.mode };
      }
      const stored = { kind: "planned", output };
      await writeEffectFenced(pool, fence, effectKey, stored);
      return { kind: "planned", output, mode: loaded.mode };
    },
    async review(input) {
      const effectScope = `itinerary:review:${input.attempt}`;
      const fence = {
        operationId: input.operationId,
        tripId: input.tripId,
        fencingToken: input.fencingToken,
      };
      const effectKey = {
        operationId: input.operationId,
        nodeName: "review_itinerary",
        effectScope,
      };
      const cached = await readEffectFenced(pool, fence, effectKey);
      if (cached !== undefined) {
        return { output: reviewerOutputSchema.parse(cached), mode: loaded.mode };
      }
      const adapter = await resolveAdapter(
        "reviewer",
        reviewerRole.promptVersion,
        input.operationId,
        input.tripId,
        input.fencingToken,
        effectScope,
      );
      const response = await adapter.generateObject({
        role: "reviewer",
        promptVersion: reviewerRole.promptVersion,
        operationId: input.operationId,
        effectScope,
        systemPrompt: reviewerRole.systemPrompt,
        context: input.context,
        outputSchema: reviewerOutputSchema,
        signal: input.signal ?? new AbortController().signal,
      });
      const raw = reviewerOutputSchema.parse(response.value);
      // Deterministic sanitization: suggestions may only reference event ids
      // that exist in the reviewed draft.
      const eventIds = new Set(input.context.events.map((event) => event.id));
      const output: ReviewerOutput = {
        ...raw,
        issues: raw.issues.map((issue) => ({
          ...issue,
          eventIds: issue.eventIds.filter((id) => eventIds.has(id)).slice(0, 8),
        })),
        suggestedOrder: raw.suggestedOrder.filter((id) => eventIds.has(id)).slice(0, 24),
      };
      await writeEffectFenced(pool, fence, effectKey, output);
      return { output, mode: loaded.mode };
    },
  };
}

export type { RoleProfiles };

/* ---- Phase 05: delegated flight ranking (agent authority, no fence) ---------- */

/**
 * Delegated ranking of schedule-valid flight combinations.
 *
 * The agent calls this with its tagged delegated authority; the runtime
 * revalidates the delegation, builds the flight context, and (for a real
 * provider) reserves the paid transport attempt through the restricted
 * delegated ledger before sending it. The delegated adapter is constructed
 * with a single transport attempt per reservation, so one ledger row always
 * equals one billable send. The model output must be a permutation/subset of
 * the supplied combination ids; anything else falls back to the deterministic
 * order (the caller's initial ranking) without touching the ledger again.
 */

export interface DelegatedRankingLimits {
  readonly maxCallCostUsd: string;
  readonly maxCallsPerTrip: number;
  readonly maxCostUsdPerTrip: string;
  readonly maxAttemptsPerScope: number;
  readonly taskMaxCostUsd: string;
}

/**
 * Generic delegated offer ranking (Phase 05 flights, Phase 06
 * accommodation/city-guide comparison). The agent calls this with its tagged
 * delegated authority; the runtime reserves the paid transport attempt through
 * the restricted delegated ledger before sending it. The delegated adapter is
 * constructed with a single transport attempt per reservation, so one ledger
 * row always equals one billable send. The model output must be a
 * permutation/subset of the supplied candidate ids; anything else falls back to
 * the caller's deterministic order without touching the ledger again.
 */
export interface DelegatedOfferRankingInput {
  readonly authority: DelegatedAuthority;
  /** Attempt scope, e.g. `recommendation:1` (one reservation per attempt). */
  readonly effectScope: string;
  /** Hard deadline for the paid attempt (the task's remaining active time). */
  readonly signal?: AbortSignal;
  readonly limits: DelegatedRankingLimits;
  /** Role prompt contract of the paid attempt (validated by the adapter). */
  readonly rolePrompt: { readonly promptVersion: string; readonly systemPrompt: string };
  /** Adapter-validated context (recommendation role contract). */
  readonly context: RoleContextMap["recommendation"];
  /** Candidate ids the model output may permute; membership stays binding. */
  readonly allowedIds: readonly string[];
  /** Safe fallback order when the governed output is rejected. */
  readonly deterministicOrder: readonly string[];
}

export interface DelegatedOfferRankingResult {
  readonly rankedOfferIds: string[];
  readonly reasons: { offerId: string; explanation: string }[];
  readonly mode: "fixture" | "openrouter";
  /** True when the governed output was rejected and the deterministic order kept. */
  readonly fallbackUsed: boolean;
}

export interface DelegatedFlightRankingInput {
  readonly authority: DelegatedAuthority;
  readonly tradeoff: string;
  readonly baselineOfferId: string | null;
  readonly candidates: FlightRecommendationContext["candidates"];
  /** Attempt scope, e.g. `recommendation:1` (one reservation per attempt). */
  readonly effectScope: string;
  /** Hard deadline for the paid attempt (the task's remaining active time). */
  readonly signal?: AbortSignal;
  readonly limits: DelegatedRankingLimits;
}

export type DelegatedFlightRankingResult = DelegatedOfferRankingResult;

export interface DelegatedFlightRankingDeps {
  /** Test/governance hook: forces the paid reservation path with a scripted adapter. */
  readonly paidAdapter?: LLMAdapter;
  /** Test/governance hook: profile whose prices drive the worst-case reservation. */
  readonly paidProfile?: RoleProfile;
}

/**
 * Deterministic flight order shared by the agent's initial ranking, the
 * fixture adapter and the safe fallback: party total, then total travel time,
 * then combination id. Never model output.
 */
export function deterministicFlightOrder(
  candidates: readonly FlightRecommendationContext["candidates"][number][],
): string[] {
  return [...candidates]
    .sort(
      (a, b) =>
        a.partyTotalMinor - b.partyTotalMinor ||
        a.totalDurationMinutes - b.totalDurationMinutes ||
        a.id.localeCompare(b.id),
    )
    .map((candidate) => candidate.id);
}

/** Manual permutation/subset validation: non-empty, no duplicates, all known ids. */
function validPermutation(output: { rankedOfferIds: string[] }, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  const seen = new Set<string>();
  for (const id of output.rankedOfferIds) {
    if (!allowedSet.has(id) || seen.has(id)) {
      return false;
    }
    seen.add(id);
  }
  return output.rankedOfferIds.length > 0;
}

export async function rankDelegatedOffers(
  pool: Pool,
  config: ServerConfig,
  deps: DelegatedFlightRankingDeps,
  input: DelegatedOfferRankingInput,
): Promise<DelegatedOfferRankingResult> {
  // Fixture mode is deterministic and free: no ledger row, no reservation.
  if (config.aiMode !== "openrouter" && !deps.paidAdapter) {
    return {
      rankedOfferIds: [...input.deterministicOrder],
      reasons: [],
      mode: "fixture",
      fallbackUsed: false,
    };
  }
  const profile = deps.paidProfile;
  if (!profile) {
    throw new AdapterError("AI_NOT_CONFIGURED", "no delegated model profile is configured", false);
  }
  const worst = worstCaseCostUsd(profile, {
    inputTokens: profile.maxInputTokens,
    outputTokens: profile.maxOutputTokens,
  });
  const reserved = await reserveDelegatedCall(pool, {
    agentIdentity: input.authority.agentIdentity,
    delegationId: input.authority.delegationId,
    taskId: input.authority.taskId,
    traceId: input.authority.traceId,
    effectScope: input.effectScope,
    role: "recommendation",
    model: profile.model,
    provider: profile.provider,
    promptVersion: input.rolePrompt.promptVersion,
    mode: "openrouter",
    pricingVersion: profile.pricingVersion,
    reservedTokens: profile.maxInputTokens + profile.maxOutputTokens,
    reservedCostUsd: formatUsd(worst),
    maxCallCostUsd: input.limits.maxCallCostUsd,
    maxCallsPerTrip: input.limits.maxCallsPerTrip,
    maxCostUsdPerTrip: input.limits.maxCostUsdPerTrip,
    maxAttemptsPerScope: input.limits.maxAttemptsPerScope,
    taskMaxCostUsd: input.limits.taskMaxCostUsd,
  });
  if (!reserved.ok) {
    // The ledger function's own code carries the governance reason
    // (DELEGATION_REVOKED / INPUT_EXPIRED / STALE_AGENT_RESULT /
    // AI_BUDGET_EXCEEDED / TASK_BUDGET_EXCEEDED / ...). Never collapse it.
    throw new DelegatedCallError(reserved.code, reserved.message);
  }
  const startedAt = Date.now();
  let callId: string | undefined = reserved.callId;
  try {
    const adapter = deps.paidAdapter;
    if (!adapter) {
      throw new AdapterError("AI_UNSUPPORTED", "no paid adapter configured", false);
    }
    const response = await adapter.generateObject({
      role: "recommendation",
      promptVersion: input.rolePrompt.promptVersion,
      operationId: input.authority.taskId,
      effectScope: input.effectScope,
      systemPrompt: input.rolePrompt.systemPrompt,
      context: input.context,
      outputSchema: recommendationOutputSchema,
      signal: input.signal ?? new AbortController().signal,
    });
    const parsed = recommendationOutputSchema.parse(response.value);
    // Validate BEFORE settling so the ledger records the real validation
    // outcome of this paid call.
    const accepted = validPermutation(parsed, input.allowedIds);
    const settled = await settleDelegatedCall(pool, {
      agentIdentity: input.authority.agentIdentity,
      callId,
      inputTokens: response.inputTokens ?? 0,
      outputTokens: response.outputTokens ?? 0,
      cachedInputTokens: response.cachedInputTokens ?? 0,
      reasoningOutputTokens: response.reasoningOutputTokens ?? 0,
      costUsd: response.costUsd ? Number.parseFloat(response.costUsd) : null,
      costStatus: "actual",
      latencyMs: response.latencyMs,
      finishReason: null,
      attempts: response.attempts,
      validationStatus: accepted ? "valid" : "invalid",
      errorCode: accepted ? null : "AI_SCHEMA_INVALID",
    });
    callId = undefined;
    if (!settled) {
      throw new DelegatedCallError(
        "STALE_AGENT_RESULT",
        "the delegated reservation could not be settled (already settled or unknown call id)",
      );
    }
    if (!accepted) {
      return {
        rankedOfferIds: [...input.deterministicOrder],
        reasons: [],
        mode: "openrouter",
        fallbackUsed: true,
      };
    }
    return { ...parsed, mode: "openrouter", fallbackUsed: false };
  } catch (error) {
    if (callId) {
      await markDelegatedCallUnknown(pool, {
        agentIdentity: input.authority.agentIdentity,
        callId,
        reason: error instanceof AdapterError ? error.code : "ADAPTER_ERROR",
        latencyMs: Date.now() - startedAt,
      });
    }
    throw error;
  }
}

export function createDelegatedFlightRanker(
  pool: Pool,
  config: ServerConfig,
  deps: DelegatedFlightRankingDeps = {},
): {
  rank(input: DelegatedFlightRankingInput): Promise<DelegatedFlightRankingResult>;
} {
  const fixtureFallback = (input: DelegatedFlightRankingInput): DelegatedFlightRankingResult => {
    const context = flightRecommendationContextSchema.parse({
      role: "recommendation",
      tradeoff: input.tradeoff,
      target: "flights",
      baselineOfferId: input.baselineOfferId,
      candidates: input.candidates,
    });
    const ranked = fixtureFlightRecommendation(context);
    return { ...ranked, mode: "fixture", fallbackUsed: false };
  };

  return {
    async rank(input) {
      // Phase 05 compatibility: the flight fixture adapter stays authoritative
      // in fixture mode (its reasons feed the artifact explanations).
      if (config.aiMode !== "openrouter" && !deps.paidAdapter) {
        return fixtureFallback(input);
      }
      const context = flightRecommendationContextSchema.parse({
        role: "recommendation",
        tradeoff: input.tradeoff,
        target: "flights",
        baselineOfferId: input.baselineOfferId,
        candidates: input.candidates,
      });
      return rankDelegatedOffers(pool, config, deps, {
        authority: input.authority,
        effectScope: input.effectScope,
        signal: input.signal,
        limits: input.limits,
        rolePrompt: {
          promptVersion: RECOMMENDATION_V2_PROMPT_VERSION,
          systemPrompt: RECOMMENDATION_V2_SYSTEM_PROMPT,
        },
        context,
        allowedIds: input.candidates.map((candidate) => candidate.id),
        deterministicOrder: deterministicFlightOrder(input.candidates),
      });
    },
  };
}
