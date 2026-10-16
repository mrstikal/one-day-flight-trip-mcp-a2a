import { getServerDeps } from "@/lib/server";
import { getVoiceService } from "@/lib/voice-service";
import { handleVoiceSynthesize } from "@/lib/voice-routes";

/**
 * POST /api/trips/[id]/voice/synthesize — speak one eligible persisted
 * assistant message id; MP3 in live mode, valid WAV fixture bytes offline.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const deps = getServerDeps();
  return handleVoiceSynthesize(request, context, {
    ...deps,
    service: getVoiceService(deps),
  });
}
