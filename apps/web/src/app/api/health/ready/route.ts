import { NextResponse } from "next/server";
import { ConfigError, checkReadiness, createPool, parseServerConfig } from "@odft/persistence";

/**
 * Readiness probe. Returns 200 only when the database is reachable, migrations
 * and the checkpointer schema are present, and the worker heartbeat is recent.
 * Liveness is local and never calls OpenRouter or map tiles. No secret is
 * included in the response.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type ReadinessPool = ReturnType<typeof createPool>;

// Cache the pool across dev HMR / route module re-evaluations so we do not leak
// pools. In production this is simply a module-scoped singleton.
const globalForReadiness = globalThis as unknown as { __odftReadinessPool?: ReadinessPool };

function getPool(): ReadinessPool {
  if (!globalForReadiness.__odftReadinessPool) {
    const config = parseServerConfig();
    globalForReadiness.__odftReadinessPool = createPool(config, { applicationName: "odft-web" });
  }
  return globalForReadiness.__odftReadinessPool;
}

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET() {
  try {
    const report = await checkReadiness(getPool());
    return NextResponse.json(report, {
      status: report.ready ? 200 : 503,
      headers: NO_STORE,
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      return NextResponse.json(
        { ready: false, error: "configuration_invalid", issues: error.issues },
        { status: 503, headers: NO_STORE },
      );
    }
    process.stderr.write(
      JSON.stringify({
        level: "error",
        component: "readiness-route",
        message: "readiness check failed",
        error: error instanceof Error ? error.message : "unknown error",
      }) + "\n",
    );
    return NextResponse.json(
      { ready: false, error: "readiness_check_failed" },
      { status: 503, headers: NO_STORE },
    );
  }
}
