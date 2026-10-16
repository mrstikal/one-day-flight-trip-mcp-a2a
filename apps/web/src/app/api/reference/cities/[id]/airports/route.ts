import { getServerDeps } from "@/lib/server";
import { errorResponse, jsonResponse } from "@/lib/http";
import { resolveSession } from "@/lib/session";
import { allowReferenceSearch } from "@/lib/rate-limit";
import { getCityAirports } from "@odft/persistence";

/** GET /api/reference/cities/[id]/airports — resolved destination airports. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
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
  const { id } = await context.params;
  const result = await getCityAirports(deps.pool, id);
  return jsonResponse(result);
}
