import type { Pool } from "pg";
import { uuidSchema } from "@odft/contracts";
import { getTrip, type ServerConfig } from "@odft/persistence";
import { errorResponse, jsonResponse, notFoundResponse, PRIVATE_HEADERS } from "@/lib/http";
import { guardMutation } from "@/lib/guard";
import { resolveSession } from "@/lib/session";
import {
  capabilitiesFromRuntime,
  type VoiceService,
  type VoiceServiceFailure,
} from "@/lib/voice-service";

/**
 * Voice BFF route handlers (VOICE_CONTROLL.md section 7).
 *
 * The exported `handle*` functions own the full HTTP semantics (guard, strict
 * validation, byte caps, status mapping, private headers) and take explicit
 * dependencies, so integration tests exercise the real routes against real
 * PostgreSQL with injected transports. The Next route modules are thin
 * wrappers that bind `getServerDeps()`.
 */

export interface VoiceRouteDeps {
  readonly pool: Pool;
  readonly config: ServerConfig;
  readonly service: VoiceService;
}

function failureResponse(error: VoiceServiceFailure): Response {
  return errorResponse(error.code, error.message, { retryable: error.retryable });
}

/**
 * GET /api/trips/[id]/voice/capabilities — safe availability DTO. A read: it
 * never renews the session and missing/foreign trips return the uniform 404.
 */
export async function handleVoiceCapabilities(
  request: Request,
  context: { params: Promise<{ id: string }> },
  deps: VoiceRouteDeps,
): Promise<Response> {
  const session = await resolveSession(deps.pool, deps.config, request.headers.get("cookie"), {
    renew: false,
  });
  if (!session) {
    return errorResponse("UNAUTHORIZED", "missing or expired session", {}, 401);
  }
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) {
    return notFoundResponse();
  }
  const trip = await getTrip(deps.pool, id);
  if (!trip || trip.sessionId !== session.sessionId) {
    return notFoundResponse();
  }
  const runtime = deps.service.runtime();
  if (!runtime.ok) {
    return failureResponse(runtime.error);
  }
  return jsonResponse(capabilitiesFromRuntime(runtime.value));
}

/** POST /api/trips/[id]/voice/transcribe — one raw-WAV recording (10/min). */
export async function handleVoiceTranscribe(
  request: Request,
  context: { params: Promise<{ id: string }> },
  deps: VoiceRouteDeps,
): Promise<Response> {
  const guard = await guardMutation(
    request,
    { endpoint: "voice:stt", limit: 10, windowMs: 60_000 },
    { config: deps.config, pool: deps.pool },
  );
  if (!guard.ok) {
    return guard.response;
  }
  const { id } = await context.params;
  const result = await deps.service.transcribe({
    request,
    tripId: id,
    sessionId: guard.session.sessionId,
  });
  if (!result.ok) {
    return failureResponse(result.error);
  }
  return jsonResponse(result.value);
}

/** POST /api/trips/[id]/voice/synthesize — speak one settled assistant reply (20/min). */
export async function handleVoiceSynthesize(
  request: Request,
  context: { params: Promise<{ id: string }> },
  deps: VoiceRouteDeps,
): Promise<Response> {
  const guard = await guardMutation(
    request,
    { endpoint: "voice:tts", limit: 20, windowMs: 60_000 },
    { config: deps.config, pool: deps.pool },
  );
  if (!guard.ok) {
    return guard.response;
  }
  const { id } = await context.params;
  const result = await deps.service.synthesize({
    request,
    tripId: id,
    sessionId: guard.session.sessionId,
  });
  if (!result.ok) {
    return failureResponse(result.error);
  }
  // Raw bounded audio with private headers; no upstream headers are forwarded.
  return new Response(new Uint8Array(result.value.audio), {
    status: 200,
    headers: {
      ...PRIVATE_HEADERS,
      "content-type": result.value.contentType,
      "content-length": String(result.value.audio.byteLength),
    },
  });
}
