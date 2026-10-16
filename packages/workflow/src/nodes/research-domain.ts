import { researchRunKey } from "@odft/contracts";
import { researchDomainTaskSchema, type ResearchDomainResult } from "../state/research-reducer.js";
import type { TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/**
 * Phase 09 research task (03 section 4): one `Send` task, one domain.
 *
 * The task validates the refs, runs the single provider call plus its
 * idempotent artifact write, and merges exactly its own keyed tagged result.
 * Known provider failures are values; only unexpected errors abort the
 * superstep. There is no interrupt and no LLM call in this node.
 *
 * Idempotency comes from the writes, not from a task-level transaction (03
 * section 4): the provider is deterministic for `(snapshot, overlay, attempt)`
 * and the artifact row id is derived from the input fingerprint, so a
 * commit-before-checkpoint replay recomputes the same tagged result and upserts
 * the same artifact. Each task holds at most one pooled connection at a time,
 * so six parallel tasks cannot deadlock a small pool.
 */
export async function researchDomainNode(
  rawInput: unknown,
  runtime: unknown,
): Promise<TravelUpdate> {
  const task = researchDomainTaskSchema.parse(rawInput);
  const ports = travelPorts(runtime);
  const startedAt = ports.now().getTime();
  await ports.recordResearchEvent({
    tripId: task.tripId,
    operationId: task.operationId,
    domain: task.domain,
    phase: "started",
    attempt: task.attempt,
    durationMs: null,
    status: null,
    simulatedFailure: false,
    reason: null,
    fingerprint: null,
  });

  const outcome = await ports.researchDomain({
    tripId: task.tripId,
    operationId: task.operationId,
    domain: task.domain,
    attempt: task.attempt,
    inputFingerprint: task.inputFingerprint,
    searchIntent: task.searchIntent ?? null,
  });

  await ports.recordResearchEvent({
    tripId: task.tripId,
    operationId: task.operationId,
    domain: task.domain,
    phase: "finished",
    attempt: outcome.attempt,
    durationMs: Math.max(0, ports.now().getTime() - startedAt),
    status: outcome.status,
    simulatedFailure: outcome.simulatedFailure,
    reason: outcome.reason,
    fingerprint: task.inputFingerprint,
  });

  const result: ResearchDomainResult = {
    domain: outcome.domain,
    status: outcome.status,
    fingerprint: task.inputFingerprint,
    artifactId: outcome.artifactId,
    attempt: outcome.attempt,
    simulatedFailure: outcome.simulatedFailure,
    reason: outcome.reason,
    offerIds: outcome.offerIds,
  };
  return {
    researchResults: { [researchRunKey(task.researchRunId, task.domain)]: result },
  };
}