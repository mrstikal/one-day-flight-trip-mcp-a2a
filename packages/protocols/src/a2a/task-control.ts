import type { Pool } from "pg";
import {
  addTaskCounters,
  consumeInputContinuation as consumeInputContinuationRow,
  getTaskControl,
  recordInputRequest as recordInputRequestRow,
  type ConsumeInputContinuationResult,
  type TaskControlRecord,
} from "@odft/persistence";

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

/** Per-skill task allowances of the plan's §3.9 table. */
export const TASK_LIMITS: Readonly<Record<string, TaskLimits>> = {
  "flight.recommend.v1": {
    activeTimeMs: 60_000,
    mcpInvocations: 4,
    llmAttempts: 2,
    maxTaskCostUsd: 0.1,
    maxInputs: 2,
  },
  "accommodation.recommend.v1": {
    activeTimeMs: 60_000,
    mcpInvocations: 4,
    llmAttempts: 2,
    maxTaskCostUsd: 0.1,
    maxInputs: 2,
  },
  "city-guide.research.v1": {
    activeTimeMs: 90_000,
    mcpInvocations: 8,
    llmAttempts: 2,
    maxTaskCostUsd: 0.1,
    maxInputs: 2,
  },
  /**
   * Phase 08: one application planning attempt. The planner role's ceiling is
   * 0.20 USD and the deterministic preflight is free, so 0.25 covers exactly
   * one paid planner send plus its reservation headroom.
   */
  "itinerary.propose.v1": {
    activeTimeMs: 120_000,
    mcpInvocations: 6,
    llmAttempts: 4,
    maxTaskCostUsd: 0.25,
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

/**
 * Phase 06: persist the pending question on the canonical task (plan §3.10).
 * The caller asserted the input allowance first; this also flips the row to
 * `input_required` and counts the request against the cumulative cap.
 */
export async function recordInputRequest(
  pool: Pool,
  input: {
    agentIdentity: string;
    taskId: string;
    requestId: string;
    requestHash: string;
    expiresAt: string;
  },
): Promise<void> {
  await recordInputRequestRow(pool, input);
}

/** Consume exactly one accepted continuation (generation + request + expiry). */
export async function consumeContinuation(
  pool: Pool,
  input: {
    agentIdentity: string;
    taskId: string;
    inputGeneration: number;
    answerRequestId: string;
  },
): Promise<ConsumeInputContinuationResult> {
  return consumeInputContinuationRow(pool, input);
}
