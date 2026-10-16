import Link from "next/link";
import type { RouteAlternative, RouteReasonEntry, ScheduleReason } from "@odft/contracts";
import { routeAlternativeText, routeReasonText, scheduleReasonText } from "@/lib/reasons";

/** Gate cards for the flights step: route rejection, empty schedules, failure, success. */

export function RouteRejectionCard({
  reasons,
  alternatives,
  children,
}: {
  readonly reasons: readonly RouteReasonEntry[];
  readonly alternatives: readonly RouteAlternative[];
  readonly children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      className="flex flex-col gap-4 rounded border border-clay bg-paper p-6"
      aria-labelledby="route-rejected-heading"
    >
      <h2 id="route-rejected-heading" className="text-xl text-clay">
        No feasible flight for this route
      </h2>
      <p className="text-sm text-ink-muted">
        The route policy rejected this combination. No flight offers are shown because none are
        feasible. Ground travel may still be possible for this trip — this app only plans the
        flight day, so it cannot book that alternative for you.
      </p>
      <ul className="flex flex-col gap-2">
        {reasons.map((reason) => (
          <li key={reason.code} className="text-sm">
            <span className="font-medium">{reason.code}</span> — {routeReasonText(reason.code)} (
            {reason.explanation})
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">What you can do next</p>
        <ul className="list-disc pl-5 text-sm">
          {alternatives.map((alternative) => (
            <li key={alternative}>{routeAlternativeText(alternative)}</li>
          ))}
        </ul>
      </div>
      {children}
    </section>
  );
}

export function ExpiredProposalCard({
  onReselect,
  busy,
}: {
  readonly onReselect: () => void;
  readonly busy: boolean;
}): React.JSX.Element {
  return (
    <section
      className="flex flex-col gap-3 rounded border border-clay bg-paper p-6"
      aria-labelledby="stale-proposal-heading"
    >
      <h2 id="stale-proposal-heading" className="text-lg text-clay">
        This proposal is no longer valid
      </h2>
      <p className="text-sm text-ink-muted">
        The review proposal expired or was superseded. Choose a flight again to create a fresh
        proposal and a new expiry.
      </p>
      <button
        type="button"
        onClick={onReselect}
        disabled={busy}
        className="w-fit rounded bg-teal px-4 py-2 text-sm font-medium text-paper hover:bg-teal-strong disabled:opacity-50"
      >
        {busy ? "Reopening…" : "Choose a different flight"}
      </button>
    </section>
  );
}

export function ScheduleEmptyCard({
  oneNight,
  reasons,
  explanation,
  onRequestTwoNights,
  busy,
}: {
  readonly oneNight: boolean;
  readonly reasons: readonly ScheduleReason[];
  readonly explanation: string | null;
  readonly onRequestTwoNights: () => void;
  readonly busy: boolean;
}): React.JSX.Element {
  return (
    <section
      className="flex flex-col gap-4 rounded border border-border bg-paper p-6"
      aria-labelledby="no-schedule-heading"
    >
      <h2 id="no-schedule-heading" className="text-xl">
        No valid day-trip schedule
      </h2>
      <p className="text-sm text-ink-muted">
        Route travel is possible, but no generated flight combination leaves enough sightseeing
        time. The independent schedule validator rejected every combination.
      </p>
      {reasons.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm">
          {reasons.map((reason) => (
            <li key={reason}>
              <span className="font-medium">{reason}</span> — {scheduleReasonText(reason)}
            </li>
          ))}
        </ul>
      ) : null}
      {explanation ? <p className="text-sm text-ink-muted">{explanation}</p> : null}
      {oneNight ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm">
            A longer stay may work. Requesting two nights revalidates the route and schedules from
            scratch.
          </p>
          <button
            type="button"
            onClick={onRequestTwoNights}
            disabled={busy}
            className="w-fit rounded bg-teal px-4 py-2 text-sm font-medium text-paper hover:bg-teal-strong disabled:opacity-50"
          >
            {busy ? "Requesting…" : "Request two nights"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function FailedCard({
  message,
  canRetry,
  busy,
  onRetry,
}: {
  readonly message: string;
  readonly canRetry: boolean;
  readonly busy: boolean;
  readonly onRetry: () => void;
}): React.JSX.Element {
  return (
    <section
      role="alert"
      className="flex flex-col gap-3 rounded border border-clay bg-paper p-6"
      aria-labelledby="failed-heading"
    >
      <h2 id="failed-heading" className="text-lg text-clay">
        Planning could not finish
      </h2>
      <p className="text-sm">{message}</p>
      {canRetry ? (
        <button
          type="button"
          onClick={onRetry}
          disabled={busy}
          className="w-fit rounded bg-teal px-4 py-2 text-sm font-medium text-paper hover:bg-teal-strong disabled:opacity-50"
        >
          {busy ? "Retrying…" : "Retry planning"}
        </button>
      ) : (
        <p className="text-sm text-ink-muted">
          An owner retry is not available for this state. Refresh to check again.
        </p>
      )}
    </section>
  );
}

export function StatusPanel({ message }: { readonly message: string }): React.JSX.Element {
  return (
    <section
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 rounded border border-border bg-paper p-6 text-sm text-ink-muted"
    >
      <span
        aria-hidden="true"
        className="inline-block h-3 w-3 animate-pulse rounded-full bg-teal"
      />
      {message}
    </section>
  );
}

export function ErrorPanel({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}): React.JSX.Element {
  return (
    <section role="alert" className="flex flex-col gap-3 rounded border border-clay bg-paper p-6">
      <h2 className="text-lg text-clay">Something needs your attention</h2>
      <p className="text-sm">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="w-fit rounded border border-teal px-3 py-2 text-sm text-teal"
      >
        Refresh
      </button>
    </section>
  );
}

export function SuccessPanel({
  demoReference,
  tripId,
}: {
  readonly demoReference: string;
  readonly tripId: string;
}): React.JSX.Element {
  return (
    <section
      className="flex flex-col gap-4 rounded border border-teal bg-paper p-6"
      aria-labelledby="booked-heading"
    >
      <h2 id="booked-heading" className="text-xl text-teal">
        Simulated booking confirmed
      </h2>
      <p className="text-sm">
        Reference <span data-testid="demo-reference" className="font-mono font-semibold">{demoReference}</span>
      </p>
      <p className="text-sm text-ink-muted">
        This is a simulated reservation. No payment was taken and it is not valid for travel.
      </p>
      <div className="flex flex-wrap gap-3">
        <Link
          href={`/trips/${tripId}/summary`}
          className="w-fit rounded bg-teal px-4 py-2 text-sm font-medium text-paper hover:bg-teal-strong"
        >
          View trip summary
        </Link>
        <Link
          href={`/trips/${tripId}/itinerary`}
          className="w-fit rounded border border-teal px-4 py-2 text-sm font-medium text-teal"
        >
          View itinerary
        </Link>
      </div>
    </section>
  );
}
