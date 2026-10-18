"use client";

import type { PublicInspectorCommunication } from "@odft/contracts";

/**
 * Phase 09 agent card (ODTF_PLAN.md §3.15).
 *
 * A per-agent summary card rendered from the SAME persisted rows as the
 * communication map — identity, skill, lifecycle states, and cancel outcome.
 * Never an endpoint URL, credential, or live task handle.
 */
export function AgentCard({
  communication,
}: {
  readonly communication: PublicInspectorCommunication;
}): React.JSX.Element {
  return (
    <article
      className="rounded border border-border bg-paper px-3 py-2 text-xs"
      data-testid={`agent-card-${communication.agentIdentity}`}
    >
      <h3 className="font-mono font-semibold">{communication.agentIdentity}</h3>
      <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-ink-muted">
        <dt>Skill</dt>
        <dd className="text-right text-ink">{communication.skillId ?? "—"}</dd>
        <dt>Task</dt>
        <dd className="text-right text-ink">{communication.taskState ?? "—"}</dd>
        <dt>Delegation</dt>
        <dd className="text-right text-ink">{communication.delegationStatus ?? "—"}</dd>
        <dt>Cancel</dt>
        <dd className="text-right text-ink">{communication.cancellationState ?? "—"}</dd>
        <dt>Duration</dt>
        <dd className="text-right text-ink">
          {communication.durationMs !== null ? `${communication.durationMs} ms` : "—"}
        </dd>
        <dt>Attempt</dt>
        <dd className="text-right text-ink">{communication.attempt ?? "—"}</dd>
      </dl>
      {communication.failureCategory ? (
        <p className="mt-1 text-clay">Failure: {communication.failureCategory}</p>
      ) : null}
    </article>
  );
}
