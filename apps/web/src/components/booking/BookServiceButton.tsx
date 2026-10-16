"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { BookableKey } from "@odft/contracts";
import { ApiError, apiGet } from "@/lib/api-client";
import { submitCommand } from "@/lib/decision-client";
import { runWithOperationPreloader } from "@/lib/operation-preloader";

/** The step that presents a declined booking's review dialog. */
const STEP_FOR_SERVICE: Partial<Record<BookableKey, string>> = {
  flights: "flights",
  hotel: "hotel",
};

/**
 * Late booking for a flight/hotel kept as a selection ("I don't want to book").
 * It stages the selected offer as a proposal — the same review dialog as a fresh
 * selection — so nothing is booked without the explicit confirmation step.
 */
export function BookServiceButton({
  tripId,
  service,
  offerId,
  label,
}: {
  readonly tripId: string;
  readonly service: BookableKey;
  readonly offerId: string;
  readonly label: string;
}): React.JSX.Element | null {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const step = STEP_FOR_SERVICE[service];
  if (step === undefined) {
    return null;
  }

  async function bookService(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await runWithOperationPreloader("Saving your selection...", async () => {
        // The summary is server-rendered, so its revision can be stale after any
        // trip activity; read the current one right before writing.
        const { trip } = await apiGet<{ trip: { revision: number } }>(`/api/trips/${tripId}`);
        await submitCommand(tripId, {
          requestId: crypto.randomUUID(),
          expectedRevision: trip.revision,
          command: { type: "propose_selection", service, offerId },
        });
      });
      router.push(`/trips/${tripId}/${step}`);
      // Match the change flow: put the target step at its top explicitly.
      window.scrollTo({ top: 0, left: 0 });
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : `The ${label} booking could not be started.`,
      );
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        data-testid={`book-${service}`}
        disabled={busy}
        onClick={() => void bookService()}
        className="w-fit rounded bg-teal px-3 py-1.5 text-sm font-medium text-paper hover:bg-teal-strong disabled:opacity-50"
      >
        {busy ? "Preparing the review…" : `Book this ${label}`}
      </button>
      {error ? (
        <p role="alert" className="text-sm text-clay">
          {error}
        </p>
      ) : null}
    </div>
  );
}
