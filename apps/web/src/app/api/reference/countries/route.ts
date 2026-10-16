import { getServerDeps } from "@/lib/server";
import { errorResponse, jsonResponse } from "@/lib/http";
import { resolveSession } from "@/lib/session";
import { allowReferenceSearch } from "@/lib/rate-limit";
import { searchCountries } from "@odft/persistence";

/** GET /api/reference/countries — offline admitted-country search (never online). */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const deps = getServerDeps();
  const session = await resolveSession(deps.pool, deps.config, request.headers.get("cookie"), {
    renew: false,
  });
  if (!session) {
    return errorResponse("UNAUTHORIZED", "missing or expired session", {}, 401);
  }
  if (!(await allowReferenceSearch(deps.pool, deps.config, session.sessionId))) {
    return errorResponse("RATE_LIMITED", "too many reference searches", {}, 429);
  }
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 20;
  const items = await searchCountries(deps.pool, q, limit);
  return jsonResponse({ items });
}
