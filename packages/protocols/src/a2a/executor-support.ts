import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { Role, TaskState, type Artifact, type Message, type Part, type Task } from "@a2a-js/sdk";
import type { ExecutionEventBus } from "@a2a-js/sdk/server";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { getTaskControl } from "@odft/persistence";
import type { DurableMessageAdmission } from "./message-admission.js";
import {
  assertAllowance,
  countMcpInvocation,
  loadTaskAllowance,
  TaskLimitError,
  type TaskAllowanceState,
} from "./task-control.js";
import type { McpClient } from "../mcp/client.js";

/**
 * Phase 06 shared executor plumbing (plan §3.3/§3.9).
 *
 * Executors stay independent; only the protocol-facing mechanics live here:
 * SDK message/part building, safe failure codes, the active-time deadline with
 * cumulative allowance reloading, counted MCP calls, cancellation/input-required
 * publishing and settlement of the admission record.
 */

export function agentMessage(taskId: string, contextId: string, text: string): Message {
  return {
    messageId: randomUUID(),
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: [
      { content: { $case: "text", value: text }, mediaType: "text/plain", filename: "", metadata: {} },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

export function dataPart(value: unknown, mediaType: string): Part {
  return { content: { $case: "data", value }, mediaType, filename: "", metadata: {} };
}

export function dataPartOf(message: Message): unknown {
  for (const part of message.parts) {
    if (part.content?.$case === "data" && part.content.value !== undefined) {
      return part.content.value;
    }
  }
  return undefined;
}

/**
 * Safe failure category of any thrown error. Every domain-level error class
 * (authority, task limit, MCP client, delegated call, adapter) already carries
 * a bounded `code`; anything else is an internal error and never leaks a stack.
 */
export function safeFailureCode(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,40}$/.test(code)
    ? code
    : "INTERNAL_ERROR";
}

/** Terminal text is safe, bounded and free of credential-bearing URLs. */
export function safeFailureReason(reason: string): string {
  const cleaned = reason
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`]+/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned.length > 0 ? cleaned : "the task failed").slice(0, 300);
}

/**
 * Cumulative task clock: the active-execution deadline is derived from the
 * REMAINING allowance (continuations never reset it) and the allowance is
 * re-read before every guarded step so counters can never be exceeded by one.
 */
export interface TaskClock {
  readonly deadlineMs: number;
  allowance(): TaskAllowanceState;
  refresh(): Promise<TaskAllowanceState>;
  assertNow(need: { mcpInvocation?: boolean; llmAttempt?: boolean; input?: boolean }): void;
}

export async function createTaskClock(input: {
  pool: Pool;
  agentIdentity: string;
  taskId: string;
  skillId: string;
  startedAtMs: number;
}): Promise<TaskClock> {
  let current = await loadTaskAllowance(input.pool, {
    agentIdentity: input.agentIdentity,
    taskId: input.taskId,
    skillId: input.skillId,
  });
  const deadlineMs = input.startedAtMs + current.remainingActiveMs;
  const assertDeadline = (): void => {
    if (Date.now() > deadlineMs) {
      throw new TaskLimitError("the task active-execution allowance is exhausted");
    }
  };
  return {
    deadlineMs,
    allowance: () => current,
    async refresh() {
      current = await loadTaskAllowance(input.pool, {
        agentIdentity: input.agentIdentity,
        taskId: input.taskId,
        skillId: input.skillId,
      });
      return current;
    },
    assertNow(need) {
      assertDeadline();
      assertAllowance(current, { ...need, activeTime: true });
    },
  };
}

/**
 * One counted MCP call: refresh the allowance and assert BEFORE the call (the
 * cap can never be exceeded, even by concurrent callers on a stale snapshot),
 * perform it, count it (retries included), then refresh again.
 */
export async function countedToolCall(input: {
  mcp: McpClient;
  pool: Pool;
  agentIdentity: string;
  taskId: string;
  clock: TaskClock;
  service: string;
  name: string;
  arguments: Record<string, unknown>;
}): Promise<CallToolResult> {
  // Refresh immediately before the assert: concurrent callers must never pass
  // on a stale allowance snapshot, so the cap cannot be exceeded by one.
  await input.clock.refresh();
  input.clock.assertNow({ mcpInvocation: true });
  const result = await input.mcp.callTool(input.service, {
    name: input.name,
    arguments: input.arguments,
  });
  await countMcpInvocation(input.pool, { agentIdentity: input.agentIdentity, taskId: input.taskId });
  await input.clock.refresh();
  return result;
}

export interface TaskSession {
  /** NFKC-safe failure: FAILED status + safe code, admission settled. */
  publishFailure(code: string, reason: string): Promise<void>;
  /** Accepted cancellation: CANCELED status (no artifact), no settlement. */
  publishCancelled(): Promise<void>;
  /** Genuine question: input-request artifact + INPUT_REQUIRED + resting row. */
  publishInputRequired(request: unknown, mediaType: string): Promise<void>;
  publishStatus(state: TaskState, text?: string, metadata?: Record<string, unknown>): void;
  publishArtifact(artifact: Artifact): void;
  /** Local revocation check against the task-control row. */
  cancellationRequested(): Promise<boolean>;
}

export function createTaskSession(input: {
  pool: Pool;
  agentIdentity: string;
  eventBus: ExecutionEventBus;
  admission: DurableMessageAdmission;
  task: Task;
  messageId: string;
}): TaskSession {
  const { pool, agentIdentity, eventBus, task, messageId } = input;
  const publishStatus = (
    state: TaskState,
    text?: string,
    metadata?: Record<string, unknown>,
  ): void => {
    eventBus.publish({
      kind: "statusUpdate",
      data: {
        taskId: task.id,
        contextId: task.contextId,
        status: {
          state,
          message: text ? agentMessage(task.id, task.contextId, text) : undefined,
          timestamp: new Date().toISOString(),
        },
        metadata,
      },
    });
  };
  return {
    publishStatus,
    publishArtifact(artifact) {
      eventBus.publish({
        kind: "artifactUpdate",
        data: {
          taskId: task.id,
          contextId: task.contextId,
          artifact,
          append: false,
          lastChunk: true,
          metadata: undefined,
        },
      });
    },
    async publishFailure(code, reason) {
      // Settle the admission record BEFORE the terminal status is published: a
      // caller that observes FAILED (streaming or not) can always read the
      // settled row immediately.
      await input.admission.markSettled({ messageId, taskId: task.id, state: "failed" });
      // The safe application code is part of the terminal text: the coordinator
      // maps it to its own error category (AGENT_RESTARTED, MCP_UNAVAILABLE, …)
      // without reading SDK internals or provider stacks.
      publishStatus(TaskState.TASK_STATE_FAILED, `${code}: ${safeFailureReason(reason)}`, {
        failureCode: code,
      });
      eventBus.finished();
    },
    async publishCancelled() {
      publishStatus(TaskState.TASK_STATE_CANCELED);
      eventBus.finished();
    },
    async publishInputRequired(request, mediaType) {
      // The pending question itself is persisted by the caller; settle the
      // resting row BEFORE the status is observable so an immediately arriving
      // continuation can never race the settling write.
      await input.admission.markSettled({ messageId, taskId: task.id, state: "input_required" });
      eventBus.publish({
        kind: "artifactUpdate",
        data: {
          taskId: task.id,
          contextId: task.contextId,
          artifact: {
            artifactId: randomUUID(),
            name: "agent-input-request",
            description: "A genuine missing preference of the delegated task",
            parts: [dataPart(request, mediaType)],
            metadata: undefined,
            extensions: [],
          },
          append: false,
          lastChunk: true,
          metadata: undefined,
        },
      });
      publishStatus(TaskState.TASK_STATE_INPUT_REQUIRED);
      eventBus.finished();
    },
    async cancellationRequested() {
      const control = await getTaskControl(pool, { agentIdentity, taskId: task.id });
      return Boolean(control?.cancelRequestedAt) || control?.state === "cancelled";
    },
  };
}
