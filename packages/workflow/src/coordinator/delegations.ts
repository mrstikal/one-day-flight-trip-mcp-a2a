import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  accommodationRecommendationsSchema,
  agentTaskRequestLimits,
  agentTaskRequestSchema,
  cityGuideRecommendationsSchema,
  delegationScopeSchema,
  flightRecommendationsSchema,
  itineraryProposalSchema,
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
  setDelegationCurrentOperation,
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
   * Validate the advertised card/skill binding before persisting a delegation
   * and return the card version recorded on it (plan §3.3). Optional so test
   * doubles that never speak A2A stay compatible.
   */
  describeAgent?(input: {
    agentIdentity: string;
    skillId: string;
  }): Promise<{ cardVersion: string }>;
  /**
   * Phase 09 best-effort remote cancellation of one specialist task (cancel
   * outbox reconciler). The task may have completed already; a transport error
   * persists as `failed` inspector evidence, never a reconciler crash.
   */
  cancelTask(input: { agentIdentity: string; delegationId: string; taskId: string }): Promise<void>;
}

export interface CreateOutboundDelegationInput {
  readonly tripId: string;
  readonly operationId: string;
  readonly acceptedRevision: number;
  readonly skillId: string;
  readonly agentIdentity: string;
  readonly endpointUrl: string;
  /** Advertised agent-card version validated before the delegation is persisted. */
  readonly cardVersion?: string;
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
  /** Phase 09/11: 1 for the first attempt, 2 for the bounded retry. */
  readonly attempt?: number;
}

export interface OutboundDelegation {
  readonly delegationId: string;
  readonly outboundId: string;
  readonly taskData: unknown;
}

/**
 * Bind a delegation to the card the agent actually advertises (skill + card
 * version). A registry/card mismatch surfaces at dispatch, not as a late
 * artifact rejection.
 */
export async function resolveCardVersion(
  transport: CoordinatorDelegationTransport,
  agentIdentity: string,
  skillId: string,
): Promise<string | undefined> {
  if (!transport.describeAgent) {
    return undefined;
  }
  try {
    const binding = await transport.describeAgent({ agentIdentity, skillId });
    return binding.cardVersion;
  } catch (error) {
    const failure = new Error(
      `agent card validation failed for ${agentIdentity}/${skillId}: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    ) as Error & { code?: string };
    failure.code = "AGENT_UNAVAILABLE";
    throw failure;
  }
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
    ...(input.cardVersion !== undefined ? { cardVersion: input.cardVersion } : {}),
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
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
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
): Promise<{
  taskId: string | null;
  contextId: string | null;
  delivered: boolean;
  reason: string | null;
}> {
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
    return {
      taskId: null,
      contextId: null,
      delivered: false,
      reason: "no persisted outbound intent",
    };
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
      ? {
          payload: outbound.payload,
          payloadHash: outbound.payloadHash,
          state: outbound.deliveryState,
        }
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
  /**
   * Snapshot manifest hashes for the delegation's scopes. When supplied, every
   * hash PRESENT in `correlation.domainFingerprints` must equal the manifest
   * hash, and every successful outcome must carry one (plan §3.5
   * "snapshot/domain hash equality"). A domain that produced no page may be
   * omitted; its outcome is handled as a partial failure.
   */
  expectedDomainFingerprints?: Readonly<Record<string, string | undefined>>;
}): IngestedArtifact | undefined {
  const value = input.artifact as {
    correlation?: {
      delegationId?: unknown;
      tripId?: unknown;
      operationId?: unknown;
      acceptedRevision?: unknown;
      snapshotId?: unknown;
      skillId?: unknown;
      inputFingerprint?: unknown;
      domainFingerprints?: unknown;
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
    correlation.snapshotId !== input.delegation.snapshotId ||
    correlation.skillId !== input.delegation.skillId ||
    correlation.inputFingerprint !== input.delegation.inputFingerprint
  ) {
    return undefined;
  }

  const observedDomainFingerprints =
    correlation.domainFingerprints &&
    typeof correlation.domainFingerprints === "object" &&
    !Array.isArray(correlation.domainFingerprints)
      ? (correlation.domainFingerprints as Record<string, unknown>)
      : undefined;
  if (input.expectedDomainFingerprints) {
    for (const [domain, expected] of Object.entries(input.expectedDomainFingerprints)) {
      const observedHash = observedDomainFingerprints?.[domain];
      // A domain that produced no page is omitted from the correlation (its
      // outcome is a partial failure); only a PRESENT hash must match. Absence
      // must not reject the successful sibling domains of the same artifact.
      // The success-presence rule below closes the omission loophole.
      if (observedHash !== undefined && observedHash !== expected) {
        return undefined;
      }
    }
  }

  // Validate the payload against the skill's contract, not only its envelope.
  // A matching correlation with an unknown flight id or a self-claimed wrong
  // fingerprint must never become an accepted delegation.
  const parsed =
    input.delegation.skillId === "flight.recommend.v1"
      ? flightRecommendationsSchema.safeParse(value)
      : input.delegation.skillId === "accommodation.recommend.v1"
        ? accommodationRecommendationsSchema.safeParse(value)
        : input.delegation.skillId === "city-guide.research.v1"
          ? cityGuideRecommendationsSchema.safeParse(value)
          : input.delegation.skillId === "itinerary.propose.v1"
            ? itineraryProposalSchema.safeParse(value)
            : undefined;
  if (!parsed) {
    return undefined;
  }
  if (!parsed.success) {
    return undefined;
  }

  // The artifact may only report the scope it was granted.
  const scope = delegationScopeSchema.safeParse(input.delegation.scope);
  if (!scope.success) {
    return undefined;
  }
  if (
    input.delegation.skillId === "city-guide.research.v1" &&
    "outcomes" in parsed.data &&
    !parsed.data.outcomes.every((outcome) => scope.data.domains.includes(outcome.domain))
  ) {
    return undefined;
  }
  if (
    input.delegation.skillId === "accommodation.recommend.v1" &&
    "searchObjective" in parsed.data &&
    scope.data.objective !== null &&
    parsed.data.searchObjective !== scope.data.objective
  ) {
    return undefined;
  }

  if (input.expectedDomainFingerprints && input.delegation.skillId !== "itinerary.propose.v1") {
    // Evidence is mandatory for SUCCESS: every `ok` outcome (or the single
    // flight/hotel domain) must carry the exact snapshot manifest hash. Failed
    // domains may omit it because no page was produced.
    if ("outcomes" in parsed.data) {
      for (const outcome of parsed.data.outcomes) {
        if (outcome.status !== "ok") {
          continue;
        }
        const expected = input.expectedDomainFingerprints[outcome.domain];
        if (expected !== undefined && observedDomainFingerprints?.[outcome.domain] !== expected) {
          return undefined;
        }
      }
    } else {
      for (const domain of scope.data.domains) {
        const expected = input.expectedDomainFingerprints[domain];
        if (expected !== undefined && observedDomainFingerprints?.[domain] !== expected) {
          return undefined;
        }
      }
    }
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
    // `requestedDomains` carries delegation scopes (flights included), so the
    // flight binding states its real scope instead of a placeholder.
    requestedDomains: ["flights"],
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
    limits: agentTaskRequestLimits("flight.recommend.v1"),
    preferences: input.preferences,
    continuation: null,
  });
}

export function newTraceId(): string {
  return `trace-${randomUUID().slice(0, 8)}`;
}

/** Newest persisted outbound message id of one delegation (continuation path). */
async function latestOutboundMessageId(
  pool: Pool,
  delegationId: string,
): Promise<string | undefined> {
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
  input: {
    delegationId: string;
    payload: unknown;
    continuationGeneration: number;
    /** The operation that now counts on the continued delegation. */
    operationId: string;
  },
): Promise<{ messageId: string }> {
  const payloadHash = contentHash(input.payload);
  // Replay-safe identity: the same answer for the same generation always maps
  // to the same persisted message. After a delivery succeeds but the cursor
  // write is lost, recovery re-delivers the SAME message id, which the
  // specialist admission dedupes to the canonical task instead of consuming the
  // answer twice (and failing the generation CAS).
  const messageId = deterministicUuid(
    `continuation:${input.delegationId}:${input.continuationGeneration}:${payloadHash}`,
  );
  // The continuation moves the delegation's authority to the answering
  // operation in the SAME transaction as the durable outbound intent: a cancel
  // of that operation must revoke the delegation it now depends on.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const state = await client.query<{ status: string }>(
      `SELECT status FROM odft_app.agent_delegations WHERE id = $1 FOR UPDATE`,
      [input.delegationId],
    );
    const status = state.rows[0]?.status;
    if (
      status === undefined ||
      !["pending", "dispatched", "working", "input_required"].includes(status)
    ) {
      await client.query("ROLLBACK");
      throw new Error("continuation target is not an active delegation");
    }
    await setDelegationCurrentOperation(client, {
      delegationId: input.delegationId,
      operationId: input.operationId,
    });
    const written = await insertOutboundMessage(client, {
      delegationId: input.delegationId,
      messageId,
      payloadHash,
      payload: input.payload,
      continuationGeneration: input.continuationGeneration,
    });
    if (written.conflict) {
      await client.query("ROLLBACK");
      throw new Error("continuation outbound conflict");
    }
    await client.query("COMMIT");
    return { messageId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Stable UUID-shaped identity derived from a seed (replay-safe message ids). */
function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed, "utf8").digest().subarray(0, 16);
  // RFC 9562 version 5-style variant/version bits; the value is only an opaque
  // message identity, never a security token.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Newest outbound intent of one delegation (one task per delegation). */
async function getOutboundMessageForDelegation(
  pool: Pool,
  delegationId: string,
): Promise<
  { messageId: string; payload: unknown; payloadHash: string; deliveryState: string } | undefined
> {
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
