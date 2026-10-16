"use client";

import { useState } from "react";
import type { PublicServiceLevelState, ServiceKey, ServiceLevel } from "@odft/contracts";
import { ApiError } from "@/lib/api-client";
import { submitCommand } from "@/lib/decision-client";

const LEVEL_LABELS: readonly { readonly value: ServiceLevel; readonly label: string }[] = [
  { value: "budget", label: "Budget" },
  { value: "standard", label: "Standard" },
  { value: "luxury", label: "Luxury" },
];

/**
 * Per-service category select (Phase 11). The value defaults to the effective
 * level — the global default from the first step unless an explicit override
 * exists — and the server resolves inheritance; the client never guesses it.
 * When the current offers came from an objective-driven assistant search, the
 * select shows "Custom request" and is locked: no plain category describes that
 * list. Used for the hotel and for each meal section.
 */
export function ServiceLevelSelect({
  tripId,
  revision,
  service,
  label,
  levelState,
  customObjective,
  onChanged,
}: {
  readonly tripId: string;
  readonly revision: number;
  readonly service: ServiceKey;
  readonly label: string;
  readonly levelState: PublicServiceLevelState;
  readonly customObjective: string | null;
  readonly onChanged: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const custom = customObjective !== null;
  const selectId = `${service}-level-${tripId}`;

  async function apply(level: ServiceLevel | null): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await submitCommand(tripId, {
        requestId: crypto.randomUUID(),
        expectedRevision: revision,
        command: { type: "set_service_override", service, level },
      });
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The level change failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={selectId} className="flex items-center gap-2 text-sm font-medium">
        <span className="capitalize">{label}</span> category
        <span className="text-xs font-normal text-ink-muted">
          {custom
            ? "from your assistant request"
            : levelState.inherited
              ? "using the global default"
              : "explicit choice"}
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <select
          id={selectId}
          data-testid={`level-select-${service}`}
          className="w-48 rounded border border-border bg-paper px-3 py-2 text-sm disabled:opacity-60"
          value={custom ? "custom" : levelState.level}
          disabled={custom || busy}
          onChange={(event) => void apply(event.target.value as ServiceLevel)}
        >
          {LEVEL_LABELS.map(({ value, label: levelLabel }) => (
            <option key={value} value={value}>
              {levelLabel}
            </option>
          ))}
          {custom ? <option value="custom">Custom request</option> : null}
        </select>
        {!custom && !levelState.inherited ? (
          <button
            type="button"
            onClick={() => void apply(null)}
            disabled={busy}
            className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50"
          >
            Use default
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-clay">
          {error}
        </p>
      ) : null}
    </div>
  );
}