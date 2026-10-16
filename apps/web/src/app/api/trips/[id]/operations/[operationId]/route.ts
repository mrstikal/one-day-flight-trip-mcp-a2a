import { operationStatusResponseSchema, type OperationStatus, type OperationStatusResponse } from "@odft/contracts";
import { getServerDeps } from "@/lib/server";
import { errorResponse, jsonResponse, notFoundResponse } from "@/lib/http";
import { resolveSession } from "@/lib/session";

/**
 * GET /api/trips/[id]/operations/[operationId] — safe operation status for the
 * owner: accepted/waiting/succeeded/failed. Internal payload/result/hashes are
 * not exposed; missing and foreign trips return a uniform 404.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; operationId: string }> },
): Promise<Response> {
  const deps = getServerDeps();
  const session = await resolveSession(deps.pool, deps.config, request.headers.get("cookie"), {
    renew: false,
  });
  if (!session) {
    return errorResponse("UNAUTHORIZED", "missing or expired session", {}, 401);
  }
  const { id, operationId } = await context.params;

  const result = await deps.pool.query<{
    id: string;
    status: OperationStatus;
    accepted_revision: number;
    attempts: number;
    session_id: string;
  }>(
    `SELECT o.id, o.status, o.accepted_revision, o.attempts, t.session_id
       FROM odft_app.workflow_operations o
       JOIN odft_app.trips t ON t.id = o.trip_id
      WHERE o.id = $1 AND o.trip_id = $2`,
    [operationId, id],
  );
  const row = result.rows[0];
  if (!row || row.session_id !== session.sessionId) {
    return notFoundResponse();
  }
  const body: OperationStatusResponse = operationStatusResponseSchema.parse({
    operationId: row.id,
    status: row.status,
    acceptedRevision: row.accepted_revision,
    attempts: row.attempts,
  });
  return jsonResponse(body);
}
