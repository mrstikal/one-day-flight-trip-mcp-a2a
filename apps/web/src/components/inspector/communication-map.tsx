"use client";

import type { PublicInspectorCommunication } from "@odft/contracts";

/**
 * Phase 09 communication map (ODTF_PLAN.md §3.15).
 *
 * One row per persisted delegation: agent identity, skill, task/delegation
 * lifecycle states, safe failure category, and the remote-cancel outcome. Only
 * persisted rows render — never a static graph topology. A legend explains the
 * A2A edge (this table) versus the MCP and application edges in the timeline.
 */

const CANCEL_LABELS: Readonly<Record<string, string>> = {
  pending: "cancel pending",
  acknowledged: "cancel acknowledged",
  failed: "cancel failed",
};

export function CommunicationMap({
  communications,
}: {
  readonly communications: readonly PublicInspectorCommunication[];
}): React.JSX.Element {
  return (
    <section aria-label="Communication map">
      <h2 className="text-base font-semibold">Communication map</h2>
      <p className="mt-1 text-xs text-ink-muted" data-testid="communication-legend">
        Every row is a persisted agent communication (A2A edge). MCP tool and resource calls live in
        the MCP section below; coordinator decisions live in the application timeline. No prompts,
        payloads, tokens, or endpoints are shown.
      </p>
      {communications.length === 0 ? (
        <p className="mt-1 text-sm text-ink-muted" data-testid="no-communications">
          No agent communications have been persisted for this trip yet.
        </p>
      ) : (
        <table
          className="mt-2 w-full border-collapse text-left text-xs"
          data-testid="communication-table"
        >
          <thead>
            <tr className="border-b border-border text-ink-muted">
              <th className="py-1 pr-3">Edge</th>
              <th className="py-1 pr-3">Agent</th>
              <th className="py-1 pr-3">Skill</th>
              <th className="py-1 pr-3">Task state</th>
              <th className="py-1 pr-3">Delegation</th>
              <th className="py-1 pr-3">Failure</th>
              <th className="py-1 pr-3">Duration</th>
              <th className="py-1 pr-3">Attempt</th>
              <th className="py-1 pr-3">Cancel</th>
              <th className="py-1">Updated</th>
            </tr>
          </thead>
          <tbody>
            {communications.map((row, index) => (
              <tr
                key={`${row.delegationId ?? row.agentIdentity}-${index}`}
                className="border-b border-border/50"
              >
                <td className="py-1 pr-3 font-mono">a2a</td>
                <td className="py-1 pr-3 font-mono">{row.agentIdentity}</td>
                <td className="py-1 pr-3">{row.skillId ?? "—"}</td>
                <td className="py-1 pr-3">{row.taskState ?? "—"}</td>
                <td className="py-1 pr-3">{row.delegationStatus ?? "—"}</td>
                <td className="py-1 pr-3">{row.failureCategory ?? "—"}</td>
                <td className="py-1 pr-3">
                  {row.durationMs !== null ? `${row.durationMs} ms` : "—"}
                </td>
                <td className="py-1 pr-3">{row.attempt ?? "—"}</td>
                <td className="py-1 pr-3">
                  {row.cancellationState
                    ? (CANCEL_LABELS[row.cancellationState] ?? row.cancellationState)
                    : "—"}
                </td>
                <td className="py-1">{row.updatedAt.replace("T", " ").replace("Z", "Z")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
