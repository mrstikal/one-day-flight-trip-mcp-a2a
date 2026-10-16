"use client";

import { useState } from "react";
import type { ActivityPace } from "@odft/contracts";
import { ApiError } from "@/lib/api-client";
import { submitCommand } from "@/lib/decision-client";

const PACES: readonly ActivityPace[] = ["relaxed", "moderate", "intensive"];

/**
 * Activity pace control inside program choices (08 section 6). It submits a
 * validated preference command; the server re-researches activity choices. The
 * client never filters server-provided options on its own.
 */
export function InterestControls({
  tripId,
  revision,
  pace,
  onChanged,
}: {
  readonly tripId: string;
  readonly revision: number;
  readonly pace: ActivityPace;
  readonly onChanged: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function apply(next: ActivityPace): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await submitCommand(tripId, {
        requestId: crypto.randomUUID(),
        expectedRevision: revision,
        command: { type: "set_activity_pace", pace: next },
      });
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The pace change failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="flex flex-col gap-2" disabled={busy}>
      <legend className="text-sm font-medium">Activity pace</legend>
      <div className="flex flex-wrap gap-3">
        {PACES.map((option) => (
          <label key={option} className="flex items-center gap-1 text-sm capitalize">
            <input
              type="radio"
              name="activity-pace"
              value={option}
              checked={pace === option}
              onChange={() => void apply(option)}
            />
            {option}
          </label>
        ))}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-clay">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
