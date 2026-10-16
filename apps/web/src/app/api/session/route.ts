import { ConfigError } from "@odft/persistence";
import { getServerDeps } from "@/lib/server";
import { clientIp, errorResponse, hasValidOrigin, jsonResponse } from "@/lib/http";
import { issueSession, resolveSession } from "@/lib/session";
import { consumeRateLimit, scopeHash } from "@/lib/rate-limit";
import { sessionResponseSchema, type SessionResponse } from "@odft/contracts";

/**
 * POST /api/session — create or renew the anonymous session. Requires an exact
 * Origin match and is rate-limited per IP hash. Renewal is sliding and preserves
 * the session id, token hash, and CSRF derivation.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let deps;
  try {
    deps = getServerDeps();
  } catch (error) {
    if (error instanceof ConfigError) {
      return errorResponse("INTERNAL_ERROR", "server configuration is invalid", {}, 503);
    }
    throw error;
  }

  if (!hasValidOrigin(request, deps.config.publicBaseUrl)) {
    return errorResponse("FORBIDDEN", "request origin is not allowed");
  }

  const limit = await consumeRateLimit(deps.pool, {
    scopeHash: scopeHash(deps.config, `ip:${clientIp(request, deps.config.trustProxy)}`),
    endpoint: "session:create",
    limit: 10,
    windowMs: 60 * 60 * 1000,
  });
  if (!limit.allowed) {
    return errorResponse("RATE_LIMITED", "too many session requests", {}, 429);
  }

  const existing = await resolveSession(deps.pool, deps.config, request.headers.get("cookie"), {
    renew: true,
  });
  const session = existing ?? (await issueSession(deps.pool, deps.config));

  const body: SessionResponse = sessionResponseSchema.parse({
    sessionId: session.sessionId,
    expiresAt: session.expiresAt,
    csrfToken: session.csrfToken,
  });

  const headers: Record<string, string> = {};
  if (session.setCookie) {
    headers["set-cookie"] = session.setCookie;
  }
  return jsonResponse(body, existing ? 200 : 201, headers);
}
