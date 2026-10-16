import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { loadLocalEnv } from "../../scripts/_load-env.js";
import { TRAVEL_GRAPH_NODES, TRAVEL_GRAPH_EDGE_GROUPS } from "../../packages/workflow/src/travel/graph-definition.js";
import { TRAVEL_GRAPH_VERSION, TRAVEL_SCHEMA_VERSION } from "../../packages/workflow/src/travel/state.js";
import {
  assertDisposableDatabaseUrl,
  BASELINE_ACTIVITY_PACE,
  BASELINE_ADULTS,
  BASELINE_CASES,
  BASELINE_DEFAULT_SERVICE_LEVEL,
  BASELINE_DECISION_POLICY,
  BASELINE_INTERESTS,
  BASELINE_MAX_RECOVERY_CHOICES,
  BASELINE_ORIGIN_AIRPORT,
  BASELINE_POLL_INTERVAL_MS,
  BASELINE_REPETITIONS,
  BASELINE_RESULT_SCHEMA_VERSION,
  BASELINE_SIGHTSEEING_DATE,
  BASELINE_TRIAL_TIMEOUT_MS,
  BASELINE_USER_NAME,
  completionRate,
  NEGATIVE_ROUTE_CASE,
  summarizeLatencies,
  type BaselineCaseDefinition,
  type BaselineDbMetrics,
  type BaselineStepResult,
  type BaselineTrialResult,
} from "./baseline-cases.js";

/**
 * Phase 01 public-API baseline for the current LangGraph application.
 *
 * The harness owns an isolated fixture stack (production web server + the real
 * worker) on one disposable `*_test` database and drives complete trips through
 * the public BFF API only: create session/trip, follow the persisted pending
 * decisions using their allowed ids, acknowledge demo bookings explicitly,
 * submit the deterministic program and approve the exact persisted itinerary.
 * It never reads or manipulates checkpoint state to make a case complete.
 *
 * Measured inputs, results and every failure are written as a versioned JSON
 * artifact; see docs/planning/migration-baseline.md for interpretation.
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSX = resolve(REPO_ROOT, "node_modules/.bin/tsx");

interface CliOptions {
  readonly outputPath: string;
  readonly repetitions: number;
  readonly caseFilter: readonly string[] | null;
}

/** Read the value of an option and reject a missing value or a following flag. */
function optionValue(argv: readonly string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let outputPath = ".cache/benchmarks/langgraph-baseline.json";
  let repetitions = BASELINE_REPETITIONS;
  let caseFilter: readonly string[] | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") {
      outputPath = optionValue(argv, index, "--output");
      index += 1;
    } else if (arg === "--repetitions") {
      repetitions = Number.parseInt(optionValue(argv, index, "--repetitions"), 10);
      index += 1;
    } else if (arg === "--cases") {
      caseFilter = optionValue(argv, index, "--cases")
        .split(",")
        .filter((value) => value.length > 0);
      index += 1;
    } else if (arg === "--help") {
      process.stdout.write(
        "Usage: npm run benchmark:baseline -- [--output <path>] [--repetitions <n>] [--cases <id,id>]\n" +
          "Requires DATABASE_URL pointing at a disposable *_test database, PUBLIC_BASE_URL for the\n" +
          "dedicated origin, and a prior `npm run build`. The harness owns its web server and worker.\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    throw new Error("--repetitions must be a positive integer.");
  }
  return { outputPath, repetitions, caseFilter };
}

/* ---- Environment and process management ------------------------------------ */

interface StackContext {
  readonly origin: string;
  readonly port: string;
  readonly databaseUrl: string;
  readonly databaseName: string;
  readonly pool: Pool;
}

function fail(message: string): never {
  process.stderr.write(`benchmark: ${message}\n`);
  process.exit(1);
}

function databaseParts(databaseUrl: string): { name: string; host: string; port: string } {
  const url = new URL(databaseUrl);
  return {
    name: assertDisposableDatabaseUrl(databaseUrl),
    host: url.hostname,
    port: url.port || "5432",
  };
}

async function assertPortFree(host: string, port: string): Promise<void> {
  await new Promise<void>((resolveCheck, rejectCheck) => {
    const socket = createConnection({ host, port: Number.parseInt(port, 10) });
    socket.once("connect", () => {
      socket.destroy();
      rejectCheck(
        new Error(
          `port ${port} on ${host} is already in use; the benchmark must own its isolated stack ` +
            "(stop the running server or choose another PUBLIC_BASE_URL port)",
        ),
      );
    });
    socket.once("error", () => {
      socket.destroy();
      resolveCheck();
    });
  });
}

function startWorker(context: { databaseUrl: string }): ChildProcess {
  return spawn(TSX, ["--tsconfig", "tsconfig.json", "apps/worker/src/main.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: context.databaseUrl,
      AI_MODE: "fixture",
      WORKER_CONCURRENCY: "1",
      // The benchmark uses committed reference assets only: never curate
      // landmarks over the network during a controlled baseline.
      WIKIDATA_DISCOVERY: "false",
    },
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
}

function startWebServer(context: { databaseUrl: string; origin: string; port: string }): ChildProcess {
  return spawn("npm", ["run", "start", "-w", "@odft/web"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: context.databaseUrl,
      PUBLIC_BASE_URL: `${context.origin}/`,
      PORT: context.port,
      AI_MODE: "fixture",
    },
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
}

function stopChild(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    if (child.pid) {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    child.kill("SIGKILL");
  }
}

async function waitForReady(origin: string, server: ChildProcess): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`web server exited before becoming ready (exit ${server.exitCode ?? server.signalCode})`);
    }
    try {
      const response = await fetch(`${origin}/api/health/ready`);
      if (response.status === 200) {
        return;
      }
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error("the isolated stack did not become ready within 120s");
    }
    await sleep(500);
  }
}

/* ---- Public-API driver ------------------------------------------------------ */

interface SessionContext {
  readonly cookie: string;
  readonly csrfToken: string;
}

interface HttpResult {
  readonly status: number;
  readonly body: unknown;
}

async function apiPost(
  origin: string,
  path: string,
  session: SessionContext | null,
  payload: unknown,
): Promise<HttpResult> {
  const headers: Record<string, string> = {
    origin,
    "content-type": "application/json",
  };
  if (session) {
    headers.cookie = session.cookie;
    headers["x-csrf-token"] = session.csrfToken;
  }
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await safeJson(response) };
}

async function apiGet(origin: string, path: string, session: SessionContext): Promise<HttpResult> {
  const response = await fetch(`${origin}${path}`, { headers: { cookie: session.cookie } });
  return { status: response.status, body: await safeJson(response) };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function createSession(origin: string): Promise<SessionContext> {
  const response = await fetch(`${origin}/api/session`, { method: "POST", headers: { origin } });
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`session creation failed with HTTP ${response.status}`);
  }
  const cookies = response.headers.getSetCookie();
  const cookie = cookies.map((value) => value.split(";")[0]).join("; ");
  const body = (await response.json()) as { csrfToken?: string };
  if (!cookie || !body.csrfToken) {
    throw new Error("session creation returned no cookie or CSRF token");
  }
  return { cookie, csrfToken: body.csrfToken };
}

interface ProjectionLike {
  readonly trip: {
    readonly id: string;
    readonly revision: number;
    readonly workflowStatus: string;
    readonly recoveryRequired: boolean;
  };
  readonly pendingDecision: {
    readonly id: string;
    readonly kind: string;
    readonly allowedOfferIds: readonly string[];
    readonly allowedOptionIds: readonly string[];
    readonly proposalId?: string;
  } | null;
  readonly flights: {
    readonly routeStatus: string;
    readonly routeReasons: readonly { readonly code: string; readonly explanation: string }[];
    readonly offers: readonly { readonly id: string }[];
  };
  readonly meals: readonly { readonly id: string; readonly meal: string }[];
  readonly program: {
    readonly mealDefaults: { breakfast: string | null; lunch: string | null; dinner: string | null };
    readonly dinnerNotIncludedReason: string | null;
  } | null;
  readonly itinerary: { readonly id: string; readonly version: number; readonly approvedVersion: number | null } | null;
  readonly proposal: { readonly id: string } | null;
}

async function getProjection(origin: string, session: SessionContext, tripId: string): Promise<ProjectionLike> {
  const result = await apiGet(origin, `/api/trips/${tripId}`, session);
  if (result.status !== 200) {
    throw new Error(`projection read failed with HTTP ${result.status}`);
  }
  return result.body as ProjectionLike;
}

interface DecisionAction {
  readonly response: Record<string, unknown>;
  readonly chosenId: string | null;
}

/** Deterministic escalation counters of one trial (see BASELINE_DECISION_POLICY). */
interface DriverPolicyState {
  hotelSelections: number;
  programSubmissions: number;
  recoveryChoices: number;
}

/** Deterministic offer/option pick: the index-th id, wrapping around. */
function pickNth(ids: readonly string[], index: number): string | null {
  if (ids.length === 0) {
    return null;
  }
  return ids[index % ids.length] ?? null;
}

/**
 * Deterministic public decision policy. Only the decision kinds of the normal
 * fixture journey are handled; anything else fails the trial (it would mean
 * the fixed inputs did not follow the expected path).
 *
 * A `recovery` decision is a legitimate persisted decision: the driver answers
 * it with one of the offered option ids (deterministic alternation, bounded by
 * the caller) and escalates the reopened selection — the next hotel offer or
 * the next meal offer per category — exactly like a user adjusting the plan.
 */
function decideResponse(
  decision: NonNullable<ProjectionLike["pendingDecision"]>,
  projection: ProjectionLike,
  policy: DriverPolicyState,
): DecisionAction | null {
  switch (decision.kind) {
    case "flight_choice": {
      const offerId = decision.allowedOfferIds[0];
      return offerId ? { response: { action: "choose_offer", offerId }, chosenId: offerId } : null;
    }
    case "hotel_choice": {
      const offerId = pickNth(decision.allowedOfferIds, policy.hotelSelections);
      if (!offerId) {
        return null;
      }
      policy.hotelSelections += 1;
      return { response: { action: "choose_offer", offerId }, chosenId: offerId };
    }
    case "booking_confirmation":
    case "replacement_confirmation": {
      const proposalId = decision.proposalId ?? projection.proposal?.id;
      return proposalId
        ? {
            response: {
              action: "confirm_booking",
              proposalId,
              acceptedDemoDisclaimer: true,
            },
            chosenId: proposalId,
          }
        : null;
    }
    case "program_choices": {
      const program = projection.program;
      if (!program) {
        return null;
      }
      const offersOf = (meal: "breakfast" | "lunch" | "dinner"): readonly string[] =>
        projection.meals.filter((offer) => offer.meal === meal).map((offer) => offer.id);
      const chooseMeal = (meal: "breakfast" | "lunch" | "dinner"): string | null => {
        if (policy.programSubmissions === 0) {
          const fallbackDefault = program.mealDefaults[meal];
          if (fallbackDefault) {
            return fallbackDefault;
          }
        }
        return pickNth(offersOf(meal), policy.programSubmissions);
      };
      const breakfast = chooseMeal("breakfast");
      const lunch = chooseMeal("lunch");
      if (!breakfast || !lunch) {
        return null;
      }
      const dinner = program.dinnerNotIncludedReason ? null : chooseMeal("dinner");
      policy.programSubmissions += 1;
      return {
        response: {
          action: "submit_program",
          mealOfferIds: { breakfast, lunch, dinner },
          selfArrangedMeals: [],
          preferredActivityIds: [],
          activitiesSelfArranged: false,
        },
        chosenId: null,
      };
    }
    case "recovery": {
      const optionId = pickNth(decision.allowedOptionIds, policy.recoveryChoices);
      if (!optionId) {
        return null;
      }
      policy.recoveryChoices += 1;
      return { response: { action: "choose_option", optionId }, chosenId: optionId };
    }
    case "itinerary_approval": {
      const itineraryId = projection.itinerary?.id;
      return itineraryId
        ? { response: { action: "approve_itinerary", itineraryId }, chosenId: itineraryId }
        : null;
    }
    default:
      return null;
  }
}

/* ---- Database metrics ------------------------------------------------------- */

const METRIC_SCHEMAS = "('odft_app','odft_checkpoint')";

async function readDbMetrics(pool: Pool): Promise<BaselineDbMetrics> {
  const database = await pool.query<{
    xact_commit: string;
    xact_rollback: string;
    blks_read: string;
    blks_hit: string;
  }>(
    `SELECT xact_commit, xact_rollback, blks_read, blks_hit
       FROM pg_stat_database WHERE datname = current_database()`,
  );
  const tables = await pool.query<{
    inserted: string;
    updated: string;
    deleted: string;
    seq: string;
    idx: string;
  }>(
    `SELECT coalesce(sum(n_tup_ins),0) AS inserted, coalesce(sum(n_tup_upd),0) AS updated,
            coalesce(sum(n_tup_del),0) AS deleted, coalesce(sum(seq_scan),0) AS seq,
            coalesce(sum(idx_scan),0) AS idx
       FROM pg_stat_user_tables WHERE schemaname IN ${METRIC_SCHEMAS}`,
  );
  let statements: { calls: number; totalExecMs: number } | null = null;
  const extension = await pool.query<{ present: boolean }>(
    `SELECT count(*) > 0 AS present FROM pg_extension WHERE extname = 'pg_stat_statements'`,
  );
  if (extension.rows[0]?.present) {
    const stats = await pool.query<{ calls: string; total_exec_time: number }>(
      `SELECT coalesce(sum(calls),0) AS calls, coalesce(sum(total_exec_time),0) AS total_exec_time
         FROM pg_stat_statements
        WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    statements = {
      calls: Number(stats.rows[0]?.calls ?? 0),
      totalExecMs: Math.round(Number(stats.rows[0]?.total_exec_time ?? 0)),
    };
  }
  const row = database.rows[0];
  return {
    xactCommit: Number(row?.xact_commit ?? 0),
    xactRollback: Number(row?.xact_rollback ?? 0),
    blksRead: Number(row?.blks_read ?? 0),
    blksHit: Number(row?.blks_hit ?? 0),
    tuplesInserted: Number(tables.rows[0]?.inserted ?? 0),
    tuplesUpdated: Number(tables.rows[0]?.updated ?? 0),
    tuplesDeleted: Number(tables.rows[0]?.deleted ?? 0),
    seqScans: Number(tables.rows[0]?.seq ?? 0),
    indexScans: Number(tables.rows[0]?.idx ?? 0),
    pgStatStatements: statements,
  };
}

function diffDbMetrics(before: BaselineDbMetrics, after: BaselineDbMetrics): BaselineDbMetrics {
  const diffStatements =
    before.pgStatStatements && after.pgStatStatements
      ? {
          calls: after.pgStatStatements.calls - before.pgStatStatements.calls,
          totalExecMs: after.pgStatStatements.totalExecMs - before.pgStatStatements.totalExecMs,
        }
      : null;
  return {
    xactCommit: after.xactCommit - before.xactCommit,
    xactRollback: after.xactRollback - before.xactRollback,
    blksRead: after.blksRead - before.blksRead,
    blksHit: after.blksHit - before.blksHit,
    tuplesInserted: after.tuplesInserted - before.tuplesInserted,
    tuplesUpdated: after.tuplesUpdated - before.tuplesUpdated,
    tuplesDeleted: after.tuplesDeleted - before.tuplesDeleted,
    seqScans: after.seqScans - before.seqScans,
    indexScans: after.indexScans - before.indexScans,
    pgStatStatements: diffStatements,
  };
}

interface TrialDetail {
  readonly reservations: { serviceKey: string; demoReference: string }[];
  readonly fixtureAiInvocations: { planner: number; reviewer: number };
  readonly llmCalls: number;
  readonly llmReservedTokens: number;
  readonly llmActualTokens: number;
  readonly llmReservedUsd: number;
  readonly llmActualUsd: number;
  readonly llmUnknownReserved: number;
  readonly scenarioSeed: string | null;
  readonly scenarioGeneratorVersion: string | null;
  readonly scenarioReferenceVersion: string | null;
}

async function readTrialDetail(pool: Pool, tripId: string): Promise<TrialDetail> {
  const reservations = await pool.query<{ service_key: string; demo_reference: string }>(
    `SELECT service_key, demo_reference FROM odft_app.reservations
      WHERE trip_id = $1 AND status = 'confirmed' ORDER BY service_key`,
    [tripId],
  );
  const aiEvents = await pool.query<{ type: string; count: string }>(
    `SELECT type, count(*) AS count FROM odft_app.execution_events
      WHERE trip_id = $1 AND type IN ('itinerary.attempt_started','itinerary.review_started')
      GROUP BY type`,
    [tripId],
  );
  const llm = await pool.query<{
    calls: string;
    reserved_tokens: string | null;
    actual_tokens: string | null;
    reserved: string;
    actual: string | null;
    unknown: string;
  }>(
    `SELECT count(*) AS calls, sum(reserved_tokens) AS reserved_tokens,
            sum(actual_tokens) AS actual_tokens, coalesce(sum(reserved_cost_usd),0) AS reserved,
            sum(actual_cost_usd) AS actual,
            count(*) FILTER (WHERE cost_status = 'unknown_reserved') AS unknown
       FROM odft_app.llm_calls WHERE trip_id = $1`,
    [tripId],
  );
  const scenario = await pool.query<{
    seed: string;
    generator: string;
    reference: string;
  }>(
    `SELECT manifest->>'seed' AS seed, manifest->>'generatorVersion' AS generator,
            manifest->>'referenceVersion' AS reference
       FROM odft_app.scenario_snapshots WHERE trip_id = $1
      ORDER BY snapshot_version ASC LIMIT 1`,
    [tripId],
  );
  const countOf = (type: string): number =>
    Number(aiEvents.rows.find((row) => row.type === type)?.count ?? 0);
  return {
    reservations: reservations.rows.map((row) => ({
      serviceKey: row.service_key,
      demoReference: row.demo_reference,
    })),
    fixtureAiInvocations: {
      planner: countOf("itinerary.attempt_started"),
      reviewer: countOf("itinerary.review_started"),
    },
    llmCalls: Number(llm.rows[0]?.calls ?? 0),
    llmReservedTokens: Number(llm.rows[0]?.reserved_tokens ?? 0),
    llmActualTokens: Number(llm.rows[0]?.actual_tokens ?? 0),
    llmReservedUsd: Number(llm.rows[0]?.reserved ?? 0),
    llmActualUsd: Number(llm.rows[0]?.actual ?? 0),
    llmUnknownReserved: Number(llm.rows[0]?.unknown ?? 0),
    scenarioSeed: scenario.rows[0]?.seed ?? null,
    scenarioGeneratorVersion: scenario.rows[0]?.generator ?? null,
    scenarioReferenceVersion: scenario.rows[0]?.reference ?? null,
  };
}

/* ---- Trials ----------------------------------------------------------------- */

function caseInput(caseDef: BaselineCaseDefinition, originAirportId: string, destinationCityId: string) {
  return {
    creationRequestId: randomUUID(),
    userName: BASELINE_USER_NAME,
    adults: BASELINE_ADULTS,
    originAirportId,
    destinationCityId,
    destinationCountryKey: caseDef.destination.countryKey,
    sightseeingDate: BASELINE_SIGHTSEEING_DATE,
    travelVariant: caseDef.variant,
    preferences: {
      travelVariant: caseDef.variant,
      defaultServiceLevel: BASELINE_DEFAULT_SERVICE_LEVEL,
      serviceOverrides: {},
      activityPace: BASELINE_ACTIVITY_PACE,
      interests: { ...BASELINE_INTERESTS },
      preferredActivityTags: [],
      minimumActivityCounts: {},
    },
  };
}

async function resolveReferenceIds(
  origin: string,
  session: SessionContext,
  caseDef: BaselineCaseDefinition,
): Promise<{ originAirportId: string; destinationCityId: string }> {
  const airports = await apiGet(
    origin,
    `/api/reference/airports?q=${encodeURIComponent(BASELINE_ORIGIN_AIRPORT.query)}&limit=20`,
    session,
  );
  const airportItems = (airports.body as { items?: { id: string; iata: string }[] } | null)?.items ?? [];
  const airport = airportItems.find((item) => item.iata === BASELINE_ORIGIN_AIRPORT.query);
  if (airport?.id !== BASELINE_ORIGIN_AIRPORT.expectedId) {
    throw new Error(
      `reference airport resolution changed: expected ${BASELINE_ORIGIN_AIRPORT.expectedId}, got ${airport?.id ?? "none"}`,
    );
  }
  const cities = await apiGet(
    origin,
    `/api/reference/cities?country=${caseDef.destination.countryKey}&q=${encodeURIComponent(caseDef.destination.cityQuery)}&limit=20`,
    session,
  );
  const cityItems = (cities.body as { items?: { id: string; name: string }[] } | null)?.items ?? [];
  const city = cityItems.find((item) => item.id === caseDef.destination.expectedCityId);
  if (!city) {
    throw new Error(
      `reference city resolution changed: expected ${caseDef.destination.expectedCityId} for "${caseDef.destination.cityQuery}"`,
    );
  }
  return { originAirportId: airport.id, destinationCityId: city.id };
}

async function truncateRateLimits(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE odft_app.rate_limit_buckets");
}

async function runTrial(
  context: StackContext,
  caseDef: BaselineCaseDefinition,
  referenceIds: { originAirportId: string; destinationCityId: string },
  repetition: number,
): Promise<BaselineTrialResult> {
  await truncateRateLimits(context.pool);
  const dbBefore = await readDbMetrics(context.pool);
  const trialStart = Date.now();
  const steps: BaselineStepResult[] = [];
  let tripId: string | null = null;
  let completed = false;
  let failureReason: string | null = null;
  let pendingSubmitted: { kind: string; action: string; chosenId: string | null } | null = null;
  let pendingStart = trialStart;
  let observedDecisionId: string | null = null;
  let waitingWithoutDecisionSince: number | null = null;
  let finalItinerary: { version: number; approvedVersion: number | null } | null = null;
  const policy: DriverPolicyState = { hotelSelections: 0, programSubmissions: 0, recoveryChoices: 0 };

  const recordPendingStep = (outcome: string): void => {
    if (pendingSubmitted) {
      steps.push({
        submittedDecisionKind: pendingSubmitted.kind,
        submittedAction: pendingSubmitted.action,
        observedOutcome: outcome,
        latencyMs: Date.now() - pendingStart,
        chosenId: pendingSubmitted.chosenId,
      });
      pendingSubmitted = null;
    } else if (steps.length === 0) {
      steps.push({
        submittedDecisionKind: null,
        submittedAction: null,
        observedOutcome: outcome,
        latencyMs: Date.now() - pendingStart,
        chosenId: null,
      });
    }
  };

  try {
    const session = await createSession(context.origin);
    const created = await apiPost(context.origin, "/api/trips", session, caseInput(caseDef, referenceIds.originAirportId, referenceIds.destinationCityId));
    if (created.status !== 201) {
      throw new Error(`trip creation failed with HTTP ${created.status}`);
    }
    tripId = (created.body as { tripId: string }).tripId;
    const deadline = Date.now() + BASELINE_TRIAL_TIMEOUT_MS;

    for (;;) {
      if (Date.now() > deadline) {
        failureReason = "trial_timeout";
        break;
      }
      const projection = await getProjection(context.origin, session, tripId);
      if (projection.itinerary) {
        finalItinerary = {
          version: projection.itinerary.version,
          approvedVersion: projection.itinerary.approvedVersion,
        };
      }
      const decision = projection.pendingDecision;

      if (!decision) {
        const status = projection.trip.workflowStatus;
        if (projection.trip.recoveryRequired) {
          failureReason = "recovery_required";
          break;
        }
        if (status === "failed" || status === "blocked") {
          failureReason = `workflow_${status}`;
          break;
        }
        if (status === "ready") {
          if (projection.itinerary?.approvedVersion != null) {
            completed = true;
          } else {
            failureReason = "ready_without_approved_itinerary";
          }
          break;
        }
        if (status === "waiting_user") {
          waitingWithoutDecisionSince ??= Date.now();
          if (Date.now() - waitingWithoutDecisionSince > 15_000) {
            failureReason = "waiting_user_without_pending_decision";
            break;
          }
        } else {
          waitingWithoutDecisionSince = null;
        }
      } else {
        waitingWithoutDecisionSince = null;
        if (decision.id !== observedDecisionId) {
          recordPendingStep(decision.kind);
          if (decision.kind === "recovery" && policy.recoveryChoices >= BASELINE_MAX_RECOVERY_CHOICES) {
            failureReason = "recovery_limit_reached";
            break;
          }
          const decided = decideResponse(decision, projection, policy);
          if (!decided) {
            failureReason = `unsupported_decision:${decision.kind}`;
            break;
          }
          const resumed = await apiPost(context.origin, `/api/trips/${tripId}/resume`, session, {
            requestId: randomUUID(),
            expectedRevision: projection.trip.revision,
            decisionId: decision.id,
            response: decided.response,
          });
          if (resumed.status !== 202) {
            const code =
              (resumed.body as { code?: string } | null)?.code ?? `http_${resumed.status}`;
            failureReason = `resume_rejected:${code}`;
            break;
          }
          observedDecisionId = decision.id;
          pendingSubmitted = { kind: decision.kind, action: decided.response.action as string, chosenId: decided.chosenId };
          pendingStart = Date.now();
        }
      }
      await sleep(BASELINE_POLL_INTERVAL_MS);
    }
  } catch (error) {
    failureReason = `harness_error:${error instanceof Error ? error.message : String(error)}`;
  }

  recordPendingStep(completed ? "completed" : (failureReason ?? "unknown"));

  const dbAfter = await readDbMetrics(context.pool);
  const detail: TrialDetail = tripId
    ? await readTrialDetail(context.pool, tripId)
    : {
        reservations: [],
        fixtureAiInvocations: { planner: 0, reviewer: 0 },
        llmCalls: 0,
        llmReservedTokens: 0,
        llmActualTokens: 0,
        llmReservedUsd: 0,
        llmActualUsd: 0,
        llmUnknownReserved: 0,
        scenarioSeed: null,
        scenarioGeneratorVersion: null,
        scenarioReferenceVersion: null,
      };
  return {
    caseId: caseDef.id,
    repetition,
    tripId,
    completed,
    failureReason,
    totalLatencyMs: Date.now() - trialStart,
    steps,
    itineraryVersion: finalItinerary?.version ?? null,
    itineraryApprovedVersion: finalItinerary?.approvedVersion ?? null,
    reservations: detail.reservations,
    fixtureAiInvocations: detail.fixtureAiInvocations,
    llmCalls: detail.llmCalls,
    llmReservedTokens: detail.llmReservedTokens,
    llmActualTokens: detail.llmActualTokens,
    llmReservedUsd: detail.llmReservedUsd,
    llmActualUsd: detail.llmActualUsd,
    llmUnknownReserved: detail.llmUnknownReserved,
    db: diffDbMetrics(dbBefore, dbAfter),
    scenarioSeed: detail.scenarioSeed,
    scenarioGeneratorVersion: detail.scenarioGeneratorVersion,
    scenarioReferenceVersion: detail.scenarioReferenceVersion,
  };
}

/* ---- Negative route case ---------------------------------------------------- */

interface NegativeCaseResult {
  readonly caseId: string;
  readonly tripId: string | null;
  readonly pass: boolean;
  readonly routeStatus: string | null;
  readonly routeReasonCodes: readonly string[];
  readonly flightOffers: number;
  readonly workflowStatus: string | null;
  readonly scenarioSnapshots: number;
  readonly confirmedReservations: number;
  readonly failureReason: string | null;
}

async function runNegativeCase(context: StackContext): Promise<NegativeCaseResult> {
  await truncateRateLimits(context.pool);
  let tripId: string | null = null;
  let failureReason: string | null = null;
  let routeStatus: string | null = null;
  let routeReasonCodes: string[] = [];
  let flightOffers = 0;
  let workflowStatus: string | null = null;
  try {
    const session = await createSession(context.origin);
    const created = await apiPost(context.origin, "/api/trips", session, {
      creationRequestId: randomUUID(),
      userName: BASELINE_USER_NAME,
      adults: BASELINE_ADULTS,
      originAirportId: NEGATIVE_ROUTE_CASE.originAirportId,
      destinationCityId: NEGATIVE_ROUTE_CASE.destinationCityId,
      destinationCountryKey: NEGATIVE_ROUTE_CASE.destinationCountryKey,
      sightseeingDate: BASELINE_SIGHTSEEING_DATE,
      travelVariant: NEGATIVE_ROUTE_CASE.variant,
    });
    if (created.status !== 201) {
      throw new Error(`trip creation failed with HTTP ${created.status}`);
    }
    tripId = (created.body as { tripId: string }).tripId;
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (Date.now() > deadline) {
        failureReason = "negative_case_timeout";
        break;
      }
      const projection = await getProjection(context.origin, session, tripId);
      routeStatus = projection.flights.routeStatus;
      flightOffers = projection.flights.offers.length;
      workflowStatus = projection.trip.workflowStatus;
      // The route validation persists in its own transaction, before the
      // operation finalizes `workflow_status`; breaking on the route status
      // alone could read a still-running trip and record a false failure.
      const terminal =
        workflowStatus === "blocked" || workflowStatus === "ready" || workflowStatus === "failed";
      if (routeStatus !== "PENDING" && terminal) {
        routeReasonCodes = projection.flights.routeReasons.map((entry) => entry.code);
        break;
      }
      await sleep(BASELINE_POLL_INTERVAL_MS);
    }
  } catch (error) {
    failureReason = `harness_error:${error instanceof Error ? error.message : String(error)}`;
  }

  let scenarioSnapshots = 0;
  let confirmedReservations = 0;
  if (tripId) {
    const snapshots = await context.pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM odft_app.scenario_snapshots WHERE trip_id = $1`,
      [tripId],
    );
    scenarioSnapshots = Number(snapshots.rows[0]?.count ?? 0);
    const reservations = await context.pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM odft_app.reservations WHERE trip_id = $1`,
      [tripId],
    );
    confirmedReservations = Number(reservations.rows[0]?.count ?? 0);
  }
  const pass =
    failureReason === null &&
    routeStatus === "INFEASIBLE" &&
    flightOffers === 0 &&
    workflowStatus === "blocked" &&
    scenarioSnapshots === 0 &&
    confirmedReservations === 0;
  return {
    caseId: NEGATIVE_ROUTE_CASE.id,
    tripId,
    pass,
    routeStatus,
    routeReasonCodes,
    flightOffers,
    workflowStatus,
    scenarioSnapshots,
    confirmedReservations,
    failureReason,
  };
}

/* ---- Aggregation and reporting ---------------------------------------------- */

function gitState(): { commit: string; dirty: boolean; dirtyFiles: string[] } {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).toString().trim();
  const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT })
    .toString()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3));
  return { commit, dirty: porcelain.length > 0, dirtyFiles: porcelain };
}

interface CaseSummary {
  readonly caseId: string;
  readonly label: string;
  readonly trials: number;
  readonly completed: number;
  readonly completionRate: number | null;
  readonly totalLatencyMs: ReturnType<typeof summarizeLatencies>;
  readonly stepLatencyMs: Record<string, ReturnType<typeof summarizeLatencies>>;
  readonly failures: { repetition: number; reason: string }[];
}

function summarizeCase(caseDef: BaselineCaseDefinition, trials: readonly BaselineTrialResult[]): CaseSummary {
  const completedTrials = trials.filter((trial) => trial.completed);
  const stepLatencies = new Map<string, number[]>();
  for (const trial of completedTrials) {
    for (const step of trial.steps) {
      const key = step.submittedDecisionKind ?? "initial_planning";
      const list = stepLatencies.get(key) ?? [];
      list.push(step.latencyMs);
      stepLatencies.set(key, list);
    }
  }
  return {
    caseId: caseDef.id,
    label: caseDef.label,
    trials: trials.length,
    completed: completedTrials.length,
    completionRate: completionRate(completedTrials.length, trials.length),
    totalLatencyMs: summarizeLatencies(completedTrials.map((trial) => trial.totalLatencyMs)),
    stepLatencyMs: Object.fromEntries(
      [...stepLatencies.entries()].map(([key, values]) => [key, summarizeLatencies(values)]),
    ),
    failures: trials
      .filter((trial) => !trial.completed)
      .map((trial) => ({ repetition: trial.repetition, reason: trial.failureReason ?? "unknown" })),
  };
}

function printSummary(caseSummaries: readonly CaseSummary[], trials: readonly BaselineTrialResult[]): void {
  const total = trials.length;
  const completed = trials.filter((trial) => trial.completed).length;
  process.stdout.write(`\n=== Baseline summary ===\n`);
  for (const summary of caseSummaries) {
    const totalLatency = summary.totalLatencyMs;
    process.stdout.write(
      `${summary.caseId}: ${summary.completed}/${summary.trials} completed` +
        (totalLatency ? `, total p50 ${totalLatency.p50} ms / p95 ${totalLatency.p95} ms` : "") +
        (summary.failures.length > 0 ? `, failures: ${summary.failures.map((f) => f.reason).join(", ")}` : "") +
        "\n",
    );
  }
  const overall = summarizeLatencies(trials.filter((trial) => trial.completed).map((trial) => trial.totalLatencyMs));
  process.stdout.write(
    `overall: ${completed}/${total} completed` +
      (overall ? `, total p50 ${overall.p50} ms / p95 ${overall.p95} ms` : "") +
      "\n",
  );
}

/* ---- Main ------------------------------------------------------------------- */

async function main(): Promise<void> {
  loadLocalEnv();
  const options = parseArgs(process.argv.slice(2));

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    fail("DATABASE_URL is required (a disposable *_test database).");
  }
  let database: { name: string; host: string; port: string };
  try {
    database = databaseParts(databaseUrl);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000/";
  const origin = new URL(publicBaseUrl).origin;
  const port = new URL(origin).port || (new URL(origin).protocol === "https:" ? "443" : "80");

  if (!existsSync(resolve(REPO_ROOT, "apps/web/.next/BUILD_ID"))) {
    fail("the production web build is missing; run `npm run build` first.");
  }
  if (!existsSync(resolve(REPO_ROOT, "node_modules/.bin/tsx"))) {
    fail("tsx is missing; run `npm install` first.");
  }

  const cases = options.caseFilter
    ? BASELINE_CASES.filter((caseDef) => options.caseFilter?.includes(caseDef.id))
    : BASELINE_CASES;
  if (cases.length === 0) {
    fail("no cases matched --cases.");
  }

  // Isolation preconditions: refuse before any mutation when another process
  // (a live application stack) is attached to the disposable target.
  const probePool = new Pool({ connectionString: databaseUrl, max: 1, application_name: "odft-baseline-probe" });
  const otherConnections = await probePool.query<{ count: string }>(
    `SELECT count(*) AS count FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()`,
  );
  const attached = Number(otherConnections.rows[0]?.count ?? 0);
  if (attached > 0) {
    fail(
      `database "${database.name}" has ${attached} other active connection(s); ` +
        "the benchmark must own its isolated stack (stop the E2E/dev services first).",
    );
  }
  try {
    await assertPortFree(new URL(origin).hostname, port);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 2, application_name: "odft-baseline-metrics" });
  let server: ChildProcess | null = null;
  let worker: ChildProcess | null = null;
  let exitCode = 0;

  const cleanup = (): void => {
    stopChild(worker);
    stopChild(server);
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  try {
    process.stdout.write(
      `benchmark: database=${database.name} origin=${origin} cases=${cases.length} repetitions=${options.repetitions}\n`,
    );
    worker = startWorker({ databaseUrl });
    server = startWebServer({ databaseUrl, origin, port });
    await waitForReady(origin, server);
    await probePool.end();

    const referenceSession = await createSession(origin);
    const referenceIds = new Map<string, { originAirportId: string; destinationCityId: string }>();
    for (const caseDef of cases) {
      const key = `${caseDef.destination.countryKey}:${caseDef.destination.cityQuery}`;
      if (!referenceIds.has(key)) {
        referenceIds.set(key, await resolveReferenceIds(origin, referenceSession, caseDef));
      }
    }

    const context: StackContext = { origin, port, databaseUrl, databaseName: database.name, pool };
    const allTrials: BaselineTrialResult[] = [];
    const caseSummaries: CaseSummary[] = [];
    for (const caseDef of cases) {
      const ids = referenceIds.get(`${caseDef.destination.countryKey}:${caseDef.destination.cityQuery}`);
      if (!ids) {
        throw new Error(`no resolved reference ids for ${caseDef.id}`);
      }
      const caseTrials: BaselineTrialResult[] = [];
      for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
        const trial = await runTrial(context, caseDef, ids, repetition);
        caseTrials.push(trial);
        allTrials.push(trial);
        process.stdout.write(
          `  ${caseDef.id} #${repetition}: ${trial.completed ? "completed" : `FAILED (${trial.failureReason})`} in ${trial.totalLatencyMs} ms\n`,
        );
      }
      caseSummaries.push(summarizeCase(caseDef, caseTrials));
    }

    const negativeCase = await runNegativeCase(context);
    process.stdout.write(
      `  ${negativeCase.caseId}: ${negativeCase.pass ? "PASS" : "FAIL"} (route ${negativeCase.routeStatus}, offers ${negativeCase.flightOffers}, snapshots ${negativeCase.scenarioSnapshots})\n`,
    );

    const overall = summarizeLatencies(allTrials.filter((trial) => trial.completed).map((trial) => trial.totalLatencyMs));
    const document = {
      schemaVersion: BASELINE_RESULT_SCHEMA_VERSION,
      kind: "odft-langgraph-travel-baseline",
      generatedAt: new Date().toISOString(),
      git: gitState(),
      graph: {
        version: TRAVEL_GRAPH_VERSION,
        stateSchemaVersion: TRAVEL_SCHEMA_VERSION,
        nodeCount: TRAVEL_GRAPH_NODES.length,
        edgeGroupCount: TRAVEL_GRAPH_EDGE_GROUPS.length,
      },
      environment: {
        node: process.version,
        platform: process.platform,
        origin,
        database: { name: database.name, host: database.host, port: database.port },
        aiMode: "fixture",
        wikidataDiscovery: false,
        workerConcurrency: 1,
        webServerPort: port,
        pollIntervalMs: BASELINE_POLL_INTERVAL_MS,
        trialTimeoutMs: BASELINE_TRIAL_TIMEOUT_MS,
        measurementScope:
          "pg_stat_database (whole database) and pg_stat_user_tables summed over schemas odft_app and odft_checkpoint, " +
          "per-trial deltas; polling GET /api/trips/[id] every " +
          `${BASELINE_POLL_INTERVAL_MS} ms is included in the measured activity.`,
      },
      inputs: {
        cases: cases.map((caseDef) => ({ id: caseDef.id, variant: caseDef.variant, destination: caseDef.destination })),
        userName: BASELINE_USER_NAME,
        adults: BASELINE_ADULTS,
        sightseeingDate: BASELINE_SIGHTSEEING_DATE,
        defaultServiceLevel: BASELINE_DEFAULT_SERVICE_LEVEL,
        activityPace: BASELINE_ACTIVITY_PACE,
        interests: BASELINE_INTERESTS,
        decisionPolicy: BASELINE_DECISION_POLICY,
        seedNote:
          "The scenario seed is derived by the application from the persisted route fingerprint; " +
          "the resolved seed and versions are recorded per trial.",
      },
      referenceResolution: Object.fromEntries(
        [...referenceIds.entries()].map(([key, ids]) => [key, ids]),
      ),
      repetitions: options.repetitions,
      cases: caseSummaries,
      trials: allTrials,
      overall: {
        trials: allTrials.length,
        completed: allTrials.filter((trial) => trial.completed).length,
        completionRate: completionRate(allTrials.filter((trial) => trial.completed).length, allTrials.length),
        totalLatencyMs: overall,
      },
      negativeCase,
      limitations: [
        "Fixture AI mode: no paid model calls and zero LLM USD; fixture planner/reviewer invocations are counted from persisted execution events.",
        "Latency is wall-clock around public HTTP calls with " + `${BASELINE_POLL_INTERVAL_MS} ms` + " polling, single worker, single server, one database.",
        "pg_stat_statements is not installed in the local PostgreSQL 17 container, so per-statement SQL counts are not claimed.",
        "pg_stat_* deltas include the harness's own metric queries and projection polling (measurement overhead).",
        "The historical application database was not used or mutated; results come exclusively from the disposable *_test target.",
      ],
    };

    const outputPath = resolve(REPO_ROOT, options.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    printSummary(caseSummaries, allTrials);
    process.stdout.write(`raw results: ${outputPath}\n`);
    if (allTrials.some((trial) => !trial.completed) || !negativeCase.pass) {
      exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`benchmark failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    exitCode = 1;
  } finally {
    cleanup();
    await probePool.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
  process.exit(exitCode);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

await main();
