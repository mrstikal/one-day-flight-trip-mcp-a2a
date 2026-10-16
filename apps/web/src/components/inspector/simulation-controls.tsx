"use client";

import { useCallback, useState } from "react";
import type { PublicInspector } from "@odft/contracts";
import { ApiError } from "@/lib/api-client";
import { submitCommand } from "@/lib/decision-client";

/**
 * Phase 11 simulation controls (08-frontend-ux.md section 10).
 *
 * The controls are owner-protected (session + trip ownership on the BFF) and
 * flag-protected (they only render when demo controls are enabled; the command
 * route rejects `set_simulation` when the flag is off). Every control submits an
 * ordinary `set_simulation` command through the same admitted-operation path, so
 * the worker — not the browser — arms the labeled overlay.
 */

const MODES = [
  {
    mode: "budget_conflict" as const,
    label: "Budget conflict",
    description: "Sets an explicit low budget; the itinerary planner reports a budget conflict.",
    outcome:
      "persists a €1 budget; the replan reports a budget conflict as a clarification card in the assistant rail (\"No price was changed\") where you can raise the budget.",
  },
  {
    mode: "preference_conflict" as const,
    label: "Preference conflict",
    description: "Requests six museums at a relaxed pace; the graph clarifies instead of inventing.",
    outcome:
      "the replan asks for a clarification card in the assistant rail instead of inventing a plan (e.g. a denser pace or fewer museums).",
  },
  {
    mode: "invalid_itinerary" as const,
    label: "Invalid itinerary (first attempt)",
    description: "Injects one labeled overlap on the first planning attempt; replanning repairs it.",
    outcome:
      "adds one labeled overlap to the next first planning attempt; replanning repairs it and the draft keeps the \"Simulated failure\" label on the itinerary page.",
  },
];

export function SimulationControls({
  tripId,
  revision,
  inspector,
  onSubmitted,
}: {
  readonly tripId: string;
  readonly revision: number;
  readonly inspector: PublicInspector;
  readonly onSubmitted: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();

  const arm = useCallback(
    async (mode: (typeof MODES)[number]["mode"]): Promise<void> => {
      setBusy(true);
      setMessage(undefined);
      try {
        await submitCommand(tripId, {
          requestId: crypto.randomUUID(),
          expectedRevision: revision,
          command: { type: "set_simulation", mode },
        });
        setMessage(`Scenario "${mode}" queued; the worker arms it as a labeled simulated failure.`);
        onSubmitted();
      } catch (caught) {
        setMessage(
          caught instanceof ApiError
            ? caught.message
            : "The scenario command could not be admitted.",
        );
      } finally {
        setBusy(false);
      }
    },
    [onSubmitted, revision, tripId],
  );

  return (
    <section aria-label="Simulation controls" data-testid="simulation-controls">
      <h3 className="font-serif text-sm font-semibold">Scenario controls</h3>
      <p className="mt-1 text-xs text-ink-muted">
        Current scenario mode: <span data-testid="scenario-mode">{inspector.scenarioMode}</span>.
        Armed faults are always labeled &quot;Simulated failure&quot; and never fake prices.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {MODES.map((entry) => (
          <button
            key={entry.mode}
            type="button"
            disabled={busy}
            title={entry.description}
            onClick={() => {
              void arm(entry.mode);
            }}
            className="rounded border border-border bg-cream px-3 py-1.5 text-xs disabled:opacity-50"
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div
        className="mt-2 flex flex-col gap-1 rounded border border-border bg-cream p-2 text-xs text-ink-muted"
        data-testid="scenario-help"
      >
        <p>
          Arming a control only stores the simulated failure; its result appears during the next
          planning run. Budget and preference conflicts change the trip&apos;s preferences, so the
          meals/program step re-opens — save it to replan. The invalid-itinerary overlap applies to
          the next planning attempt (change a meal or activity to replan if the trip is already
          planned). The outcome shows up in the trip UI:
        </p>
        <ul className="flex flex-col gap-0.5">
          {MODES.map((entry) => (
            <li key={entry.mode}>
              <span className="text-ink">{entry.label}</span> — {entry.outcome}
            </li>
          ))}
        </ul>
      </div>
      {message ? (
        <p role="status" className="mt-2 text-xs text-ink-muted">
          {message}
        </p>
      ) : null}
    </section>
  );
}
