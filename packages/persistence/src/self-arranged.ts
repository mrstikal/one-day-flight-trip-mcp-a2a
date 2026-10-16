import type { Pool, PoolClient } from "pg";
import { mealSchema, type Meal } from "@odft/contracts";

/**
 * Explicit "I'll arrange it myself" program state (Phase 12). One row per
 * service the traveler handles themselves in `self_arranged_services`; these
 * meals/activities are never planned, offered, or costed. This is a distinct
 * state — never a null (missing) selection.
 */

type Queryable = Pick<PoolClient, "query">;

export type SelfArrangedService = Meal | "activities";

const SERVICES: readonly SelfArrangedService[] = ["breakfast", "lunch", "dinner", "activities"];

export interface SelfArrangedState {
  readonly meals: readonly Meal[];
  readonly activities: boolean;
}

export const EMPTY_SELF_ARRANGED_STATE: SelfArrangedState = { meals: [], activities: false };

/** Load the persisted self-arranged state of a trip. */
export async function loadSelfArrangedState(
  client: Queryable,
  tripId: string,
): Promise<SelfArrangedState> {
  const result = await client.query<{ service_key: string }>(
    `SELECT service_key FROM odft_app.self_arranged_services WHERE trip_id = $1`,
    [tripId],
  );
  const keys = new Set(result.rows.map((row) => row.service_key));
  return {
    meals: mealSchema.options.filter((meal) => keys.has(meal)),
    activities: keys.has("activities"),
  };
}

/** The service keys of a state, in canonical order. */
export function selfArrangedServiceKeys(state: SelfArrangedState): SelfArrangedService[] {
  const selected = new Set<SelfArrangedService>([
    ...state.meals,
    ...(state.activities ? (["activities"] as const) : []),
  ]);
  return SERVICES.filter((service) => selected.has(service));
}

/** Replace the trip's self-arranged state in one short transaction (idempotent). */
export async function setSelfArrangedState(
  pool: Pool,
  tripId: string,
  state: SelfArrangedState,
): Promise<void> {
  const keys = selfArrangedServiceKeys(state);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await replaceSelfArrangedStateIn(client, tripId, keys);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Fenced/transactional variant for callers that already own a transaction. */
export async function replaceSelfArrangedStateIn(
  client: Queryable,
  tripId: string,
  keys: readonly SelfArrangedService[],
): Promise<void> {
  await client.query(
    `DELETE FROM odft_app.self_arranged_services
      WHERE trip_id = $1 AND NOT (service_key = ANY($2::text[]))`,
    [tripId, keys],
  );
  for (const service of keys) {
    await client.query(
      `INSERT INTO odft_app.self_arranged_services (trip_id, service_key, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (trip_id, service_key) DO UPDATE SET updated_at = now()`,
      [tripId, service],
    );
  }
}