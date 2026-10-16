"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ServiceKey } from "@odft/contracts";
import { ApiError, apiGet } from "@/lib/api-client";
import { submitCommand } from "@/lib/decision-client";
import { runWithOperationPreloader } from "@/lib/operation-preloader";

/** The step that presents a service's refreshed choice. */
const STEP_FOR_SERVICE: Partial<Record<ServiceKey, string>> = {
  hotel: "hotel",
  breakfast: "meals",
  lunch: "meals",
  dinner: "meals",
};

/**
 * Replacement entry point on a summary's confirmed row and on the service's own
 * step (hotel/meals). It stages the same `find_alternatives` command the
 * assistant sends for a change and opens the step where the refreshed choice is
 * presented; an existing selection or reservation is never touched until the
 * user confirms the replacement. On the already-open step the caller passes
 * `onChanged` so the projection refreshes in place instead of re-navigating.
 */
export function ChangeServiceButton({
  tripId,
  service,
  label,
  onChanged,
}: {
  readonly tripId: string;
  readonly service: ServiceKey;
  readonly label: string;
  /** Present when the button sits on the target step itself. */
  readonly onChanged?: () => void;
}): React.JSX.Element | null {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const step = STEP_FOR_SERVICE[service];
  if (step === undefined) {
    return null;
  }

  async function changeService(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await runWithOperationPreloader("Finding alternatives...", async () => {
        // The summary is server-rendered, so its revision can be stale after any
        // trip activity; read the current one right before writing.
        const { trip } = await apiGet<{ trip: { revision: number } }>(`/api/trips/${tripId}`);
        await submitCommand(tripId, {
          requestId: crypto.randomUUID(),
          expectedRevision: trip.revision,
          command: { type: "find_alternatives", target: service, objective: "match_preferences" },
        });
      });
      if (onChanged) {
        onChanged();
        return;
      }
      router.push(`/trips/${tripId}/${step}`);
      // The App Router does not reliably reset the scroll for a programmatic push
      // away from a long server-rendered page; the summary row sits at the bottom,
      // so put the target step at its top explicitly.
      window.scrollTo({ top: 0, left: 0 });
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : `The ${label} change could not be started.`,
      );
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        data-testid={`change-${service}`}
        disabled={busy}
        onClick={() => void changeService()}
        className="w-fit rounded border border-teal px-3 py-1.5 text-sm font-medium text-teal hover:bg-teal-50 disabled:opacity-50"
      >
        {busy ? "Preparing alternatives…" : `Change ${label}`}
      </button>
      {error ? (
        <p role="alert" className="text-sm text-clay">
          {error}
        </p>
      ) : null}
    </div>
  );
}