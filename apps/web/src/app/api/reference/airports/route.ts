import { getServerDeps } from "@/lib/server";
import { errorResponse, jsonResponse } from "@/lib/http";
import { resolveSession } from "@/lib/session";
import { allowReferenceSearch } from "@/lib/rate-limit";
import { searchAirports } from "@odft/persistence";

/** GET /api/reference/airports — offline eligible-origin airport search. */

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
  const result = await searchAirports(deps.pool, {
    q: url.searchParams.get("q") ?? "",
    ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor") as string } : {}),
    limit: Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20,
    scope: "origin",
  });
  return jsonResponse(result);
}
