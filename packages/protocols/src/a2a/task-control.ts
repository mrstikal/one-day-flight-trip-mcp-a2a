import type { Pool } from "pg";
import { addTaskCounters, getTaskControl, type TaskControlRecord } from "@odft/persistence";

/**
 * Phase 05 cumulative task limits (plan §3.9).
 *
 * Counters live on `protocol_task_control` and are cumulative for the canonical
 * task, including input-required continuations: a continuation gets only the
 * remaining allowance. Human waiting is excluded from active execution time
 * (callers accrue active time around actual work only).
 */

export interface TaskLimits {
  /** Maximum active execution time (ms), human waiting excluded. */
  readonly activeTimeMs: number;
  /** MCP invocations including retries. */
  readonly mcpInvocations: number;
  /** LLM transport attempts (each attempt is a separate reservation). */
  readonly llmAttempts: number;
  /** Maximum reserved+actual task USD. */
  readonly maxTaskCostUsd: number;
  /** Input requests per task (plan §3.9: two). */
  readonly maxInputs: number;
}

/** Per-skill task allowances of the plan's §3.9 table (Phase 05: flight only). */
export const TASK_LIMITS: Readonly<Record<string, TaskLimits>> = {
  "flight.recommend.v1": {
    activeTimeMs: 60_000,
    mcpInvocations: 4,
    llmAttempts: 2,
    maxTaskCostUsd: 0.1,
    maxInputs: 2,
  },
};

export class TaskLimitError extends Error {
  readonly code = "TASK_BUDGET_EXCEEDED" as const;
  constructor(message: string) {
    super(message);
    this.name = "TaskLimitError";
  }
}

export interface TaskAllowanceState {
  readonly control: TaskControlRecord;
  readonly limits: TaskLimits;
  readonly spentUsd: number;
  readonly remainingUsd: number;
  readonly remainingMcp: number;
  readonly remainingLlm: number;
  readonly remainingActiveMs: number;
  readonly remainingInputs: number;
}

export function limitsForSkill(skillId: string): TaskLimits {
  const limits = TASK_LIMITS[skillId];
  if (!limits) {
    throw new TaskLimitError(`no task limits configured for skill ${skillId}`);
  }
  return limits;
}

export async function loadTaskAllowance(
  pool: Pool,
  input: { agentIdentity: string; taskId: string; skillId: string },
): Promise<TaskAllowanceState> {
  const control = await getTaskControl(pool, {
    agentIdentity: input.agentIdentity,
    taskId: input.taskId,
  });
  if (!control) {
    throw new TaskLimitError(`task-control row missing for task ${input.taskId}`);
  }
  const limits = limitsForSkill(input.skillId);
  const spentUsd = control.reservedCostUsd + control.actualCostUsd;
  return {
    control,
    limits,
    spentUsd,
    remainingUsd: Math.max(0, limits.maxTaskCostUsd - spentUsd),
    remainingMcp: Math.max(0, limits.mcpInvocations - control.mcpInvocations),
    remainingLlm: Math.max(0, limits.llmAttempts - control.llmAttempts),
    remainingActiveMs: Math.max(0, limits.activeTimeMs - control.activeTimeMs),
    remainingInputs: Math.max(0, limits.maxInputs - control.inputCount),
  };
}

/** Refuse work that would exceed the task allowance BEFORE doing it. */
export function assertAllowance(state: TaskAllowanceState, need: {
  readonly mcpInvocation?: boolean;
  readonly llmAttempt?: boolean;
  readonly input?: boolean;
  readonly activeTime?: boolean;
}): void {
  if (need.activeTime && state.remainingActiveMs <= 0) {
    throw new TaskLimitError("the task active-execution allowance is exhausted");
  }
  if (need.mcpInvocation && state.remainingMcp <= 0) {
    throw new TaskLimitError("the task MCP invocation allowance is exhausted");
  }
  if (need.llmAttempt && state.remainingLlm <= 0) {
    throw new TaskLimitError("the task LLM attempt allowance is exhausted");
  }
  if (need.input && state.remainingInputs <= 0) {
    throw new TaskLimitError("the task input request allowance is exhausted");
  }
}

/** Count one MCP invocation (retries included) against the task allowance. */
export async function countMcpInvocation(
  pool: Pool,
  input: { agentIdentity: string; taskId: string },
): Promise<void> {
  await addTaskCounters(pool, {
    agentIdentity: input.agentIdentity,
    taskId: input.taskId,
    mcpInvocations: 1,
  });
}

/** Accrue active execution time (never human waiting) on the task counters. */
export async function accrueActiveTime(
  pool: Pool,
  input: { agentIdentity: string; taskId: string; startedAtMs: number; nowMs?: number },
): Promise<void> {
  const elapsed = Math.max(0, (input.nowMs ?? Date.now()) - input.startedAtMs);
  if (elapsed === 0) {
    return;
  }
  await addTaskCounters(pool, {
    agentIdentity: input.agentIdentity,
    taskId: input.taskId,
    activeTimeMs: elapsed,
  });
}

/** Count one input request (capped at the plan's two per task). */
export async function countInputRequest(
  pool: Pool,
  input: { agentIdentity: string; taskId: string },
): Promise<void> {
  await addTaskCounters(pool, {
    agentIdentity: input.agentIdentity,
    taskId: input.taskId,
    inputCount: 1,
  });
}
