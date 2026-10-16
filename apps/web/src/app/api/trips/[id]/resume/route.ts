import { randomUUID } from "node:crypto";
import { resumeApiRequestSchema } from "@odft/contracts";
import { admitResume } from "@odft/persistence";
import { envelopeResponse, errorResponse, jsonResponse, readJsonResult, scopeErrorResponse } from "@/lib/http";
import { guardMutation } from "@/lib/guard";

/**
 * POST /api/trips/[id]/resume — admit a decision resume. The BFF generates the
 * request id when the client omits it. Public resume cannot inject operation
 * identity or `modify` (the trusted envelope is built server-side).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = await guardMutation(request, {
    endpoint: "trips:resume",
    limit: 20,
    windowMs: 60_000,
  });
  if (!guard.ok) {
    return guard.response;
  }

  const body = await readJsonResult(request);
  if (!body.ok) {
    return errorResponse(
      "VALIDATION_FAILED",
      body.reason === "too_large" ? "request body too large" : "invalid JSON body",
      {},
      body.reason === "too_large" ? 413 : 400,
    );
  }
  const parsed = resumeApiRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return envelopeResponse({ code: "VALIDATION_FAILED", message: "invalid resume request", retryable: false });
  }

  const { id } = await context.params;
  const result = await admitResume(guard.deps.pool, {
    tripId: id,
    sessionId: guard.session.sessionId,
    request: { ...parsed.data, requestId: parsed.data.requestId ?? randomUUID() },
  });
  if (!("operationId" in result)) {
    return scopeErrorResponse(result);
  }
  return jsonResponse(result, 202);
}
