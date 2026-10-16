"use client";

import { useState } from "react";
import type { PublicResearchDomainState, ResearchDomain } from "@odft/contracts";
import { ApiError } from "@/lib/api-client";
import { submitCommand } from "@/lib/decision-client";

/**
 * Phase 09 empty/failed domain states. A domain whose research did not return
 * `ok` renders its gap here (never the raw snapshot inventory), injected faults
 * read `Simulated failure`, and the retry action submits the ordinary
 * `retry_failed_domains` command through the same admission path as any other
 * command.
 */

const DOMAIN_LABELS: Readonly<Record<ResearchDomain, string>> = {
  hotel: "hotel",
  breakfast: "breakfast",
  lunch: "lunch",
  dinner: "dinner",
  attractions: "activity",
  events: "event",
};

export function ResearchFailurePanel({
  tripId,
  revision,
  domain,
  state,
  disabled,
  onRetried,
}: {
  readonly tripId: string;
  readonly revision: number;
  readonly domain: ResearchDomain;
  readonly state: PublicResearchDomainState;
  /** True while the trip has a queued/running operation (avoids a conflict). */
  readonly disabled: boolean;
  readonly onRetried: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function retry(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await submitCommand(tripId, {
        requestId: crypto.randomUUID(),
        expectedRevision: revision,
        command: { type: "retry_failed_domains" },
      });
      onRetried();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The retry request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-testid={`research-failure-${domain}`}
      className="flex flex-col gap-2 rounded border border-clay bg-cream p-4"
    >
      <h2 className="text-lg">No {DOMAIN_LABELS[domain]} offers available</h2>
      {state.simulatedFailure ? (
        <p
          data-testid="simulated-failure-label"
          className="w-fit rounded border border-clay px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-clay"
        >
          Simulated failure
        </p>
      ) : null}
      <p className="text-sm text-ink-muted">
        {state.reason ?? "The provider returned no compatible offers for the current selection."}
      </p>
      <p className="text-sm text-ink-muted">
        Your confirmed bookings are unchanged. Adjust the category below or retry the failed
        domains.
      </p>
      <button
        type="button"
        data-testid="retry-failed-domains"
        disabled={busy || disabled}
        onClick={() => void retry()}
        className="w-fit rounded border border-teal px-3 py-1 text-sm text-teal disabled:opacity-50"
      >
        {busy ? "Retrying…" : "Retry failed domains"}
      </button>
      {error ? (
        <p role="alert" className="text-sm text-clay">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** Compact note when an injected fault was observed but the retry succeeded. */
export function SimulatedFailureNote({
  state,
}: {
  readonly state: PublicResearchDomainState | null;
}): React.JSX.Element | null {
  if (!state?.simulatedFailure) {
    return null;
  }
  return (
    <p data-testid="simulated-failure-note" className="text-xs text-ink-muted">
      Simulated failure (retried automatically).
    </p>
  );
}