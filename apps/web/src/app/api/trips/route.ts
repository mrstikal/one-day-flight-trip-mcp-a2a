import { createTripRequestSchema } from "@odft/contracts";
import { createTrip } from "@odft/persistence";
import { envelopeResponse, errorResponse, jsonResponse, readJsonResult } from "@/lib/http";
import { guardMutation } from "@/lib/guard";
import { SIGHTSEEING_DATE_WINDOW_MESSAGE, isValidSightseeingDate } from "@/lib/date-window";

/**
 * POST /api/trips — create a trip and its initialization operation. Idempotent on
 * (session, creationRequestId); a changed payload under the same key is rejected.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const guard = await guardMutation(request, {
    endpoint: "trips:create",
    limit: 5,
    windowMs: 60 * 60 * 1000,
    scope: "ip",
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
  const parsed = createTripRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return envelopeResponse({ code: "VALIDATION_FAILED", message: "invalid trip creation input", retryable: false });
  }
  if (!isValidSightseeingDate(parsed.data.sightseeingDate)) {
    return envelopeResponse({
      code: "VALIDATION_FAILED",
      message: SIGHTSEEING_DATE_WINDOW_MESSAGE,
      retryable: false,
    });
  }

  const result = await createTrip(guard.deps.pool, {
    sessionId: guard.session.sessionId,
    input: parsed.data,
  });
  if (!("tripId" in result)) {
    return envelopeResponse(result);
  }
  return jsonResponse(result, 201);
}
