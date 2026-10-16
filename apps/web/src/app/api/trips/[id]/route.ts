import { getServerDeps } from "@/lib/server";
import { errorResponse, jsonResponse, notFoundResponse } from "@/lib/http";
import { resolveSession } from "@/lib/session";
import { buildTripProjection } from "@/lib/projection";

/**
 * GET /api/trips/[id] — safe read projection for the owner session only. Reads
 * never renew the session; missing and foreign trips return a uniform 404.
 */

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
  const { id } = await context.params;
  const projection = await buildTripProjection(deps.pool, id, {
    aiMode: deps.config.aiMode,
    demoControlsEnabled: deps.config.demoControlsEnabled,
    mapTileUrl: deps.config.mapTileUrl ?? null,
  });
  if (!projection || projection.trip.sessionId !== session.sessionId) {
    return notFoundResponse();
  }
  return jsonResponse(projection);
}
