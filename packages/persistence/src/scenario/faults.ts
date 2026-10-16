import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { BehaviorOverlay, FaultDecision } from "@odft/data";
import { scenarioDomainSchema, type ScenarioDomain, type SimulationMode } from "@odft/contracts";
import { lockOperationFence, type OperationFencingContext } from "../operations/fencing.js";

/**
 * Persisted failure-injection overlays (05 section 12, FR-DEMO-2). Counters are
 * stored with the fault row so injection state survives retries and restarts,
 * and re-arming changes no inventory hash. Rows are deduplicated in code because
 * PostgreSQL treats NULL `operation_id` values as distinct in the unique index.
 *
 * Phase 10 adds the `itinerary` overlay domain (injected first-attempt overlap);
 * it shares the fault row shape but never participates in research fingerprints.
 */

type Queryable = Pick<PoolClient, "query">;

/** Overlay domains: the six scenario domains plus the Phase 10 itinerary overlay. */
export type FaultDomain = ScenarioDomain | "itinerary";

function numericCounters(value: unknown): Record<string, number> {
  const counters: Record<string, number> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "number") {
        counters[key] = entry;
      }
    }
  }
  return counters;
}

export interface UpsertFaultInput {
  readonly tripId: string;
  readonly operationId?: string;
  readonly domain: FaultDomain;
  readonly fault: SimulationMode;
  readonly state?: Record<string, unknown>;
  readonly counters?: Record<string, number>;
  readonly overlayVersion?: number;
}

/**
 * Upsert one fault row inside an existing transaction (used by the command
 * dispatcher so a scenario arm commits atomically with its trip update).
 */
export async function upsertFaultRow(client: Queryable, input: UpsertFaultInput): Promise<string> {
  const operationId = input.operationId ?? null;
  const state = JSON.stringify(input.state ?? {});
  const existing = await client.query<{ id: string; counters: Record<string, unknown> }>(
    `SELECT id, counters FROM odft_app.simulation_faults
       WHERE trip_id = $1 AND operation_id IS NOT DISTINCT FROM $2 AND domain = $3 AND fault = $4
       FOR UPDATE`,
    [input.tripId, operationId, input.domain, input.fault],
  );
  const previous = numericCounters(existing.rows[0]?.counters);
  const counters = JSON.stringify({
    ...previous,
    ...(input.counters ?? {}),
    // Every arm/re-arm advances the version, so re-activating the same fault
    // still invalidates a cached research result (the version is part of the
    // domain's research input fingerprint).
    overlayVersion: input.overlayVersion ?? (previous["overlayVersion"] ?? 0) + 1,
  });
  const existingId = existing.rows[0]?.id;
  if (existingId) {
    await client.query(
      `UPDATE odft_app.simulation_faults
          SET state = $2::jsonb, counters = $3::jsonb, updated_at = now()
        WHERE id = $1`,
      [existingId, state, counters],
    );
    return existingId;
  }
  const id = randomUUID();
  await client.query(
    `INSERT INTO odft_app.simulation_faults (id, trip_id, operation_id, domain, fault, state, counters)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
    [id, input.tripId, operationId, input.domain, input.fault, state, counters],
  );
  return id;
}

export async function upsertFault(pool: Pool, input: UpsertFaultInput): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const id = await upsertFaultRow(client, input);
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function loadOverlay(
  client: Queryable,
  tripId: string,
  domain: FaultDomain,
  operationId?: string,
): Promise<BehaviorOverlay | null> {
  const result = await client.query<{ fault: SimulationMode; counters: Record<string, unknown> }>(
    `SELECT fault, counters FROM odft_app.simulation_faults
       WHERE trip_id = $1 AND domain = $2
         AND ($3::uuid IS NULL OR operation_id IS NULL OR operation_id = $3::uuid)
       ORDER BY updated_at DESC LIMIT 1`,
    [tripId, domain, operationId ?? null],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  const counters = numericCounters(row.counters);
  return {
    mode: row.fault,
    failureDomain:
      row.fault === "provider_failure" && scenarioDomainSchema.safeParse(domain).success
        ? (domain as ScenarioDomain)
        : null,
    overlayVersion: counters["overlayVersion"] ?? 1,
    counters,
  };
}

export interface OverlaySummary {
  readonly mode: SimulationMode;
  readonly overlayVersion: number;
}

/**
 * The newest visible overlay per scenario domain for one operation, resolved with
 * exactly the same rule as {@link loadOverlay}. Used to build the per-domain
 * research input fingerprint, so arming/re-arming a fault invalidates a cached
 * successful research result.
 */
export async function loadOverlaySummaries(
  client: Queryable,
  tripId: string,
  operationId?: string,
): Promise<Partial<Record<ScenarioDomain, OverlaySummary>>> {
  const result = await client.query<{
    domain: ScenarioDomain;
    fault: SimulationMode;
    counters: Record<string, unknown>;
  }>(
    `SELECT DISTINCT ON (domain) domain, fault, counters
       FROM odft_app.simulation_faults
      WHERE trip_id = $1
        AND ($2::uuid IS NULL OR operation_id IS NULL OR operation_id = $2::uuid)
      ORDER BY domain, updated_at DESC`,
    [tripId, operationId ?? null],
  );
  const summaries: Partial<Record<ScenarioDomain, OverlaySummary>> = {};
  for (const row of result.rows) {
    // The itinerary overlay is not a research domain: it never enters the
    // per-domain research input fingerprint.
    if (!scenarioDomainSchema.safeParse(row.domain).success) {
      continue;
    }
    summaries[row.domain] = {
      mode: row.fault,
      overlayVersion: numericCounters(row.counters)["overlayVersion"] ?? 1,
    };
  }
  return summaries;
}

export interface FaultOutcomeInput {
  readonly tripId: string;
  readonly operationId?: string;
  readonly domain: FaultDomain;
  readonly fault: SimulationMode;
  /** The provider decision this attempt produced (`ok` means the fault passed). */
  readonly outcome: FaultDecision | "unsupported";
  readonly attempt: number;
  readonly overlayVersion?: number;
  readonly reason?: string;
}

export interface FaultOutcomeRecord {
  /** Total attempts recorded across retries/restarts for this overlay row. */
  readonly attempts: number;
  /** Attempts whose provider outcome was injected (not `ok`). */
  readonly injected: number;
}

/**
 * Persist one provider-attempt outcome on the overlay row (05 section 12): the
 * counters survive graph retries and worker restarts, so scenario D proves the
 * retry instead of re-injecting forever, and re-arming advances overlayVersion
 * without regenerating any inventory.
 *
 * Recording is idempotent per attempt: `attempts` stores the highest attempt
 * seen and `injected` counts each failed attempt once, so a
 * commit-before-checkpoint replay of the same attempt cannot inflate them.
 */
export async function recordFaultOutcome(
  pool: Pool,
  input: FaultOutcomeInput,
  fence?: OperationFencingContext,
): Promise<FaultOutcomeRecord> {
  const operationId = input.operationId ?? null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (fence) {
      // The overlay counters are a domain write like any other: a worker that
      // lost its lease must not advance them.
      await lockOperationFence(client, fence);
    }
    const existing = await client.query<{ id: string; counters: Record<string, unknown> }>(
      `SELECT id, counters FROM odft_app.simulation_faults
         WHERE trip_id = $1 AND operation_id IS NOT DISTINCT FROM $2 AND domain = $3 AND fault = $4
         FOR UPDATE`,
      [input.tripId, operationId, input.domain, input.fault],
    );
    const previous = numericCounters(existing.rows[0]?.counters);
    const previousAttempts = previous["attempts"] ?? 0;
    if (input.attempt <= previousAttempts) {
      await client.query("COMMIT");
      return { attempts: previousAttempts, injected: previous["injected"] ?? 0 };
    }
    const attempts = input.attempt;
    const injected = (previous["injected"] ?? 0) + (input.outcome === "ok" ? 0 : 1);
    const next = {
      ...previous,
      attempts,
      injected,
      overlayVersion: previous["overlayVersion"] ?? input.overlayVersion ?? input.attempt,
    };
    const state = JSON.stringify({
      lastOutcome: input.outcome,
      lastAttempt: input.attempt,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    const countersJson = JSON.stringify(next);
    const existingId = existing.rows[0]?.id;
    if (existingId) {
      await client.query(
        `UPDATE odft_app.simulation_faults
            SET state = $2::jsonb, counters = $3::jsonb, updated_at = now()
          WHERE id = $1`,
        [existingId, state, countersJson],
      );
    } else {
      await client.query(
        `INSERT INTO odft_app.simulation_faults (id, trip_id, operation_id, domain, fault, state, counters)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
        [randomUUID(), input.tripId, operationId, input.domain, input.fault, state, countersJson],
      );
    }
    await client.query("COMMIT");
    return { attempts, injected };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
