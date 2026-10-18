import { randomUUID } from "node:crypto";
import type { RequestHandler, Response } from "express";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { Task as ProtoTask, Role, TaskState, type Message, type Task } from "@a2a-js/sdk";
import { authenticateServiceRequest, type ServiceIdentity } from "../auth.js";
import { canonicalHash } from "../canonical-json.js";
import type { ProtocolConfig } from "../config.js";
import { buildObservation, type ProtocolTelemetryWriter } from "../telemetry.js";
import { ServiceInstanceLock } from "../service-lock.js";
import { createTransactionalTaskStore, type AgentTaskTable } from "./task-store.js";

/**
 * Phase 03 durable inbound admission (plan §3.7).
 *
 * The official `DefaultRequestHandler` persists a NEW task only when the
 * executor publishes its first event — a crash before that leaves no durable
 * task. This layer closes the window without changing protocol semantics:
 *
 * 1. ONE transaction claims `(agentIdentity, messageId)` in
 *    `odft_app.protocol_inbound_messages` (payload hash checked),
 * 2. for a NEW message it writes the canonical SDK task through the OFFICIAL
 *    `DatabaseTaskStore` constructed on the same transaction and records the
 *    message→task mapping (a continuation instead keeps the EXISTING task
 *    untouched — history, artifacts and terminal-state guards stay the SDK's),
 * 3. commits BEFORE the request handler runs; for a new message the handler
 *    then continues on the canonical task (the message carries its task id).
 *
 * A duplicate with the same payload hash is a replay: the persisted canonical
 * task is returned and no new work starts. A duplicate with a different hash is
 * a safe conflict. Only messages the served binding will actually process are
 * claimed, and reconciliation (guarded by the single-instance service lock)
 * marks tasks a stopped process left active as explicit restart failures before
 * any duplicate may be admitted.
 */

/** The single A2A protocol version this server serves (card `protocolVersion`). */
export const DECLARED_PROTOCOL_VERSION = "1.0";

export class MessageConflictError extends Error {
  readonly code = "CONFLICT" as const;
  constructor(messageId: string) {
    super(`message ${messageId} was already admitted with a different payload`);
    this.name = "MessageConflictError";
  }
}

export class UnknownTaskError extends Error {
  readonly code = "NOT_FOUND" as const;
  constructor(taskId: string) {
    super(`task ${taskId} is unknown`);
    this.name = "UnknownTaskError";
  }
}

export type AdmissionResult =
  | {
      readonly kind: "admitted";
      readonly taskId: string;
      readonly contextId: string;
    }
  | {
      readonly kind: "continuation";
      readonly taskId: string;
      readonly contextId: string;
    }
  | {
      readonly kind: "replay";
      readonly taskId: string;
      readonly contextId: string;
      readonly task?: Task;
    };

interface AdmissionRow {
  id: string;
  task_id: string | null;
  context_id: string | null;
  payload_hash: string;
  state: string;
}

export interface DurableAdmissionOptions {
  readonly agentIdentity: string;
  readonly taskTable: AgentTaskTable;
  /** Owner scope of the agent's task rows (the agent's own identity). */
  readonly owner?: string;
  /** Active-execution owner label persisted on the task-control row. */
  readonly activeOwner?: string;
}

export class DurableMessageAdmission {
  constructor(
    private readonly db: Kysely<unknown>,
    private readonly options: DurableAdmissionOptions,
  ) {}

  /** The agent identity this admission service serves (bearer-checked). */
  get agentIdentity(): string {
    return this.options.agentIdentity;
  }

  private get owner(): string {
    return this.options.owner ?? this.options.agentIdentity;
  }

  private get activeOwner(): string {
    return this.options.activeOwner ?? "service";
  }

  /** SDK store scope tenant of a task-control row (the request's tenant). */
  private tenantOf(context: ServerCallContext): string {
    return context.tenant ?? "";
  }

  private contextFor(agentIdentity: string, tenant: string): ServerCallContext {
    return new ServerCallContext({
      tenant,
      user: {
        get isAuthenticated(): boolean {
          return true;
        },
        get userName(): string {
          return agentIdentity;
        },
      },
    });
  }

  /**
   * Admit one inbound message. Returns the canonical task binding; the caller
   * (express middleware) then hands the request to the official handler on the
   * canonical task, or answers a replay.
   */
  async admit(
    message: Message,
    context: ServerCallContext,
  ): Promise<AdmissionResult> {
    if (!message.messageId) {
      throw new MessageConflictError("(missing messageId)");
    }
    const payloadHash = canonicalHash(message);
    const agentIdentity = this.options.agentIdentity;
    return this.db.transaction().execute(async (trx) => {
      const store = createTransactionalTaskStore(trx, {
        tableName: this.options.taskTable,
        owner: this.owner,
      });

      // Continuations bind an EXISTING canonical task. The task itself is never
      // rewritten here: the SDK loads it, appends the message and enforces the
      // terminal-state and context rules.
      if (message.taskId) {
        const existingTask = await store.load(message.taskId, context);
        if (!existingTask) {
          // No claim is written: the official handler answers TaskNotFound.
          throw new UnknownTaskError(message.taskId);
        }
      }

      // Claim the message id. `ON CONFLICT DO NOTHING` makes two concurrent
      // admissions of the same message resolve deterministically: the loser
      // re-reads the committed row instead of failing on a unique violation.
      const inserted = await sql<AdmissionRow>`
        INSERT INTO odft_app.protocol_inbound_messages
            (id, agent_identity, message_id, payload_hash, state)
        VALUES (${randomUUID()}, ${agentIdentity}, ${message.messageId}, ${payloadHash}, 'admitted')
        ON CONFLICT (agent_identity, message_id) DO NOTHING
        RETURNING id, task_id, context_id, payload_hash, state`.execute(trx);
      if (inserted.rows.length === 0) {
        const existing = await sql<AdmissionRow>`
          SELECT id, task_id, context_id, payload_hash, state
            FROM odft_app.protocol_inbound_messages
           WHERE agent_identity = ${agentIdentity} AND message_id = ${message.messageId}
           FOR UPDATE`.execute(trx);
        const row = existing.rows[0];
        if (!row || row.payload_hash !== payloadHash) {
          throw new MessageConflictError(message.messageId);
        }
        if (!row.task_id || !row.context_id) {
          throw new MessageConflictError(
            `${message.messageId} was admitted without a canonical task; retry after reconciliation`,
          );
        }
        const task = await store.load(row.task_id, context);
        return {
          kind: "replay",
          taskId: row.task_id,
          contextId: row.context_id,
          ...(task ? { task } : {}),
        };
      }

      if (message.taskId) {
        // Continuation: map the message, reopen the task-control row so a crash
        // mid-continuation is reconciled like any other active task.
        const contextId = message.contextId || (await store.load(message.taskId, context))?.contextId;
        if (!contextId) {
          throw new UnknownTaskError(message.taskId);
        }
        await sql`
          UPDATE odft_app.protocol_inbound_messages
             SET task_id = ${message.taskId}, context_id = ${contextId}, state = 'mapped', mapped_at = now()
           WHERE agent_identity = ${agentIdentity} AND message_id = ${message.messageId}`.execute(trx);
        await sql`
          INSERT INTO odft_app.protocol_task_control
              (agent_identity, task_id, context_id, tenant, state, active_owner, input_generation)
          VALUES (${agentIdentity}, ${message.taskId}, ${contextId}, ${this.tenantOf(context)},
                  'working', ${this.activeOwner}, 2)
          ON CONFLICT (agent_identity, task_id) DO UPDATE
             SET state = 'working',
                 tenant = EXCLUDED.tenant,
                 active_owner = EXCLUDED.active_owner,
                 input_generation = odft_app.protocol_task_control.input_generation + 1,
                 updated_at = now()`.execute(trx);
        return { kind: "continuation", taskId: message.taskId, contextId };
      }

      // New canonical task, committed with its mapping and control row before
      // any executor work can start.
      const taskId = randomUUID();
      const contextId = message.contextId ? message.contextId : randomUUID();
      const task: Task = {
        id: taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_SUBMITTED,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
        artifacts: [],
        // The handler appends the incoming message on the continuation path.
        history: [],
        metadata: {},
      };
      await store.save(task, context);
      await sql`
        UPDATE odft_app.protocol_inbound_messages
           SET task_id = ${taskId}, context_id = ${contextId}, state = 'mapped', mapped_at = now()
         WHERE agent_identity = ${agentIdentity} AND message_id = ${message.messageId}`.execute(trx);
      await sql`
        INSERT INTO odft_app.protocol_task_control
            (agent_identity, task_id, context_id, tenant, state, active_owner)
        VALUES (${agentIdentity}, ${taskId}, ${contextId}, ${this.tenantOf(context)},
                'submitted', ${this.activeOwner})
        ON CONFLICT (agent_identity, task_id) DO NOTHING`.execute(trx);
      return { kind: "admitted", taskId, contextId };
    });
  }

  /** Mark a canonical task as actively executing (before any work). */
  async markWorking(taskId: string): Promise<void> {
    await sql`
      UPDATE odft_app.protocol_task_control
         SET state = 'working', active_owner = ${this.activeOwner}, updated_at = now()
       WHERE agent_identity = ${this.options.agentIdentity} AND task_id = ${taskId}
         AND state IN ('submitted','working')`.execute(this.db);
  }

  /**
   * Finalize the admission record and the task-control row after settlement.
   * `input_required` is a resting state (waiting for the traveler's answer) and
   * is never reconciled into a failure.
   */
  async markSettled(input: {
    messageId: string;
    taskId: string;
    state: "completed" | "failed" | "input_required";
  }): Promise<void> {
    await sql`
      UPDATE odft_app.protocol_inbound_messages
         SET state = ${input.state === "input_required" ? "mapped" : input.state}
       WHERE agent_identity = ${this.options.agentIdentity} AND message_id = ${input.messageId}
         AND state IN ('admitted','mapped')`.execute(this.db);
    await sql`
      UPDATE odft_app.protocol_task_control
         SET state = ${input.state}, active_owner = NULL, updated_at = now()
       WHERE agent_identity = ${this.options.agentIdentity} AND task_id = ${input.taskId}
         AND state IN ('submitted','working')`.execute(this.db);
  }

  /**
   * Restart reconciliation: tasks a stopped process left `submitted`/`working`
   * become explicit `FAILED`/AGENT_RESTARTED results (both the SDK task row and
   * the control row) before any duplicate may be admitted. A task the SDK
   * already settled keeps its state; only the control row is synced. Requires
   * the single-instance service lock, so a second live process can never fail
   * the tasks of a running one.
   */
  async reconcileRestartedTasks(lock: ServiceInstanceLock): Promise<string[]> {
    if (lock.agentIdentity !== this.options.agentIdentity) {
      throw new Error(
        `service lock for ${lock.agentIdentity} cannot reconcile ${this.options.agentIdentity}`,
      );
    }
    return this.db.transaction().execute(async (trx) => {
      const rows = await sql<{ task_id: string; tenant: string }>`
        SELECT task_id, tenant
          FROM odft_app.protocol_task_control
         WHERE agent_identity = ${this.options.agentIdentity}
           AND state IN ('submitted','working') AND restart_failed_at IS NULL
         FOR UPDATE`.execute(trx);
      if (rows.rows.length === 0) {
        return [];
      }
      const store = createTransactionalTaskStore(trx, {
        tableName: this.options.taskTable,
        owner: this.owner,
      });
      const failed: string[] = [];
      for (const row of rows.rows) {
        const context = this.contextFor(this.options.agentIdentity, row.tenant);
        const task = await store.load(row.task_id, context);
        const active =
          !task ||
          task.status?.state === TaskState.TASK_STATE_SUBMITTED ||
          task.status?.state === TaskState.TASK_STATE_WORKING;
        if (active) {
          if (task) {
            await store.save(
              {
                ...task,
                status: {
                  state: TaskState.TASK_STATE_FAILED,
                  message: {
                    messageId: randomUUID(),
                    contextId: task.contextId,
                    taskId: task.id,
                    role: Role.ROLE_AGENT,
                    parts: [
                      {
                        content: {
                          $case: "text",
                          value:
                            "AGENT_RESTARTED: the service restarted before the task finished; interrupted computation is not resumed",
                        },
                        mediaType: "text/plain",
                        filename: "",
                        metadata: {},
                      },
                    ],
                    metadata: undefined,
                    extensions: [],
                    referenceTaskIds: [],
                  },
                  timestamp: new Date().toISOString(),
                },
              },
              context,
            );
          }
          await sql`
            UPDATE odft_app.protocol_task_control
               SET state = 'failed', restart_failed_at = now(), active_owner = NULL, updated_at = now()
             WHERE agent_identity = ${this.options.agentIdentity} AND task_id = ${row.task_id}`.execute(trx);
          failed.push(row.task_id);
          continue;
        }
        // The SDK task is already settled: only sync the control row.
        const synced =
          task.status?.state === TaskState.TASK_STATE_COMPLETED
            ? "completed"
            : task.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED
              ? "input_required"
              : task.status?.state === TaskState.TASK_STATE_CANCELED
                ? "cancelled"
                : "failed";
        await sql`
          UPDATE odft_app.protocol_task_control
             SET state = ${synced}, active_owner = NULL, updated_at = now()
           WHERE agent_identity = ${this.options.agentIdentity} AND task_id = ${row.task_id}`.execute(trx);
      }
      return failed;
    });
  }
}

/* ---- Express middleware ------------------------------------------------------- */

interface ModernJsonRpcBody {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: { message?: Message; tenant?: string } | undefined;
}

interface AdmissibleRequest {
  readonly message: Message;
  readonly stream: boolean;
  readonly tenant: string;
  readonly requestId: unknown;
}

function hasMessageId(message: unknown): message is Message {
  return (
    message !== null &&
    typeof message === "object" &&
    typeof (message as Message).messageId === "string" &&
    (message as Message).messageId.length > 0
  );
}

/**
 * Recognize the ONE binding this server actually serves: the modern 1.0
 * JSON-RPC methods `SendMessage` / `SendStreamingMessage` with an explicit 1.x
 * `A2A-Version` header. Requests for bindings we do not mount (the HTTP+JSON
 * `/v1/...` routes of the SDK's `restHandler`, legacy 0.3 JSON-RPC while
 * `legacyCompat` stays disabled) are never claimed: they fall through to the
 * official rejection, so a rejected request cannot poison the dedupe table.
 */
function admissibleRequest(request: {
  headers: Record<string, unknown>;
  body: unknown;
}): AdmissibleRequest | undefined {
  const body = request.body;
  if (body === null || typeof body !== "object") {
    return undefined;
  }
  const candidate = body as ModernJsonRpcBody;
  const versionHeader = request.headers["a2a-version"];
  const version = typeof versionHeader === "string" ? versionHeader : "";
  // Exactly the version this server declares on its card; anything else is
  // rejected by the official handler and must not be claimed.
  if (version !== DECLARED_PROTOCOL_VERSION || candidate.jsonrpc !== "2.0") {
    return undefined;
  }
  if (candidate.method !== "SendMessage" && candidate.method !== "SendStreamingMessage") {
    return undefined;
  }
  if (!hasMessageId(candidate.params?.message)) {
    return undefined;
  }
  return {
    message: candidate.params.message,
    stream: candidate.method === "SendStreamingMessage",
    tenant: typeof candidate.params?.tenant === "string" ? candidate.params.tenant : "",
    requestId: candidate.id ?? null,
  };
}

/** Safe error response of the served binding (modern JSON-RPC). */
function respondError(
  response: Response,
  requestId: unknown,
  status: number,
  message: string,
): void {
  response.status(status).json({ jsonrpc: "2.0", id: requestId, error: { code: -32602, message } });
}

/**
 * Admission middleware: authenticate, then claim the message and commit the
 * canonical task BEFORE the official handler runs. New messages get their
 * `taskId` rewritten to the canonical id (official continuation path);
 * continuations keep theirs; replays and conflicts are answered without
 * touching the executor.
 */
export function createAdmissionMiddleware(deps: {
  readonly config: ProtocolConfig;
  readonly admission: DurableMessageAdmission;
  readonly telemetry?: ProtocolTelemetryWriter;
}): RequestHandler {
  return async (request, response, next) => {
    const admissible = admissibleRequest({
      headers: request.headers as Record<string, unknown>,
      body: request.body,
    });
    if (!admissible) {
      next();
      return;
    }
    const { message, stream, tenant, requestId } = admissible;
    let identity: ServiceIdentity;
    try {
      // The raw Authorization header: the helper parses the bearer itself.
      identity = authenticateServiceRequest(deps.config, request.headers.authorization);
    } catch {
      respondError(response, requestId, 401, "unauthorized");
      return;
    }
    if (identity.agentIdentity !== deps.admission.agentIdentity) {
      respondError(response, requestId, 403, "forbidden");
      return;
    }
    let outcome: AdmissionResult;
    try {
      outcome = await deps.admission.admit(
        message,
        new ServerCallContext({
          tenant,
          user: {
            get isAuthenticated(): boolean {
              return true;
            },
            get userName(): string {
              return identity.agentIdentity;
            },
          },
        }),
      );
    } catch (error) {
      if (error instanceof UnknownTaskError) {
        // Let the official handler answer TaskNotFound for the named task.
        next();
        return;
      }
      if (error instanceof MessageConflictError) {
        respondError(response, requestId, 409, error.message);
        return;
      }
      respondError(response, requestId, 500, "admission failed");
      return;
    }
    await deps.telemetry?.record(
      buildObservation({
        source: "coordinator",
        kind: "task_accepted",
        correlation: { taskId: outcome.taskId, contextId: outcome.contextId },
        payload: {
          detail:
            outcome.kind === "replay" ? "duplicate message reused the canonical task" : null,
          status: outcome.kind,
          counters: {},
        },
      }),
    );
    if (outcome.kind === "replay") {
      // The persisted canonical task is the answer; no work starts. Encoding
      // uses the official proto JSON serializer, so the wire shape is the
      // SDK's own.
      const encoded = outcome.task
        ? ProtoTask.toJSON(outcome.task as never)
        : { id: outcome.taskId, contextId: outcome.contextId };
      if (stream) {
        response.status(200).set({
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        // Streaming frames are JSON-RPC responses around each StreamResponse.
        response.write(
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: requestId, result: { task: encoded } })}\n\n`,
        );
        response.end();
        return;
      }
      response.status(200).json({ jsonrpc: "2.0", id: requestId, result: { task: encoded } });
      return;
    }
    if (outcome.kind === "admitted") {
      // Hand the request to the official handler on the canonical task.
      message.taskId = outcome.taskId;
      if (!message.contextId) {
        message.contextId = outcome.contextId;
      }
    }
    next();
  };
}
