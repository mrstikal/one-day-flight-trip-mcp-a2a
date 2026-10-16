import { getServerDeps } from "@/lib/server";
import { getVoiceService } from "@/lib/voice-service";
import { handleVoiceCapabilities } from "@/lib/voice-routes";

/**
 * GET /api/trips/[id]/voice/capabilities — safe voice availability DTO.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const deps = getServerDeps();
  return handleVoiceCapabilities(request, context, {
    ...deps,
    service: getVoiceService(deps),
  });
}
