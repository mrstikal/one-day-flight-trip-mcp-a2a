import { createHmac } from "node:crypto";
import type { Pool } from "pg";
import type { ServerConfig } from "@odft/persistence";

/**
 * Fixed-window, per-scope/endpoint rate limiting (10-security-reliability.md
 * section 10). The in-memory `X-RateLimit` values are never authoritative; the
 * persisted bucket is the source of truth so limits hold across processes.
 */

export interface RateLimitOptions {
  readonly scopeHash: string;
  readonly endpoint: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly now?: Date;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly count: number;
  readonly remaining: number;
  readonly resetAt: string;
}

/** HMAC the scope so raw session ids are never stored in the bucket key. */
export function scopeHash(config: ServerConfig, scope: string): string {
  return createHmac("sha256", config.sessionHmacKey).update(`scope:${scope}`).digest("hex");
}

export async function consumeRateLimit(
  pool: Pool,
  options: RateLimitOptions,
): Promise<RateLimitResult> {
  const now = options.now ?? new Date();
  const windowStartMs = Math.floor(now.getTime() / options.windowMs) * options.windowMs;
  const windowStart = new Date(windowStartMs);
  const result = await pool.query<{ count: number }>(
    `INSERT INTO odft_app.rate_limit_buckets (scope_hash, endpoint, window_start, count)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (scope_hash, endpoint, window_start)
     DO UPDATE SET count = odft_app.rate_limit_buckets.count + 1
     RETURNING count`,
    [options.scopeHash, options.endpoint, windowStart],
  );
  const count = result.rows[0]?.count ?? options.limit + 1;
  return {
    allowed: count <= options.limit,
    count,
    remaining: Math.max(0, options.limit - count),
    resetAt: new Date(windowStartMs + options.windowMs).toISOString(),
  };
}

/** Opportunistic cleanup of buckets far outside any active window. */
export async function pruneRateLimitBuckets(pool: Pool, olderThanMs = 60 * 60 * 1000): Promise<void> {
  await pool.query(
    `DELETE FROM odft_app.rate_limit_buckets WHERE window_start < now() - ($1::bigint * interval '1 millisecond')`,
    [olderThanMs],
  );
}

/**
 * Reference search is fail-open: if the limiter itself is unavailable the
 * request is served (public offline records only). An exceeded limit still
 * returns false so the route can answer 429.
 */
export async function allowReferenceSearch(
  pool: Pool,
  config: ServerConfig,
  sessionId: string,
): Promise<boolean> {
  try {
    const result = await consumeRateLimit(pool, {
      scopeHash: scopeHash(config, sessionId),
      endpoint: "reference:search",
      limit: 60,
      windowMs: 60_000,
    });
    return result.allowed;
  } catch {
    return true;
  }
}
