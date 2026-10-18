"use client";

import type { PublicInspectorMcpCall, PublicInspectorTimelineEvent } from "@odft/contracts";

/**
 * Phase 09 MCP section + application-protocol timeline (ODTF_PLAN.md §3.15).
 *
 * The MCP table renders one safe row per persisted discovery/invocation
 * observation (name, kind, outcome) — never arguments or results. The timeline
 * below merges bridged observations in chronological SOURCE order with a
 * per-row edge label (a2a/mcp/application) and a legend, so late observations
 * slot into the right position instead of appending at ingestion time.
 */

const MCP_KIND_LABELS: Readonly<Record<string, string>> = {
  tool_call: "tool call",
  resource_read: "resource read",
  connect: "connect",
  discovery: "discovery",
};

export function ProtocolTimeline({
  mcpCalls,
  timeline,
}: {
  readonly mcpCalls: readonly PublicInspectorMcpCall[];
  readonly timeline: readonly PublicInspectorTimelineEvent[];
}): React.JSX.Element {
  return (
    <>
      <section aria-label="MCP calls">
        <h2 className="text-base font-semibold">MCP calls</h2>
        <p className="mt-1 text-xs text-ink-muted">
          Safe discovery/invocation evidence only (MCP edge): tool or resource identity, kind, and
          outcome. Arguments and results are never stored.
        </p>
        {mcpCalls.length === 0 ? (
          <p className="mt-1 text-sm text-ink-muted" data-testid="no-mcp-calls">
            No MCP calls have been persisted for this trip yet.
          </p>
        ) : (
          <table className="mt-2 w-full border-collapse text-left text-xs" data-testid="mcp-table">
            <thead>
              <tr className="border-b border-border text-ink-muted">
                <th className="py-1 pr-3">Edge</th>
                <th className="py-1 pr-3">Name</th>
                <th className="py-1 pr-3">Kind</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1 pr-3">Failure</th>
                <th className="py-1">At</th>
              </tr>
            </thead>
            <tbody>
              {mcpCalls.map((call, index) => (
                <tr
                  key={`${call.name}-${call.occurredAt}-${index}`}
                  className="border-b border-border/50"
                >
                  <td className="py-1 pr-3 font-mono">mcp</td>
                  <td className="py-1 pr-3 font-mono">{call.name}</td>
                  <td className="py-1 pr-3">{MCP_KIND_LABELS[call.kind] ?? call.kind}</td>
                  <td className="py-1 pr-3">{call.status}</td>
                  <td className="py-1 pr-3">{call.failureCategory ?? "—"}</td>
                  <td className="py-1">{call.occurredAt.replace("T", " ").replace("Z", "Z")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-label="Protocol timeline">
        <h2 className="text-base font-semibold">Protocol timeline</h2>
        <p className="mt-1 text-xs text-ink-muted" data-testid="timeline-legend">
          Chronological source order across all edges: a2a (agent communications), mcp
          (tool/resource calls), application (coordinator observations). Late observations appear at
          their source time, not at ingestion time.
        </p>
        {timeline.length === 0 ? (
          <p className="mt-1 text-sm text-ink-muted" data-testid="no-timeline">
            No protocol observations have been bridged for this trip yet.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1 text-xs" data-testid="timeline-list">
            {timeline.map((event, index) => (
              <li
                key={`${event.kind}-${event.at}-${index}`}
                className="flex gap-2 border-b border-border/50 py-1"
              >
                <span className="font-mono text-ink-muted">{event.edge}</span>
                <span className="font-mono">{event.kind}</span>
                <span className="text-ink-muted">{event.source}</span>
                <span>{event.summary ?? ""}</span>
                <span className="ml-auto text-ink-muted">
                  {event.at.replace("T", " ").replace("Z", "Z")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
