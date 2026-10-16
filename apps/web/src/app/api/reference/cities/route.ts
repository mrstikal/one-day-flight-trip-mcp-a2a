import { getServerDeps } from "@/lib/server";
import { errorResponse, jsonResponse } from "@/lib/http";
import { resolveSession } from "@/lib/session";
import { allowReferenceSearch } from "@/lib/rate-limit";
import { searchCities } from "@odft/persistence";

/** GET /api/reference/cities — offline admitted-city search within a country. */

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
  const countryKey = url.searchParams.get("country") ?? "";
  if (!/^[A-Z]{2}$/.test(countryKey)) {
    return errorResponse("VALIDATION_FAILED", "a valid country query parameter is required");
  }
  const result = await searchCities(deps.pool, {
    countryKey,
    q: url.searchParams.get("q") ?? "",
    ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor") as string } : {}),
    limit: Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20,
  });
  return jsonResponse(result);
}
