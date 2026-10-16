import { z } from "zod";
import {
  researchDomainTaskSchema,
  type HarnessDomainResult,
  type ResearchDomainTask,
} from "./state.js";

/**
 * Test-only domain research task. It calls no LLM/provider: it runs one
 * idempotent effect through the persistence effect ledger (via {@link HarnessPorts})
 * so replay after a commit-before-checkpoint crash returns the stored result.
 */

/**
 * Server-side dependencies passed through the non-checkpointed invocation
 * `context`. Never persisted, never a security boundary.
 */
export interface HarnessPorts {
  runEffect<T>(nodeName: string, effectScope: string, fn: () => Promise<T>): Promise<T>;
  now(): Date;
}

export interface HarnessContext {
  readonly operationId: string;
  readonly ports: HarnessPorts;
}

interface SendTaskInput extends ResearchDomainTask {
  readonly effectAttempt?: number;
}

const sendInputSchema = researchDomainTaskSchema.extend({
  effectAttempt: z.number().int().min(1).optional(),
});

/**
 * Deterministic `research_domain` node reached through `Send(...)`. It receives
 * the send payload as its state and writes only its own keyed result.
 */
export async function researchDomainNode(
  rawInput: unknown,
  runtime: unknown,
): Promise<{ researchResults: Record<string, HarnessDomainResult> }> {
  const task = sendInputSchema.parse(rawInput) as SendTaskInput;
  const ports = (runtime as { context?: HarnessContext }).context?.ports;
  if (!ports) {
    throw new Error("research_domain requires HarnessPorts in the invocation context");
  }
  const key = `${task.researchRunId}:${task.domain}`;
  const result = await ports.runEffect<HarnessDomainResult>(
    "research_domain",
    key,
    async () => ({
      domain: task.domain,
      status: "ok",
      fingerprint: `${task.operationId}:${key}`,
      attempts: task.effectAttempt ?? 1,
    }),
  );
  return { researchResults: { [key]: result } };
}
