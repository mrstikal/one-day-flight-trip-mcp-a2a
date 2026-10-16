import { getServerDeps } from "@/lib/server";
import { clientIp, errorResponse, notFoundResponse } from "@/lib/http";
import { resolveSession } from "@/lib/session";
import { consumeRateLimit, scopeHash } from "@/lib/rate-limit";
import { listTripEvents, projectSafeEvent } from "@odft/persistence";

/**
 * GET /api/trips/[id]/events — server-sent event stream with replay from a
 * monotonic event id. Every poll re-authorizes ownership and session validity
 * (reads never renew), emits a heartbeat so idle connections stay open, and
 * serves only safe projection fields (never checkpoint internals).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLL_INTERVAL_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_STREAM_MS = 5 * 60 * 1_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

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

  const owned = await deps.pool.query<{ session_id: string }>(
    `SELECT session_id FROM odft_app.trips WHERE id = $1`,
    [id],
  );
  if (!owned.rows[0] || owned.rows[0].session_id !== session.sessionId) {
    return notFoundResponse();
  }

  const limit = await consumeRateLimit(deps.pool, {
    scopeHash: scopeHash(deps.config, `${session.sessionId}:${id}:${clientIp(request, deps.config.trustProxy)}`),
    endpoint: "sse:connect",
    limit: 30,
    windowMs: 60_000,
  });
  if (!limit.allowed) {
    return errorResponse("RATE_LIMITED", "too many event-stream connections", {}, 429);
  }

  const url = new URL(request.url);
  const requestedCursor = request.headers.get("last-event-id") ?? url.searchParams.get("after") ?? "0";
  // Decimal-string cursors only: a malformed value replays from the beginning
  // (deduped client-side by event id) instead of being interpreted loosely.
  let cursor = /^\d+$/.test(requestedCursor) ? requestedCursor : "0";
  const encoder = new TextEncoder();
  const signal = request.signal;
  const cookieHeader = request.headers.get("cookie");

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const deadline = Date.now() + MAX_STREAM_MS;
      let lastHeartbeat = Date.now();
      controller.enqueue(encoder.encode("retry: 3000\n: connected\n\n"));
      while (!signal.aborted && Date.now() < deadline) {
        try {
          // Re-authorize on every poll: an expired session cannot keep reading.
          const current = await resolveSession(deps.pool, deps.config, cookieHeader, {
            renew: false,
          });
          if (!current || current.sessionId !== session.sessionId) {
            break;
          }
          const events = await listTripEvents(deps.pool, id, { after: cursor, limit: 100 });
          for (const event of events) {
            const data = JSON.stringify({
              type: event.type,
              operationId: event.operationId,
              // Read-side defense in depth: even a row written before the
              // allowlist existed (or by a direct insert) is projected before it
              // leaves the server.
              payload: projectSafeEvent(event.type, event.payload),
              at: event.createdAt,
            });
            controller.enqueue(encoder.encode(`id: ${event.id}\nevent: ${event.type}\ndata: ${data}\n\n`));
            cursor = event.id;
          }
        } catch {
          // A transient database error ends the stream; the client reconnects
          // with Last-Event-ID and resumes without re-receiving events.
          break;
        }
        if (Date.now() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
          controller.enqueue(encoder.encode(": hb\n\n"));
          lastHeartbeat = Date.now();
        }
        await sleep(POLL_INTERVAL_MS, signal);
      }
      try {
        controller.close();
      } catch {
        // Already closed by the client.
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      vary: "Cookie",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
