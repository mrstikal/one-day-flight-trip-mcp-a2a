import type { NextResponse } from "next/server";
import { getTrip, renewSession } from "@odft/persistence";
import { getServerDeps } from "@/lib/server";
import { clientIp, errorResponse, hasValidOrigin } from "@/lib/http";
import { CSRF_HEADER, resolveSession, SESSION_TTL_MS, verifyCsrf } from "@/lib/session";
import { consumeRateLimit, scopeHash } from "@/lib/rate-limit";

/**
 * Shared guard for mutating BFF routes: origin, session, CSRF, then rate limit.
 * On any failure it returns an error response and no business call is made.
 */

export interface RateLimitPolicy {
  readonly endpoint: string;
  readonly limit: number;
  readonly windowMs: number;
  /** Bucket scope: the session (default) or the client IP hash (pre-session). */
  readonly scope?: "session" | "ip";
}

export interface SessionGuard {
  readonly sessionId: string;
  readonly csrfToken: string;
}

export type GuardResult =
  | {
      readonly ok: true;
      readonly deps: ReturnType<typeof getServerDeps>;
      readonly session: SessionGuard;
    }
  | { readonly ok: false; readonly response: NextResponse };

/**
 * `overrideDeps` lets tests and the voice routes reuse this exact guard against
 * an explicitly provided pool/config (the default remains the HMR-cached
 * singleton, so ordinary routes are unchanged).
 */
export async function guardMutation(
  request: Request,
  policy: RateLimitPolicy,
  overrideDeps?: ReturnType<typeof getServerDeps>,
): Promise<GuardResult> {
  let deps: ReturnType<typeof getServerDeps>;
  if (overrideDeps) {
    deps = overrideDeps;
  } else {
    try {
      deps = getServerDeps();
    } catch {
      return {
        ok: false,
        response: errorResponse("INTERNAL_ERROR", "server configuration is invalid", {}, 503),
      };
    }
  }

  if (!hasValidOrigin(request, deps.config.publicBaseUrl)) {
    return { ok: false, response: errorResponse("FORBIDDEN", "request origin is not allowed") };
  }

  const session = await resolveSession(deps.pool, deps.config, request.headers.get("cookie"), {
    renew: false,
  });
  if (!session) {
    return {
      ok: false,
      response: errorResponse("UNAUTHORIZED", "missing or expired session", {}, 401),
    };
  }
  if (!verifyCsrf(session, request.headers.get(CSRF_HEADER), deps.config)) {
    return { ok: false, response: errorResponse("FORBIDDEN", "missing or invalid CSRF token") };
  }

  const limit = await consumeRateLimit(deps.pool, {
    scopeHash:
      policy.scope === "ip"
        ? scopeHash(deps.config, `ip:${clientIp(request, deps.config.trustProxy)}`)
        : scopeHash(deps.config, session.sessionId),
    endpoint: policy.endpoint,
    limit: policy.limit,
    windowMs: policy.windowMs,
  });
  if (!limit.allowed) {
    return {
      ok: false,
      response: errorResponse("RATE_LIMITED", "too many requests", {}, 429),
    };
  }

  // Renew only on accepted writes (never on rejected or read-only requests).
  await renewSession(deps.pool, session.sessionId, new Date(Date.now() + SESSION_TTL_MS));

  return { ok: true, deps, session };
}

/**
 * Phase 09 history denial (ODTF_PLAN.md §3.16 step 6).
 *
 * Every trip-mutating BFF route calls this after `guardMutation` and ownership
 * validation: an archived trip is read-only history, so ANY write — chat,
 * resume, retry, simulation controls, booking, cancellation, or voice
 * ledger/conversation writes — is rejected with `TRIP_ARCHIVED` before any
 * business call runs. Reads (projection, events, inspector) never call this.
 *
 * The check reads the trip's `archived_at` under the caller's ownership proof
 * (`trip.sessionId === session.sessionId`); a foreign or missing trip stays a
 * uniform 404 so existence is not an oracle.
 */
export async function denyArchivedTripWrite(input: {
  readonly deps: ReturnType<typeof getServerDeps>;
  readonly sessionId: string;
  readonly tripId: string;
}): Promise<NextResponse | null> {
  const trip = await getTrip(input.deps.pool, input.tripId);
  if (!trip || trip.sessionId !== input.sessionId) {
    return errorResponse("NOT_FOUND", "trip not found");
  }
  if (trip.archivedAt) {
    return errorResponse("TRIP_ARCHIVED", "archived trips are read-only history");
  }
  return null;
}
