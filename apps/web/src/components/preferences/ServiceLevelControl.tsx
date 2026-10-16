"use client";

import { useState } from "react";
import type { PublicServiceLevelState, ServiceLevel, ServiceKey } from "@odft/contracts";
import { ApiError } from "@/lib/api-client";
import { submitCommand } from "@/lib/decision-client";

const LEVELS: readonly ServiceLevel[] = ["budget", "standard", "luxury"];

/**
 * Inline per-service level control (07 section 2). An explicit selection becomes
 * an override that survives a later global default change; "Use default" clears
 * the override. The server resolves inheritance; the client never guesses it.
 */
export function ServiceLevelControl({
  tripId,
  revision,
  service,
  label,
  levelState,
  onChanged,
}: {
  readonly tripId: string;
  readonly revision: number;
  readonly service: ServiceKey;
  readonly label: string;
  readonly levelState: PublicServiceLevelState;
  readonly onChanged: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

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

  const groupName = `service-level-${service}`;
  return (
    <fieldset className="flex flex-col gap-2" disabled={busy}>
      <legend className="text-sm font-medium">
        {label} category
        <span className="ml-2 text-xs font-normal text-ink-muted">
          {levelState.inherited ? "using the global default" : "explicit choice"}
        </span>
      </legend>
      <div className="flex flex-wrap gap-3">
        {LEVELS.map((level) => (
          <label key={level} className="flex items-center gap-1 text-sm capitalize">
            <input
              type="radio"
              name={groupName}
              value={level}
              checked={levelState.level === level && !levelState.inherited}
              onChange={() => void apply(level)}
            />
            {level}
          </label>
        ))}
        {levelState.inherited ? null : (
          <button
            type="button"
            onClick={() => void apply(null)}
            disabled={busy}
            className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50"
          >
            Use default
          </button>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-clay">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
