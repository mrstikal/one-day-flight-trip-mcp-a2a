"use client";

import { useCallback } from "react";
import Link from "next/link";
import { useTripProjection } from "@/lib/use-trip-projection";
import { useTripEvents } from "@/lib/use-sse";
import { hasSavedProgram, nextTripStep } from "@/lib/trip-step";
import { ExecutionGraph } from "./execution-graph";
import { SimulationControls } from "./simulation-controls";

/**
 * Phase 11 execution inspector (08-frontend-ux.md section 10).
 *
 * Everything rendered here comes from the safe projection: the persisted graph
 * definition, real node/operation/checkpoint events, the LLM cost ledger, and
 * labeled fault rows. There are no prompts, no reasoning, no provider payloads,
 * no SQL, and no secrets — they were never stored. The inspector is read-only
 * apart from the flag/owner-protected scenario controls.
 */

const STATUS_STYLES: Readonly<Record<string, string>> = {
  pending: "bg-cream text-ink-muted",
  active: "bg-amber-100 text-amber-900",
  completed: "bg-teal-50 text-teal-900",
  interrupted: "bg-sky-100 text-sky-900",
  failed: "bg-red-100 text-red-900",
};

function StatusBadge({ status }: { readonly status: string }): React.JSX.Element {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] ${STATUS_STYLES[status] ?? ""}`}>
      {status}
    </span>
  );
}

function shortId(value: string): string {
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}

function formatTime(value: string): string {
  return value.replace("T", " ").replace("Z", "Z");
}

export function InspectorView({ tripId }: { readonly tripId: string }): React.JSX.Element {
  const { projection, error, refresh } = useTripProjection(tripId);
  const onEvent = useCallback(() => refresh(), [refresh]);
  useTripEvents(tripId, onEvent);
  const inspector = projection?.inspector ?? null;

  if (!projection) {
    return (
      <p role="status" className="text-sm text-ink-muted">
        {error
          ? `The inspector could not load: ${error.message}`
          : "Loading the execution inspector…"}
      </p>
    );
  }
  // "Back to the trip" points at the trip's current step, not a fixed page: the
  // itinerary is a dead end until a flight, hotel, and program are in place.
  const backHref =
    nextTripStep({
      tripId,
      reservations: projection.reservations,
      hasProgram: hasSavedProgram(projection.program),
      hasItinerary: projection.itinerary !== null,
      flightSelected: projection.selections.flights.offerId !== null,
      hotelSelected: projection.selections.hotel.offerId !== null,
      pendingDecisionKind: projection.pendingDecision?.kind ?? null,
      proposalServiceKey: projection.proposal?.serviceKey ?? null,
    })?.href ?? `/trips/${tripId}/itinerary`;
  if (!inspector) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="font-serif text-xl font-semibold">Execution inspector</h1>
        <p role="status" className="text-sm text-ink-muted" data-testid="inspector-disabled">
          The inspector is available when demo controls are enabled for this environment.
        </p>
        <Link href={backHref} className="text-sm text-teal underline">
          Back to the trip
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8" data-testid="inspector">
      <header className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="font-serif text-xl font-semibold">Execution inspector</h1>
          <Link href={backHref} className="text-sm text-teal underline">
            Back to the trip
          </Link>
        </div>
        <p className="text-xs text-ink-muted">
          Graph {inspector.graph?.graphVersion ?? "not yet initialized"} · scenario mode{" "}
          {inspector.scenarioMode} · read-only projection from persisted safe rows.
        </p>
      </header>

      <section aria-label="Execution graph">
        <h2 className="text-base font-semibold">Graph</h2>
        {inspector.graph ? (
          <div className="mt-2">
            <ExecutionGraph definition={inspector.graph} nodes={inspector.nodes} />
          </div>
        ) : (
          <p className="mt-1 text-sm text-ink-muted">
            No persisted graph definition yet; run one operation first.
          </p>
        )}
      </section>

      <section aria-label="Nodes">
        <h2 className="text-base font-semibold">Nodes</h2>
        <table className="mt-2 w-full border-collapse text-left text-xs" data-testid="node-table">
          <thead>
            <tr className="border-b border-border text-ink-muted">
              <th className="py-1 pr-3">Node</th>
              <th className="py-1 pr-3">Status</th>
              <th className="py-1 pr-3">Events</th>
              <th className="py-1">Last event</th>
            </tr>
          </thead>
          <tbody>
            {inspector.nodes.map((node) => (
              <tr key={node.name} className="border-b border-border/50">
                <td className="py-1 pr-3 font-mono">{node.name}</td>
                <td className="py-1 pr-3">
                  <StatusBadge status={node.status} />
                </td>
                <td className="py-1 pr-3">{node.occurrences}</td>
                <td className="py-1">{node.lastAt ? formatTime(node.lastAt) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-label="Operations">
        <h2 className="text-base font-semibold">Operations</h2>
        <table
          className="mt-2 w-full border-collapse text-left text-xs"
          data-testid="operation-table"
        >
          <thead>
            <tr className="border-b border-border text-ink-muted">
              <th className="py-1 pr-3">Operation</th>
              <th className="py-1 pr-3">Kind</th>
              <th className="py-1 pr-3">Status</th>
              <th className="py-1 pr-3">Attempts</th>
              <th className="py-1 pr-3">Revision</th>
              <th className="py-1">Updated</th>
            </tr>
          </thead>
          <tbody>
            {inspector.operations.map((operation) => (
              <tr key={operation.operationId} className="border-b border-border/50">
                <td className="py-1 pr-3 font-mono">{shortId(operation.operationId)}</td>
                <td className="py-1 pr-3">{operation.kind}</td>
                <td className="py-1 pr-3">
                  <StatusBadge status={operation.status} />
                </td>
                <td className="py-1 pr-3">{operation.attempts}</td>
                <td className="py-1 pr-3">{operation.acceptedRevision}</td>
                <td className="py-1">{formatTime(operation.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-label="Checkpoints and resumes">
        <h2 className="text-base font-semibold">Checkpoints &amp; resumes</h2>
        <table
          className="mt-2 w-full border-collapse text-left text-xs"
          data-testid="checkpoint-table"
        >
          <thead>
            <tr className="border-b border-border text-ink-muted">
              <th className="py-1 pr-3">Decision</th>
              <th className="py-1 pr-3">Kind</th>
              <th className="py-1 pr-3">Status</th>
              <th className="py-1 pr-3">Checkpoint</th>
              <th className="py-1 pr-3">Interrupt</th>
              <th className="py-1">Created</th>
            </tr>
          </thead>
          <tbody>
            {inspector.checkpoints.map((checkpoint) => (
              <tr key={checkpoint.decisionId} className="border-b border-border/50">
                <td className="py-1 pr-3 font-mono">{shortId(checkpoint.decisionId)}</td>
                <td className="py-1 pr-3">{checkpoint.kind}</td>
                <td className="py-1 pr-3">
                  <StatusBadge status={checkpoint.status} />
                </td>
                <td className="py-1 pr-3 font-mono">
                  {checkpoint.checkpointId ? shortId(checkpoint.checkpointId) : "—"}
                </td>
                <td className="py-1 pr-3 font-mono">
                  {checkpoint.interruptId ? shortId(checkpoint.interruptId) : "—"}
                </td>
                <td className="py-1">{formatTime(checkpoint.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-label="LLM calls">
        <h2 className="text-base font-semibold">LLM calls</h2>
        <p className="mt-1 text-xs text-ink-muted">
          Safe telemetry only: role, model, prompt version label, tokens, and estimated cost.
          Prompts and model output are never stored.
        </p>
        <table className="mt-2 w-full border-collapse text-left text-xs" data-testid="llm-table">
          <thead>
            <tr className="border-b border-border text-ink-muted">
              <th className="py-1 pr-3">Role</th>
              <th className="py-1 pr-3">Model</th>
              <th className="py-1 pr-3">Prompt</th>
              <th className="py-1 pr-3">Mode</th>
              <th className="py-1 pr-3">Status</th>
              <th className="py-1 pr-3">Tokens</th>
              <th className="py-1 pr-3">Cost (USD)</th>
              <th className="py-1">Created</th>
            </tr>
          </thead>
          <tbody>
            {inspector.llmCalls.map((call, index) => (
              <tr
                key={`${call.role}-${call.createdAt}-${index}`}
                className="border-b border-border/50"
              >
                <td className="py-1 pr-3">{call.role}</td>
                <td className="py-1 pr-3">{call.model}</td>
                <td className="py-1 pr-3 font-mono">{call.promptVersion}</td>
                <td className="py-1 pr-3">{call.mode}</td>
                <td className="py-1 pr-3">
                  {call.status}
                  {call.validationStatus ? ` (${call.validationStatus})` : ""}
                </td>
                <td className="py-1 pr-3">
                  {call.actualTokens ?? call.reservedTokens}
                  {call.actualTokens === null ? " (reserved)" : ""}
                </td>
                <td className="py-1 pr-3">
                  {call.actualCostUsd ?? call.reservedCostUsd}
                  {call.actualCostUsd === null ? " (reserved)" : ""}
                </td>
                <td className="py-1">{formatTime(call.createdAt)}</td>
              </tr>
            ))}
          </tbody>
          {inspector.llmCalls.length > 0 ? (
            <tfoot>
              <tr className="border-t border-border font-semibold" data-testid="llm-total">
                <td className="py-1 pr-3" colSpan={6}>
                  Total ({inspector.llmCalls.length}{" "}
                  {inspector.llmCalls.length === 1 ? "call" : "calls"}; unsettled rows count at
                  their reserved amount)
                </td>
                <td className="py-1 pr-3">{inspector.llmCostTotalUsd}</td>
                <td className="py-1" />
              </tr>
            </tfoot>
          ) : null}
        </table>
      </section>

      <section aria-label="Voice usage">
        <h2 className="text-base font-semibold">Voice usage</h2>
        <p className="mt-1 text-xs text-ink-muted">
          Safe voice telemetry only: kind, model, provider metadata, units, latency, and USD cost. A
          separate ledger from LLM calls and travel prices; transcripts, audio, and reply text are
          never stored.
        </p>
        <table className="mt-2 w-full border-collapse text-left text-xs" data-testid="voice-table">
          <thead>
            <tr className="border-b border-border text-ink-muted">
              <th className="py-1 pr-3">Kind</th>
              <th className="py-1 pr-3">Model</th>
              <th className="py-1 pr-3">Provider</th>
              <th className="py-1 pr-3">Units</th>
              <th className="py-1 pr-3">Latency</th>
              <th className="py-1 pr-3">Status</th>
              <th className="py-1 pr-3">Cost (USD)</th>
              <th className="py-1">Created</th>
            </tr>
          </thead>
          <tbody>
            {inspector.voiceCalls.map((call, index) => (
              <tr
                key={`${call.kind}-${call.createdAt}-${index}`}
                className="border-b border-border/50"
              >
                <td className="py-1 pr-3">{call.kind}</td>
                <td className="py-1 pr-3">{call.model}</td>
                <td className="py-1 pr-3">
                  {call.servingProviderId ?? call.restrictedProviderId ?? "—"}
                </td>
                <td className="py-1 pr-3">
                  {call.inputUnits === null
                    ? "—"
                    : `${call.inputUnits} ${call.unitKind === "characters" ? "chars" : "s"}`}
                </td>
                <td className="py-1 pr-3">
                  {call.latencyMs === null ? "—" : `${call.latencyMs} ms`}
                </td>
                <td className="py-1 pr-3">
                  {call.status}
                  {call.costStatus ? ` (${call.costStatus})` : ""}
                </td>
                <td className="py-1 pr-3">
                  {call.actualCostUsd ?? call.reservedCostUsd}
                  {call.actualCostUsd === null ? " (reserved)" : ""}
                </td>
                <td className="py-1">{formatTime(call.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-label="Faults">
        <h2 className="text-base font-semibold">Faults</h2>
        {inspector.faults.length === 0 ? (
          <p className="mt-1 text-sm text-ink-muted" data-testid="no-faults">
            No fault overlay has been armed for this trip.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1 text-xs" data-testid="fault-list">
            {inspector.faults.map((fault) => (
              <li
                key={`${fault.domain}-${fault.mode}-${fault.at}`}
                className="rounded border border-border bg-cream px-2 py-1"
              >
                <strong>{fault.label}</strong> · {fault.domain} · {fault.mode}
                {fault.note ? ` — ${fault.note}` : ""} · {formatTime(fault.at)}
              </li>
            ))}
          </ul>
        )}
      </section>

      {projection.display.demoControlsEnabled ? (
        <SimulationControls
          tripId={tripId}
          revision={projection.trip.revision}
          inspector={inspector}
          onSubmitted={refresh}
        />
      ) : null}

      <section aria-label="Events">
        <h2 className="text-base font-semibold">Events</h2>
        <ul className="mt-2 flex flex-col gap-1 text-xs" data-testid="event-list">
          {inspector.events.map((event) => (
            <li key={event.id} className="flex gap-2 border-b border-border/50 py-1">
              <span className="font-mono text-ink-muted">{event.id}</span>
              <span className="font-mono">{event.type}</span>
              <span>{event.summary ?? ""}</span>
              <span className="ml-auto text-ink-muted">{formatTime(event.at)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
