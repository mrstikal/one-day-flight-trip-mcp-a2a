import { randomUUID } from "node:crypto";
import { technicalRetryApiRequestSchema } from "@odft/contracts";
import { retryOperation } from "@odft/persistence";
import { envelopeResponse, errorResponse, jsonResponse, readJsonResult, scopeErrorResponse } from "@/lib/http";
import { guardMutation } from "@/lib/guard";

/**
 * POST /api/trips/[id]/operations/[operationId]/retry — explicit owner technical
 * retry. Requeues the SAME failed unfinished operation without changing revision.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; operationId: string }> },
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
  const parsed = technicalRetryApiRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return envelopeResponse({ code: "VALIDATION_FAILED", message: "invalid retry request", retryable: false });
  }

  const { id, operationId } = await context.params;
  const result = await retryOperation(guard.deps.pool, {
    tripId: id,
    sessionId: guard.session.sessionId,
    operationId,
    controlRequestId: parsed.data.controlRequestId ?? randomUUID(),
    expectedRevision: parsed.data.expectedRevision,
  });
  if (!("status" in result)) {
    return scopeErrorResponse(result);
  }
  return jsonResponse(result, 202);
}
