import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { technicalCancelApiRequestSchema } from "@odft/contracts";
import { cancelOperation } from "@odft/persistence";
import {
  A2AClient,
  DEFAULT_PROTOCOL_TIMEOUTS,
  trustedRegistrySchema,
  type ProtocolConfig,
} from "@odft/protocols";
import { reconcilePendingCancels } from "@odft/workflow";
import {
  envelopeResponse,
  errorResponse,
  jsonResponse,
  readJsonResult,
  scopeErrorResponse,
} from "@/lib/http";
import { denyArchivedTripWrite, guardMutation } from "@/lib/guard";

/**
 * POST /api/trips/[id]/operations/[operationId]/cancel — Phase 09 explicit
 * owner cancellation (ODTF_PLAN.md §3.13).
 *
 * A technical control action: it never increments `trip.revision`. The commit
 * revokes local authority atomically (fence/delegation revocation, durable
 * remote-cancel intent); SDK task cancellation is dispatched after commit and
 * reconciled independently, so the response never waits on remote services.
 * A duplicate control request replays the stored result without a revision bump.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Best-effort cancel transport over the trusted registry. A missing registry
 * (no coordinator delegation configured) resolves to a no-op transport: the
 * local commit already revoked authority, so remote reconciliation simply has
 * nothing to deliver and the intents persist as `failed` inspector evidence.
 */
function cancelTransport(): {
  cancelTask(input: { agentIdentity: string; delegationId: string; taskId: string }): Promise<void>;
} {
  const registryPath = process.env.ODFT_AGENT_REGISTRY_PATH;
  if (!registryPath) {
    return {
      async cancelTask() {
        throw new Error("no agent registry configured for remote cancellation");
      },
    };
  }
  let config: ProtocolConfig;
  try {
    const registry = trustedRegistrySchema.parse(
      JSON.parse(readFileSync(registryPath, "utf8")),
    );
    config = {
      selfAgentIdentity: "coordinator",
      registry,
      mcpRegistry: { schemaVersion: 1, services: [] },
      timeouts: DEFAULT_PROTOCOL_TIMEOUTS,
      resolveCredential: (ref) => process.env[ref],
    };
  } catch {
    return {
      async cancelTask() {
        throw new Error("the agent registry is invalid for remote cancellation");
      },
    };
  }
  const client = new A2AClient({ config });
  return {
    async cancelTask(input) {
      await client.cancelTask(input.agentIdentity, {
        id: input.taskId,
        tenant: "",
        metadata: undefined,
      });
    },
  };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; operationId: string }> },
): Promise<Response> {
  const guard = await guardMutation(request, {
    endpoint: "trips:cancel",
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
  const parsed = technicalCancelApiRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return envelopeResponse({ code: "VALIDATION_FAILED", message: "invalid cancel request", retryable: false });
  }

  const { id, operationId } = await context.params;
  const archived = await denyArchivedTripWrite({
    deps: guard.deps,
    sessionId: guard.session.sessionId,
    tripId: id,
  });
  if (archived) {
    return archived;
  }
  const result = await cancelOperation(guard.deps.pool, {
    tripId: id,
    sessionId: guard.session.sessionId,
    operationId,
    controlRequestId: parsed.data.controlRequestId ?? randomUUID(),
    expectedRevision: parsed.data.expectedRevision,
  });
  if (!("status" in result)) {
    return scopeErrorResponse(result);
  }
  // Best-effort remote SDK cancellation after commit: never blocks the control
  // response; failures persist as `failed` intents for the durable reconciler.
  void reconcilePendingCancels(guard.deps.pool, cancelTransport(), {
    limit: 25,
  }).catch(() => undefined);
  return jsonResponse(result, 202);
}
