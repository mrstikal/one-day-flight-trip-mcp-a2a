import type { TravelVariant } from "@odft/contracts";

/**
 * Phase 01 baseline: fixed benchmark cases, fixed public-API inputs and the pure
 * helpers of the isolated harness (destructive-target guard, latency math).
 *
 * The cases are the six deterministic trips required by the plan: PRG to Rome,
 * Paris and Barcelona, each in the Economy/one-night and Comfortable/two-night
 * variant. Everything else (party, service level, pace, date, decision policy)
 * is fixed below and recorded with every result. The scenario seed is not an
 * input: the current application derives it from the persisted route
 * fingerprint, so the harness records the resolved seed from the isolated
 * database instead of inventing one.
 */
export const BASELINE_RESULT_SCHEMA_VERSION = 1;

export const BASELINE_USER_NAME = "Baseline Traveller";
export const BASELINE_ADULTS = 1;
export const BASELINE_SIGHTSEEING_DATE = "2026-12-01";
export const BASELINE_DEFAULT_SERVICE_LEVEL = "standard";
export const BASELINE_ACTIVITY_PACE = "moderate";
export const BASELINE_INTERESTS = { culture: 3, relaxation: 2, entertainment: 1 } as const;
export const BASELINE_REPETITIONS = 5;
export const BASELINE_POLL_INTERVAL_MS = 150;
export const BASELINE_TRIAL_TIMEOUT_MS = 240_000;

/** Origin airport used by every case (Václav Havel Airport Prague). */
export const BASELINE_ORIGIN_AIRPORT = {
  query: "PRG",
  expectedId: "ourairports:4408",
} as const;

export interface BaselineCaseDefinition {
  readonly id: string;
  readonly label: string;
  readonly destination: {
    readonly countryKey: string;
    readonly cityQuery: string;
    readonly expectedCityId: string;
  };
  readonly variant: TravelVariant;
}

export const BASELINE_CASES: readonly BaselineCaseDefinition[] = [
  {
    id: "prg-rome-one-night",
    label: "PRG to Rome, Economy / one night",
    destination: { countryKey: "IT", cityQuery: "Rome", expectedCityId: "geonames:3169070" },
    variant: "one_night",
  },
  {
    id: "prg-rome-two-nights",
    label: "PRG to Rome, Comfortable / two nights",
    destination: { countryKey: "IT", cityQuery: "Rome", expectedCityId: "geonames:3169070" },
    variant: "two_nights",
  },
  {
    id: "prg-paris-one-night",
    label: "PRG to Paris, Economy / one night",
    destination: { countryKey: "FR", cityQuery: "Paris", expectedCityId: "geonames:2988507" },
    variant: "one_night",
  },
  {
    id: "prg-paris-two-nights",
    label: "PRG to Paris, Comfortable / two nights",
    destination: { countryKey: "FR", cityQuery: "Paris", expectedCityId: "geonames:2988507" },
    variant: "two_nights",
  },
  {
    id: "prg-barcelona-one-night",
    label: "PRG to Barcelona, Economy / one night",
    destination: { countryKey: "ES", cityQuery: "Barcelona", expectedCityId: "geonames:3128760" },
    variant: "one_night",
  },
  {
    id: "prg-barcelona-two-nights",
    label: "PRG to Barcelona, Comfortable / two nights",
    destination: { countryKey: "ES", cityQuery: "Barcelona", expectedCityId: "geonames:3128760" },
    variant: "two_nights",
  },
];

/**
 * Negative case (AC-06-3): PRG to České Budějovice is a rejected ground route.
 * The application must return an INFEASIBLE Stage A result with an explanation
 * and generate no flight scenario.
 */
export const NEGATIVE_ROUTE_CASE = {
  id: "prg-ceske-budejovice-negative",
  label: "PRG to České Budějovice (deterministic rejection)",
  originAirportId: BASELINE_ORIGIN_AIRPORT.expectedId,
  destinationCityId: "geonames:3077916",
  destinationCountryKey: "CZ",
  variant: "one_night",
} as const;

/** Deterministic decision policy of the public-API driver (recorded verbatim). */
export const BASELINE_DECISION_POLICY = [
  "flight_choice: choose the first allowed offer id",
  "booking_confirmation: confirm with the explicit demo disclaimer",
  "replacement_confirmation: confirm the staged replacement with the explicit demo disclaimer",
  "hotel_choice: choose the first allowed offer id (the next one after a recovery reopened the step)",
  "program_choices: submit the server-computed meal defaults; after a recovery reopened the program, submit the next meal offer per category",
  "recovery: choose the first offered option, alternating over the offered option ids (bounded to 3 per trial)",
  "clarification: choose the first non-budget offered option (bounded to 3 per trial)",
  "agent_input: choose the first offered option id (a specialist question answered on the same task)",
  "itinerary_approval: approve the exact persisted draft",
  "any other decision kind is recorded as a failed trial",
].join("; ");

/** Bounded recovery answers per trial before it is recorded as a failure. */
export const BASELINE_MAX_RECOVERY_CHOICES = 3;
/** Bounded packing/ambiguity clarification answers per trial. */
export const BASELINE_MAX_CLARIFICATION_CHOICES = 3;

/**
 * Refuse destructive benchmark setup outside a dedicated disposable database.
 * The benchmark truncates rate-limit state and writes trips, so it must only
 * ever run against a database whose name ends in `_test`.
 */
export function assertDisposableDatabaseUrl(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid connection URL.");
  }
  const databaseName = parsed.pathname.replace(/^\//, "");
  if (!databaseName) {
    throw new Error("DATABASE_URL must name a database.");
  }
  if (databaseName === "postgres" || databaseName.startsWith("template")) {
    throw new Error(
      `Refusing to run the benchmark against maintenance database "${databaseName}".`,
    );
  }
  if (!databaseName.endsWith("_test")) {
    throw new Error(
      `Refusing to run the benchmark against non-test database "${databaseName}". ` +
        "Choose a dedicated disposable database whose name ends in _test.",
    );
  }
  return databaseName;
}

/** Nearest-rank percentile over a copy of the values (p in 0..1). */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }
  if (!(p >= 0 && p <= 1)) {
    throw new Error(`percentile p must be within 0..1, got ${p}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1] ?? null;
}

export interface LatencySummary {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
}

/** Latency summary with the documented nearest-rank p50/p95 (integers, ms). */
export function summarizeLatencies(values: readonly number[]): LatencySummary | null {
  if (values.length === 0) {
    return null;
  }
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    mean: Math.round(sum / values.length),
    p50: percentile(values, 0.5) as number,
    p95: percentile(values, 0.95) as number,
  };
}

/** Completion rate over a trial list (0 when empty is reported as null). */
export function completionRate(completed: number, total: number): number | null {
  return total === 0 ? null : completed / total;
}

/* ---- Result document types (raw JSON artifact, schema-versioned) ------------ */

export interface BaselineStepResult {
  readonly submittedDecisionKind: string | null;
  readonly submittedAction: string | null;
  readonly observedOutcome: string;
  readonly latencyMs: number;
  readonly chosenId: string | null;
}

export interface BaselineDbMetrics {
  readonly xactCommit: number;
  readonly xactRollback: number;
  readonly blksRead: number;
  readonly blksHit: number;
  readonly tuplesInserted: number;
  readonly tuplesUpdated: number;
  readonly tuplesDeleted: number;
  readonly seqScans: number;
  readonly indexScans: number;
  readonly pgStatStatements: { readonly calls: number; readonly totalExecMs: number } | null;
}

export interface BaselineTrialResult {
  readonly caseId: string;
  readonly repetition: number;
  readonly tripId: string | null;
  readonly completed: boolean;
  readonly failureReason: string | null;
  readonly totalLatencyMs: number;
  readonly steps: readonly BaselineStepResult[];
  readonly itineraryVersion: number | null;
  readonly itineraryApprovedVersion: number | null;
  readonly reservations: readonly { readonly serviceKey: string; readonly demoReference: string }[];
  readonly fixtureAiInvocations: { readonly planner: number; readonly reviewer: number };
  readonly llmCalls: number;
  readonly llmReservedTokens: number;
  readonly llmActualTokens: number;
  readonly llmReservedUsd: number;
  readonly llmActualUsd: number;
  readonly llmUnknownReserved: number;
  readonly db: BaselineDbMetrics;
  readonly scenarioSeed: string | null;
  readonly scenarioGeneratorVersion: string | null;
  readonly scenarioReferenceVersion: string | null;
}
