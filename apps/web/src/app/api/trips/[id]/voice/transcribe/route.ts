import { getServerDeps } from "@/lib/server";
import { getVoiceService } from "@/lib/voice-service";
import { handleVoiceTranscribe } from "@/lib/voice-routes";

/**
 * POST /api/trips/[id]/voice/transcribe — one raw audio/wav recording; the
 * transcript is returned for explicit insertion (dictation never sends chat).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const deps = getServerDeps();
  return handleVoiceTranscribe(request, context, {
    ...deps,
    service: getVoiceService(deps),
  });
}
