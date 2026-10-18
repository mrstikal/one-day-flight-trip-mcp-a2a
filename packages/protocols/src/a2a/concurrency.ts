import type { AgentExecutor } from "@a2a-js/sdk/server";

/**
 * Per-agent execution concurrency (plan §3.9): two running tasks with a bounded
 * queue. Saturation is rejected with a retryable safe failure instead of
 * unbounded in-process work.
 */
export class AgentSaturationError extends Error {
  readonly code = "AGENT_UNAVAILABLE" as const;

  constructor(message = "AGENT_UNAVAILABLE: the agent task queue is saturated") {
    super(message);
    this.name = "AgentSaturationError";
  }
}

export interface AgentConcurrencyOptions {
  readonly concurrency?: number;
  readonly queueLimit?: number;
}

export class AgentConcurrencyGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly concurrency: number;
  private readonly queueLimit: number;

  constructor(options: AgentConcurrencyOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.queueLimit = Math.max(0, options.queueLimit ?? 8);
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active < this.concurrency) {
      this.active += 1;
    } else if (this.waiting.length < this.queueLimit) {
      // The releasing task hands its slot directly to this waiter.
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    } else {
      throw new AgentSaturationError();
    }
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next();
      } else {
        this.active -= 1;
      }
    }
  }
}

/** Wrap an executor so only `execute` is gated; cancellation stays immediate. */
export function withAgentConcurrency(
  executor: AgentExecutor,
  gate: AgentConcurrencyGate,
  onSaturation?: (taskId: string) => Promise<void>,
): AgentExecutor {
  return {
    execute: async (requestContext, eventBus) => {
      try {
        return await gate.run(() => executor.execute(requestContext, eventBus));
      } catch (error) {
        // The executor body never ran, so its own failure bookkeeping did not
        // run either: settle the durable task-control row here.
        if (error instanceof AgentSaturationError && onSaturation) {
          await onSaturation(requestContext.taskId).catch(() => undefined);
        }
        throw error;
      }
    },
    cancelTask: (taskId, eventBus) => executor.cancelTask(taskId, eventBus),
  };
}
