import type { PoolClient } from "pg";

/**
 * Fixed-precision USD arithmetic for the AI call ledger (persistence-local,
 * mirroring `@odft/ai` costs so `@odft/persistence` keeps its dependency edges).
 * Amounts are integer BigInt scaled by 1e9, matching `numeric(18,9)`.
 */

const SCALE = 1_000_000_000n;

export function parseUsdAmount(value: string): bigint {
  if (!/^\d+(\.\d{1,9})?$/.test(value)) {
    throw new TypeError(`invalid USD amount: ${value}`);
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const padded = (fraction + "000000000").slice(0, 9);
  return BigInt(whole) * SCALE + BigInt(padded);
}

export function formatUsdAmount(value: bigint): string {
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

/** `numeric(18,9)` values arrive as strings from `pg`; normalize safely. */
export function usdFromDb(value: unknown): bigint {
  if (typeof value === "string") {
    return parseUsdAmount(value);
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return BigInt(Math.ceil(value * 1e9));
  }
  return 0n;
}

type Queryable = Pick<PoolClient, "query">;

/** Attempted billable calls for a trip (every retry counts). */
export async function countTripLlmCalls(client: Queryable, tripId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM odft_app.llm_calls WHERE trip_id = $1`,
    [tripId],
  );
  return Number.parseInt(result.rows[0]?.count ?? "0", 10);
}

/**
 * Reserved + actual + uncertain USD for a trip. A reservation counts at its
 * reserved worst-case amount until reconciled; an actual amount replaces it.
 */
export async function sumTripLlmCostUsd(client: Queryable, tripId: string): Promise<bigint> {
  const result = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(
              CASE WHEN actual_cost_usd IS NOT NULL THEN actual_cost_usd
                   ELSE reserved_cost_usd END
            ), 0)::text AS total
       FROM odft_app.llm_calls WHERE trip_id = $1`,
    [tripId],
  );
  return usdFromDb(result.rows[0]?.total ?? "0");
}
