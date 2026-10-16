import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  deriveCsrf,
  issueSession,
  parseCookie,
  resolveSession,
  SESSION_COOKIE,
  verifyCsrf,
} from "../../../apps/web/src/lib/session.js";
import { consumeRateLimit, scopeHash } from "../../../apps/web/src/lib/rate-limit.js";
import {
  createGraphTestPool,
  createWorkerPools,
  endWorkerPools,
  resetGraphDatabase,
  testServerConfig,
  type WorkerPools,
} from "./_setup.js";

/**
 * T-IT-OPS-01 (session/CSRF/rate-limit portion): signed opaque cookies, stable
 * per-session CSRF, sliding renewal, expiry, and persisted fixed-window limits.
 */

describe("BFF session, CSRF, and rate limiting", () => {
  let pool: Pool;
  let pools: WorkerPools;
  const config = testServerConfig();

  beforeAll(async () => {
    pool = createGraphTestPool();
    pools = createWorkerPools();
  });

  beforeEach(async () => {
    await resetGraphDatabase(pool);
  });

  afterAll(async () => {
    await endWorkerPools(pools);
    await pool.end();
  });

  function cookieValue(setCookie: string): string {
    return setCookie.split(";")[0] ?? "";
  }

  it("issues a signed cookie, resolves the session, and verifies CSRF", async () => {
    const session = await issueSession(pool, config);
    const header = cookieValue(session.setCookie ?? "");
    expect(parseCookie(header, SESSION_COOKIE)).toBeTruthy();

    const resolved = await resolveSession(pool, config, header);
    expect(resolved?.sessionId).toBe(session.sessionId);
    expect(resolved?.csrfToken).toBe(deriveCsrf(session.sessionId, config));
    expect(verifyCsrf(resolved ?? session, session.csrfToken, config)).toBe(true);
    expect(verifyCsrf(resolved ?? session, "wrong", config)).toBe(false);
  });

  it("keeps the session id and CSRF stable across renewals (two tabs)", async () => {
    const session = await issueSession(pool, config);
    const header = cookieValue(session.setCookie ?? "");
    const first = await resolveSession(pool, config, header);
    const second = await resolveSession(pool, config, header);
    expect(first?.sessionId).toBe(session.sessionId);
    expect(second?.sessionId).toBe(session.sessionId);
    expect(second?.csrfToken).toBe(first?.csrfToken);
    // Renewal returns a refreshed cookie so the browser Max-Age slides too.
    expect(first?.setCookie).toContain(SESSION_COOKIE);
    expect(first?.setCookie).toContain("Max-Age=");
  });

  it("rejects a tampered cookie and an expired session", async () => {
    const session = await issueSession(pool, config);
    const header = cookieValue(session.setCookie ?? "");
    const tampered = `${header}x`;
    expect(await resolveSession(pool, config, tampered)).toBeUndefined();

    await pool.query(
      `UPDATE odft_app.anonymous_sessions SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [session.sessionId],
    );
    expect(await resolveSession(pool, config, header)).toBeUndefined();
  });

  it("enforces a persisted fixed-window rate limit", async () => {
    const scope = scopeHash(config, "test-scope");
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(
        await consumeRateLimit(pool, {
          scopeHash: scope,
          endpoint: "trips:commands",
          limit: 3,
          windowMs: 60_000,
        }),
      );
    }
    expect(results.slice(0, 3).every((r) => r.allowed)).toBe(true);
    expect(results[3]?.allowed).toBe(false);
    expect(results[3]?.remaining).toBe(0);
  });
});
