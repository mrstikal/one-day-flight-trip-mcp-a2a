import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  agentTaskRequestSchema,
  type AgentTaskRequest,
  type ResearchDomain,
  type TripPreferences,
} from "@odft/contracts";
import {
  bindDelegationTask,
  contentHash,
  getAgentDelegation,
  insertAgentDelegation,
  insertOutboundMessage,
  markOutboundDelivery,
  type AgentDelegationRecord,
} from "@odft/persistence";

/**
 * Phase 07 durable outbound delegation (analysis §4/§5).
 *
 * Persistence order is binding: the delegation + outbound row commit BEFORE any
 * delivery attempt ("persist before deliver"); delivery outcomes are recorded in
 * short follow-up writes. The transport itself is injected (the worker adapts
 * the official A2A client), so this package never imports an HTTP/SDK surface.
 */

export interface DelegationTaskSnapshot {
  readonly taskId: string;
  /** SDK task state string, e.g. `completed`/`failed`/`input_required`. */
  readonly state: string;
  /** Parsed data artifacts of the task, newest last (id + payload). */
  readonly artifacts: readonly { readonly artifactId: string; readonly data: unknown }[];
  readonly failureCode?: string | null;
  /** `AgentInputRequestV1` payload when the specialist asked a question. */
  readonly question?: unknown;
}

export interface CoordinatorDelegationTransport {
  /**
   * Deliver one task to one specialist; resolves with the admitted task. The
   * message id is the PERSISTED outbound identity: a re-delivery reuses it, so
   * the specialist's admission returns the SAME canonical task instead of
   * executing the work twice.
   */
  sendTask(input: {
    agentIdentity: string;
    delegationId: string;
    messageId: string;
    /** Set for a continuation of an existing task (answer to a question). */
    taskId?: string;
    contextId?: string;
    data: unknown;
  }): Promise<{ taskId: string; contextId: string }>;
  /** Read the saved task (recovery/reconciliation path). */
  getTask(input: { agentIdentity: string; taskId: string }): Promise<DelegationTaskSnapshot>;
  /**
   * Phase 09 best-effort remote cancellation of one specialist task (cancel
   * outbox reconciler). The task may have completed already; a transport error
   * persists as `failed` inspector evidence, never a reconciler crash.
   */
  cancelTask(input: {
    agentIdentity: string;
    delegationId: string;
    taskId: string;
  }): Promise<void>;
}

export interface CreateOutboundDelegationInput {
  readonly tripId: string;
  readonly operationId: string;
  readonly acceptedRevision: number;
  readonly skillId: string;
  readonly agentIdentity: string;
  readonly endpointUrl: string;
  readonly snapshotId: string;
  readonly inputFingerprint: string;
  readonly domains: readonly (ResearchDomain | "flights")[];
  readonly objective?: "preserve_level" | "cheaper" | null;
  readonly levelOverride?: string | null;
  readonly allowRouteValidation: boolean;
  readonly allowItinerary: boolean;
  /** Task request WITHOUT the delegation id (assigned after insert). */
  readonly taskData: Record<string, unknown>;
  readonly deadlineAt: string;
}

export interface OutboundDelegation {
  readonly delegationId: string;
  readonly outboundId: string;
  readonly taskData: unknown;
}

/**
 * Persist the delegation + outbound delivery intent in the caller's transaction
 * (short, fenced). NO network call happens here.
 */
export async function createOutboundDelegation(
  client: Pick<PoolClient, "query">,
  input: CreateOutboundDelegationInput,
): Promise<OutboundDelegation> {
  const delegation = await insertAgentDelegation(client, {
    tripId: input.tripId,
    originatingOperationId: input.operationId,
    acceptedRevision: input.acceptedRevision,
    skillId: input.skillId,
    agentIdentity: input.agentIdentity,
    endpointUrl: input.endpointUrl,
    snapshotId: input.snapshotId,
    inputFingerprint: input.inputFingerprint,
    scope: {
      domains: input.domains as never,
      snapshotId: input.snapshotId,
      allowRouteValidation: input.allowRouteValidation,
      allowItinerary: input.allowItinerary,
      objective: input.objective ?? null,
      levelOverride: (input.levelOverride ?? null) as never,
    },
  });
  // The message the specialist receives names the delegation it must bind.
  const taskData = { ...input.taskData, delegationId: delegation.id };
  const outbound = await insertOutboundMessage(client, {
    delegationId: delegation.id,
    messageId: randomUUID(),
    payloadHash: contentHash(taskData),
    payload: taskData,
  });
  if (outbound.conflict) {
    throw new Error("outbound delegation payload conflict");
  }
  return { delegationId: delegation.id, outboundId: outbound.record.id, taskData };
}

/** Deliver one persisted delegation; the outcome is recorded in short writes. */
export async function deliverDelegation(
  pool: Pool,
  transport: CoordinatorDelegationTransport,
  input: {
    delegationId: string;
    agentIdentity: string;
    data: unknown;
    /** Continue an existing task instead of first delivery (answer path). */
    taskId?: string;
    contextId?: string;
  },
): Promise<{ taskId: string | null; contextId: string | null; delivered: boolean; reason: string | null }> {
  // A continuation carries its own persisted message identity; the first
  // delivery reuses the oldest persisted outbound intent.
  const continuation = input.taskId !== undefined;
  const outbound = continuation
    ? undefined
    : await getOutboundMessageForDelegation(pool, input.delegationId);
  const messageId = continuation
    ? await latestOutboundMessageId(pool, input.delegationId)
    : outbound?.messageId;
  if (!messageId) {
    return { taskId: null, contextId: null, delivered: false, reason: "no persisted outbound intent" };
  }
  try {
    const sent = await transport.sendTask({
      agentIdentity: input.agentIdentity,
      delegationId: input.delegationId,
      messageId,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
      data: input.data,
    });
    await bindDelegationTask(pool, {
      delegationId: input.delegationId,
      taskId: sent.taskId,
      contextId: sent.contextId,
      status: "dispatched",
    });
    await markOutboundDelivery(pool, {
      delegationId: input.delegationId,
      messageId,
      state: "acknowledged",
    });
    return { taskId: sent.taskId, contextId: sent.contextId, delivered: true, reason: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "delivery failed";
    await markOutboundDelivery(pool, {
      delegationId: input.delegationId,
      messageId,
      state: "failed",
      errorCode: "AGENT_UNAVAILABLE",
    }).catch(() => undefined);
    return { taskId: null, contextId: null, delivered: false, reason };
  }
}

/** The persisted delegation + outbound intent (recovery path). */
export async function loadDelegationDelivery(
  pool: Pool,
  delegationId: string,
): Promise<{
  delegation: AgentDelegationRecord | undefined;
  outbound: { payload: unknown; payloadHash: string; state: string } | undefined;
}> {
  const [delegation, outbound] = await Promise.all([
    getAgentDelegation(pool, delegationId),
    getOutboundMessageForDelegation(pool, delegationId),
  ]);
  return {
    delegation,
    outbound: outbound
      ? { payload: outbound.payload, payloadHash: outbound.payloadHash, state: outbound.deliveryState }
      : undefined,
  };
}

/** One artifact of a finished task whose correlation matches the delegation. */
export interface IngestedArtifact {
  readonly payloadHash: string;
  readonly value: unknown;
}

/**
 * Validate one parsed artifact against the delegation binding and hash it.
 * Returns undefined for a foreign/stale artifact (rejected, never a crash).
 */
export function acceptArtifact(input: {
  artifact: unknown;
  delegation: AgentDelegationRecord;
  operationId: string;
  acceptedRevision: number;
}): IngestedArtifact | undefined {
  const value = input.artifact as {
    correlation?: {
      delegationId?: unknown;
      tripId?: unknown;
      operationId?: unknown;
      acceptedRevision?: unknown;
      snapshotId?: unknown;
    };
  } | null;
  const correlation = value?.correlation;
  if (!correlation) {
    return undefined;
  }
  if (
    correlation.delegationId !== input.delegation.id ||
    correlation.tripId !== input.delegation.tripId ||
    correlation.operationId !== input.operationId ||
    correlation.acceptedRevision !== input.acceptedRevision ||
    correlation.snapshotId !== input.delegation.snapshotId
  ) {
    return undefined;
  }
  return { payloadHash: contentHash(value), value };
}

/** Build the flight task request the specialist binds against the delegation. */
export function buildFlightTaskRequest(input: {
  tripId: string;
  operationId: string;
  acceptedRevision: number;
  snapshotId: string;
  scenarioKey: string;
  routeApprovalFingerprint: string;
  scheduleApprovalFingerprint: string;
  inputFingerprint: string;
  travelVariant: AgentTaskRequest["travelVariant"];
  adults: number;
  sightseeingDate: string;
  effectiveLevel: AgentTaskRequest["effectiveLevel"];
  traceId: string;
  preferences: TripPreferences;
}): Record<string, unknown> {
  return agentTaskRequestSchema.parse({
    schemaVersion: 1,
    skillId: "flight.recommend.v1",
    tripId: input.tripId,
    operationId: input.operationId,
    acceptedRevision: input.acceptedRevision,
    // Placeholder: replaced with the fresh delegation id after the insert.
    delegationId: randomUUID(),
    traceId: input.traceId,
    snapshot: {
      snapshotId: input.snapshotId,
      scenarioKey: input.scenarioKey,
      routeApprovalFingerprint: input.routeApprovalFingerprint,
      scheduleApprovalFingerprint: input.scheduleApprovalFingerprint,
      domainFingerprints: {},
    },
    inputFingerprint: input.inputFingerprint,
    // The frozen request schema has no `flights` option (it predates the
    // specialist services); the flight agent derives its domain from the
    // delegation scope, so this stays a schema-valid placeholder.
    requestedDomains: ["hotel"],
    travelVariant: input.travelVariant,
    adults: input.adults,
    sightseeingDate: input.sightseeingDate,
    effectiveLevel: input.effectiveLevel,
    selectedOfferIds: [],
    confirmedOfferIds: [],
    preservationConstraints: [],
    searchObjective: "preserve_level",
    queryContext: {},
    deadlineAt: new Date(Date.now() + 300_000).toISOString(),
    limits: { activeTimeMs: 60_000, mcpInvocations: 4, llmTransportAttempts: 2, maxTaskCostUsd: 0.1 },
    preferences: input.preferences,
    continuation: null,
  });
}

export function newTraceId(): string {
  return `trace-${randomUUID().slice(0, 8)}`;
}

/** Newest persisted outbound message id of one delegation (continuation path). */
async function latestOutboundMessageId(pool: Pool, delegationId: string): Promise<string | undefined> {
  const result = await pool.query<{ message_id: string }>(
    `SELECT message_id FROM odft_app.protocol_outbound_messages
      WHERE delegation_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [delegationId],
  );
  return result.rows[0]?.message_id;
}

/** Insert a persisted continuation intent (answer to a specialist question). */
export async function insertContinuationOutbound(
  pool: Pool,
  input: { delegationId: string; payload: unknown; continuationGeneration: number },
): Promise<{ messageId: string }> {
  const messageId = randomUUID();
  const written = await insertOutboundMessage(pool, {
    delegationId: input.delegationId,
    messageId,
    payloadHash: contentHash(input.payload),
    payload: input.payload,
    continuationGeneration: input.continuationGeneration,
  });
  if (written.conflict) {
    throw new Error("continuation outbound conflict");
  }
  return { messageId };
}

/** Newest outbound intent of one delegation (one task per delegation). */
async function getOutboundMessageForDelegation(
  pool: Pool,
  delegationId: string,
): Promise<{ messageId: string; payload: unknown; payloadHash: string; deliveryState: string } | undefined> {
  const result = await pool.query<{
    message_id: string;
    payload: unknown;
    payload_hash: string;
    delivery_state: string;
  }>(
    `SELECT message_id, payload, payload_hash, delivery_state
       FROM odft_app.protocol_outbound_messages
      WHERE delegation_id = $1
      ORDER BY created_at ASC LIMIT 1`,
    [delegationId],
  );
  const row = result.rows[0];
  if (!row) {
    return undefined;
  }
  return {
    messageId: row.message_id,
    payload: row.payload,
    payloadHash: row.payload_hash,
    deliveryState: row.delivery_state,
  };
}
