import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { AgentTaskSafeState } from "@odft/contracts";

type Queryable = Pick<PoolClient, "query">;

/**
 * Phase 03 inbound admission, task control and validated-output cache
 * (plan §3.7).
 *
 * Transaction/fence ownership: `admitInboundMessage` MUST run inside the
 * caller's transaction and locks the `(agentIdentity, messageId)` row before
 * deciding admitted/replay/conflict, so the canonical task mapping and the
 * admission record commit atomically before any executor work starts. All other
 * functions run on the caller's client without opening a transaction.
 */

export interface InboundAdmissionRow {
  readonly id: string;
  readonly agentIdentity: string;
  readonly messageId: string;
  readonly payloadHash: string;
  readonly taskId: string | null;
  readonly contextId: string | null;
  readonly state: "admitted" | "mapped" | "completed" | "failed" | "conflicted";
}

interface AdmissionDbRow {
  id: string;
  agent_identity: string;
  message_id: string;
  payload_hash: string;
  task_id: string | null;
  context_id: string | null;
  state: InboundAdmissionRow["state"];
}

function toAdmission(row: AdmissionDbRow): InboundAdmissionRow {
  return {
    id: row.id,
    agentIdentity: row.agent_identity,
    messageId: row.message_id,
    payloadHash: row.payload_hash,
    taskId: row.task_id,
    contextId: row.context_id,
    state: row.state,
  };
}

export type AdmissionOutcome =
  | { readonly kind: "admitted"; readonly admission: InboundAdmissionRow }
  | { readonly kind: "replay"; readonly admission: InboundAdmissionRow }
  | { readonly kind: "conflict"; readonly admission: InboundAdmissionRow };

/**
 * Claim `(agentIdentity, messageId)` inside the caller's transaction.
 *
 * - absent → inserted as `admitted` (the caller then commits the canonical SDK
 *   task + mapping before any work);
 * - present with the same payload hash → `replay` (retrieve/attach, never a
 *   second computation);
 * - present with a different payload hash → `conflict` (safe rejection).
 */
export async function admitInboundMessage(
  client: Queryable,
  input: { agentIdentity: string; messageId: string; payloadHash: string },
): Promise<AdmissionOutcome> {
  const existing = await client.query<AdmissionDbRow>(
    `SELECT id, agent_identity, message_id, payload_hash, task_id, context_id, state
       FROM odft_app.protocol_inbound_messages
      WHERE agent_identity = $1 AND message_id = $2
      FOR UPDATE`,
    [input.agentIdentity, input.messageId],
  );
  const row = existing.rows[0];
  if (row) {
    return {
      kind: row.payload_hash === input.payloadHash ? "replay" : "conflict",
      admission: toAdmission(row),
    };
  }
  const inserted = await client.query<AdmissionDbRow>(
    `INSERT INTO odft_app.protocol_inbound_messages (id, agent_identity, message_id, payload_hash, state)
     VALUES ($1, $2, $3, $4, 'admitted')
     RETURNING id, agent_identity, message_id, payload_hash, task_id, context_id, state`,
    [randomUUID(), input.agentIdentity, input.messageId, input.payloadHash],
  );
  return { kind: "admitted", admission: toAdmission(inserted.rows[0] as AdmissionDbRow) };
}

/** Bind the canonical SDK task/context to an admitted message (same transaction). */
export async function mapInboundMessage(
  client: Queryable,
  input: { agentIdentity: string; messageId: string; taskId: string; contextId: string },
): Promise<void> {
  const result = await client.query(
    `UPDATE odft_app.protocol_inbound_messages
        SET task_id = $3, context_id = $4, state = 'mapped', mapped_at = now()
      WHERE agent_identity = $1 AND message_id = $2 AND state = 'admitted'`,
    [input.agentIdentity, input.messageId, input.taskId, input.contextId],
  );
  if (result.rowCount !== 1) {
    throw new Error(
      `inbound message ${input.messageId} is not in the admitted state; refusing to map a task to it`,
    );
  }
}

export async function completeInboundMessage(
  client: Queryable,
  input: { agentIdentity: string; messageId: string; state: "completed" | "failed" },
): Promise<void> {
  await client.query(
    `UPDATE odft_app.protocol_inbound_messages SET state = $3
      WHERE agent_identity = $1 AND message_id = $2 AND state IN ('admitted','mapped')`,
    [input.agentIdentity, input.messageId, input.state],
  );
}

/** Admitted-but-unmapped messages of one agent (crash between claim and work). */
export async function listUnmappedAdmissions(
  client: Queryable,
  agentIdentity: string,
): Promise<InboundAdmissionRow[]> {
  const result = await client.query<AdmissionDbRow>(
    `SELECT id, agent_identity, message_id, payload_hash, task_id, context_id, state
       FROM odft_app.protocol_inbound_messages
      WHERE agent_identity = $1 AND state = 'admitted'
      ORDER BY admitted_at`,
    [agentIdentity],
  );
  return result.rows.map(toAdmission);
}

/* ---- Task control and counters -------------------------------------------------- */

export interface TaskControlRecord {
  readonly agentIdentity: string;
  readonly taskId: string;
  readonly contextId: string;
  readonly delegationId: string | null;
  readonly activeOwner: string | null;
  readonly state: AgentTaskSafeState;
  readonly activeTimeMs: number;
  readonly mcpInvocations: number;
  readonly llmAttempts: number;
  readonly inputCount: number;
  readonly reservedCostUsd: number;
  readonly actualCostUsd: number;
  readonly inputGeneration: number;
  readonly inputRequestId: string | null;
  readonly inputRequestHash: string | null;
  readonly inputExpiresAt: string | null;
  readonly cancelRequestedAt: string | null;
  readonly restartFailedAt: string | null;
}

interface TaskControlRow {
  agent_identity: string;
  task_id: string;
  context_id: string;
  delegation_id: string | null;
  active_owner: string | null;
  state: AgentTaskSafeState;
  active_time_ms: string;
  mcp_invocations: number;
  llm_attempts: number;
  input_count: number;
  reserved_cost_usd: string;
  actual_cost_usd: string;
  input_generation: number;
  input_request_id: string | null;
  input_request_hash: string | null;
  input_expires_at: Date | null;
  cancel_requested_at: Date | null;
  restart_failed_at: Date | null;
}

const TASK_CONTROL_COLUMNS =
  "agent_identity, task_id, context_id, delegation_id, active_owner, state, active_time_ms, mcp_invocations, " +
  "llm_attempts, input_count, reserved_cost_usd, actual_cost_usd, input_generation, input_request_id, " +
  "input_request_hash, input_expires_at, cancel_requested_at, restart_failed_at";

function toTaskControl(row: TaskControlRow): TaskControlRecord {
  return {
    agentIdentity: row.agent_identity,
    taskId: row.task_id,
    contextId: row.context_id,
    delegationId: row.delegation_id,
    activeOwner: row.active_owner,
    state: row.state,
    activeTimeMs: Number(row.active_time_ms),
    mcpInvocations: row.mcp_invocations,
    llmAttempts: row.llm_attempts,
    inputCount: row.input_count,
    reservedCostUsd: Number(row.reserved_cost_usd),
    actualCostUsd: Number(row.actual_cost_usd),
    inputGeneration: row.input_generation,
    inputRequestId: row.input_request_id,
    inputRequestHash: row.input_request_hash,
    inputExpiresAt: row.input_expires_at ? row.input_expires_at.toISOString() : null,
    cancelRequestedAt: row.cancel_requested_at ? row.cancel_requested_at.toISOString() : null,
    restartFailedAt: row.restart_failed_at ? row.restart_failed_at.toISOString() : null,
  };
}

export async function upsertTaskControl(
  client: Queryable,
  input: {
    agentIdentity: string;
    taskId: string;
    contextId: string;
    delegationId?: string;
    state?: AgentTaskSafeState;
    inputGeneration?: number;
  },
): Promise<TaskControlRecord> {
  const result = await client.query<TaskControlRow>(
    `INSERT INTO odft_app.protocol_task_control
       (agent_identity, task_id, context_id, delegation_id, state, input_generation)
     VALUES ($1, $2, $3, $4, COALESCE($5, 'submitted'), COALESCE($6, 1))
     ON CONFLICT (agent_identity, task_id) DO UPDATE
        SET context_id = EXCLUDED.context_id,
            delegation_id = COALESCE(EXCLUDED.delegation_id, odft_app.protocol_task_control.delegation_id),
            state = EXCLUDED.state,
            input_generation = GREATEST(odft_app.protocol_task_control.input_generation, EXCLUDED.input_generation),
            updated_at = now()
     RETURNING ${TASK_CONTROL_COLUMNS}`,
    [
      input.agentIdentity,
      input.taskId,
      input.contextId,
      input.delegationId ?? null,
      input.state ?? null,
      input.inputGeneration ?? null,
    ],
  );
  return toTaskControl(result.rows[0] as TaskControlRow);
}

export async function getTaskControl(
  client: Queryable,
  input: { agentIdentity: string; taskId: string },
): Promise<TaskControlRecord | undefined> {
  const result = await client.query<TaskControlRow>(
    `SELECT ${TASK_CONTROL_COLUMNS} FROM odft_app.protocol_task_control
      WHERE agent_identity = $1 AND task_id = $2`,
    [input.agentIdentity, input.taskId],
  );
  const row = result.rows[0];
  return row ? toTaskControl(row) : undefined;
}

/**
 * Atomically reserve one MCP invocation against the cumulative task cap.
 *
 * A single conditional UPDATE is the only correct form under concurrency: a
 * read-then-write (refresh, assert, count) lets N callers pass on the same
 * snapshot and exceed the cap by N-1.
 */
export async function reserveTaskMcpInvocation(
  client: Queryable,
  input: { agentIdentity: string; taskId: string; maxInvocations: number },
): Promise<boolean> {
  const result = await client.query(
    `UPDATE odft_app.protocol_task_control
        SET mcp_invocations = mcp_invocations + 1, updated_at = now()
      WHERE agent_identity = $1 AND task_id = $2
        AND mcp_invocations < $3
      RETURNING mcp_invocations`,
    [input.agentIdentity, input.taskId, input.maxInvocations],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Cumulative counters: continuations never reset them (GREATEST/sum semantics). */
export async function addTaskCounters(
  client: Queryable,
  input: {
    agentIdentity: string;
    taskId: string;
    activeTimeMs?: number;
    mcpInvocations?: number;
    llmAttempts?: number;
    inputCount?: number;
    reservedCostUsd?: number;
    actualCostUsd?: number;
  },
): Promise<void> {
  await client.query(
    `UPDATE odft_app.protocol_task_control
        SET active_time_ms = active_time_ms + COALESCE($3, 0),
            mcp_invocations = mcp_invocations + COALESCE($4, 0),
            llm_attempts = llm_attempts + COALESCE($5, 0),
            input_count = input_count + COALESCE($6, 0),
            reserved_cost_usd = reserved_cost_usd + COALESCE($7, 0),
            actual_cost_usd = actual_cost_usd + COALESCE($8, 0),
            updated_at = now()
      WHERE agent_identity = $1 AND task_id = $2`,
    [
      input.agentIdentity,
      input.taskId,
      input.activeTimeMs ?? 0,
      input.mcpInvocations ?? 0,
      input.llmAttempts ?? 0,
      input.inputCount ?? 0,
      input.reservedCostUsd ?? 0,
      input.actualCostUsd ?? 0,
    ],
  );
}

export async function setTaskState(
  client: Queryable,
  input: {
    agentIdentity: string;
    taskId: string;
    state: AgentTaskSafeState;
    activeOwner?: string | null;
    inputGeneration?: number;
  },
): Promise<void> {
  await client.query(
    `UPDATE odft_app.protocol_task_control
        SET state = $3,
            active_owner = $4,
            input_generation = COALESCE($5, input_generation),
            updated_at = now()
      WHERE agent_identity = $1 AND task_id = $2`,
    [
      input.agentIdentity,
      input.taskId,
      input.state,
      input.activeOwner ?? null,
      input.inputGeneration ?? null,
    ],
  );
}

export async function requestTaskCancellation(
  client: Queryable,
  input: { agentIdentity: string; taskId: string },
): Promise<void> {
  await client.query(
    `UPDATE odft_app.protocol_task_control
        SET cancel_requested_at = COALESCE(cancel_requested_at, now()), updated_at = now()
      WHERE agent_identity = $1 AND task_id = $2`,
    [input.agentIdentity, input.taskId],
  );
}

/**
 * Phase 06: persist the pending specialist question (plan §3.10). The row must
 * be the active invocation's; callers already asserted the input allowance.
 */
export async function recordInputRequest(
  client: Queryable,
  input: {
    agentIdentity: string;
    taskId: string;
    requestId: string;
    requestHash: string;
    expiresAt: string;
  },
): Promise<void> {
  const result = await client.query(
    `UPDATE odft_app.protocol_task_control
        SET state = 'input_required',
            active_owner = NULL,
            input_count = input_count + 1,
            input_request_id = $3,
            input_request_hash = $4,
            input_expires_at = $5::timestamptz,
            updated_at = now()
      WHERE agent_identity = $1 AND task_id = $2`,
    [input.agentIdentity, input.taskId, input.requestId, input.requestHash, input.expiresAt],
  );
  if (result.rowCount !== 1) {
    throw new Error(
      "the canonical task-control row is required before a question can be persisted",
    );
  }
}

export interface ConsumeInputContinuationResult {
  readonly ok: boolean;
  /** Safe failure category when `ok` is false. */
  readonly code: "INPUT_EXPIRED" | "STALE_AGENT_RESULT" | null;
  readonly reason: string | null;
}

/**
 * Consume exactly one accepted continuation (plan §3.10): the compare-and-swap
 * clears the pending binding so a second, different answer can never be
 * accepted for the same question. Validates the admission-incremented input
 * generation, the answered request id and the 24-hour expiry; the stored
 * request hash stays correlation evidence (the continuation payload has no
 * hash field).
 */
export async function consumeInputContinuation(
  client: Queryable,
  input: {
    agentIdentity: string;
    taskId: string;
    inputGeneration: number;
    answerRequestId: string;
  },
): Promise<ConsumeInputContinuationResult> {
  const result = await client.query<{ expires_at: Date | null }>(
    `UPDATE odft_app.protocol_task_control
        SET input_request_id = NULL,
            input_request_hash = NULL,
            input_expires_at = NULL,
            updated_at = now()
      WHERE agent_identity = $1 AND task_id = $2
        AND input_generation = $3
        AND input_request_id = $4
        AND input_expires_at IS NOT NULL
        AND input_expires_at > now()
      RETURNING input_expires_at AS expires_at`,
    [input.agentIdentity, input.taskId, input.inputGeneration, input.answerRequestId],
  );
  if (result.rowCount === 1) {
    return { ok: true, code: null, reason: null };
  }
  // Distinguish an expired pending request from a stale/unknown continuation so
  // callers can report the plan's INPUT_EXPIRED category.
  const pending = await client.query<{ expired: boolean; holds_request: boolean }>(
    `SELECT
        (input_expires_at IS NOT NULL AND input_expires_at <= now()) AS expired,
        (input_request_id IS NOT NULL) AS holds_request
       FROM odft_app.protocol_task_control
      WHERE agent_identity = $1 AND task_id = $2`,
    [input.agentIdentity, input.taskId],
  );
  const row = pending.rows[0];
  if (row?.expired) {
    return { ok: false, code: "INPUT_EXPIRED", reason: "the specialist question has expired" };
  }
  return {
    ok: false,
    code: "STALE_AGENT_RESULT",
    reason: row?.holds_request
      ? "the continuation does not match the pending question"
      : "no pending question accepts this continuation",
  };
}

/**
 * Reconcile tasks left `submitted`/`working` by a stopped process: they are
 * finalized as explicit restart failures before a duplicate may be admitted.
 */
export async function markRestartedTasksFailed(
  client: Queryable,
  agentIdentity: string,
): Promise<string[]> {
  const result = await client.query<{ task_id: string }>(
    `UPDATE odft_app.protocol_task_control
        SET state = 'failed', restart_failed_at = now(), active_owner = NULL, updated_at = now()
      WHERE agent_identity = $1 AND state IN ('submitted','working') AND restart_failed_at IS NULL
      RETURNING task_id`,
    [agentIdentity],
  );
  return result.rows.map((row) => row.task_id);
}

/* ---- Validated output cache ------------------------------------------------------ */

export async function saveValidatedOutput(
  client: Queryable,
  input: {
    agentIdentity: string;
    taskId: string;
    artifactKind: string;
    payloadHash: string;
    payload: unknown;
    accepted: boolean;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO odft_app.protocol_validated_outputs
       (id, agent_identity, task_id, artifact_kind, payload_hash, payload, accepted)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (agent_identity, task_id, artifact_kind, payload_hash) DO NOTHING`,
    [
      randomUUID(),
      input.agentIdentity,
      input.taskId,
      input.artifactKind,
      input.payloadHash,
      JSON.stringify(input.payload),
      input.accepted,
    ],
  );
}

export async function loadValidatedOutput(
  client: Queryable,
  input: { agentIdentity: string; taskId: string; artifactKind: string },
): Promise<{ payload: unknown; payloadHash: string; accepted: boolean } | undefined> {
  const result = await client.query<{ payload: unknown; payload_hash: string; accepted: boolean }>(
    `SELECT payload, payload_hash, accepted FROM odft_app.protocol_validated_outputs
      WHERE agent_identity = $1 AND task_id = $2 AND artifact_kind = $3
      ORDER BY validated_at DESC LIMIT 1`,
    [input.agentIdentity, input.taskId, input.artifactKind],
  );
  const row = result.rows[0];
  return row
    ? { payload: row.payload, payloadHash: row.payload_hash, accepted: row.accepted }
    : undefined;
}
