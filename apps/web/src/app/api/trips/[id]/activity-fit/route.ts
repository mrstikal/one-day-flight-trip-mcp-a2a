import { activityFitResponseSchema, snapshotContentSchema } from "@odft/contracts";
import { activityVisitBudget } from "@odft/domain";
import { getTrip } from "@odft/persistence";
import { errorResponse, jsonResponse, notFoundResponse } from "@/lib/http";
import { getServerDeps } from "@/lib/server";
import { resolveSession } from "@/lib/session";

/**
 * GET /api/trips/[id]/activity-fit?ids=a,b,c — live visit-time budget for a
 * candidate activity selection (08-frontend-ux.md section 7). Owner session only;
 * computed server-side from the active snapshot's activity durations and the
 * trip's pace cap so the activities step never derives pace feasibility itself.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IDS = 50;

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
  const trip = await getTrip(deps.pool, id);
  if (!trip || trip.sessionId !== session.sessionId) {
    return notFoundResponse();
  }
  const requestedIds = (new URL(request.url).searchParams.get("ids") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .slice(0, MAX_IDS);

  let activities: { id: string; durationMinutes: number }[] = [];
  if (trip.activeScenarioSnapshotId) {
    const snapshot = await deps.pool.query<{ inventory: unknown }>(
      `SELECT inventory FROM odft_app.scenario_snapshots WHERE id = $1`,
      [trip.activeScenarioSnapshotId],
    );
    if (snapshot.rows[0]) {
      activities = snapshotContentSchema
        .parse(snapshot.rows[0].inventory)
        .activities.map((activity) => ({
          id: activity.id,
          durationMinutes: activity.durationMinutes,
        }));
    }
  }
  const budget = activityVisitBudget({
    pace: trip.preferences.activityPace,
    activities,
    selectedIds: requestedIds,
  });
  return jsonResponse(activityFitResponseSchema.parse(budget));
}