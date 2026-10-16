"use client";

import type { ItineraryEvent, ItineraryIssue } from "@odft/contracts";
import { formatEuroMinor } from "@/lib/format/money";

const KIND_LABELS: Readonly<Record<ItineraryEvent["kind"], string>> = {
  meal: "Meal",
  activity: "Visit",
  break: "Break",
  transfer: "Transfer",
  airport_buffer: "Airport buffer",
  free_time: "Free time",
};

/**
 * One itinerary event card (Phase 10 section 7): destination-local times with the
 * explicit zone label, provenance, physical demand, cost inclusion, lock and
 * simulated badges, and the validation messages anchored to this event.
 */
export function EventCard({
  event,
  zone,
  issues,
}: {
  readonly event: ItineraryEvent;
  readonly zone: string;
  readonly issues: readonly ItineraryIssue[];
}): React.JSX.Element {
  const anchored = issues.filter((issue) => issue.eventIds.includes(event.id));
  return (
    <article
      data-testid="itinerary-event"
      data-event-kind={event.kind}
      className="flex flex-col gap-2 rounded border border-border bg-paper p-4"
    >
      <header className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-cream px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-ink-muted">
          {KIND_LABELS[event.kind]}
        </span>
        <span className="font-mono text-sm" data-testid="event-time">
          {event.startLocal}–{event.endLocal}
        </span>
        <span className="text-xs text-ink-muted">
          {event.durationMinutes} min · {zone}
        </span>
        {event.locked ? (
          <span
            data-testid="event-lock"
            className="rounded border border-clay px-2 py-0.5 text-xs text-clay"
          >
            Locked
          </span>
        ) : null}
        {event.simulated ? (
          <span className="rounded border border-border px-2 py-0.5 text-xs text-ink-muted">
            Simulated estimate
          </span>
        ) : null}
      </header>
      <h3 className="text-base">{event.title}</h3>
      {event.locked && event.lockReason ? (
        <p data-testid="event-lock-reason" className="text-xs text-clay">
          {event.lockReason}
        </p>
      ) : null}
      <p className="text-xs text-ink-muted">{event.provenance.join(" · ")}</p>
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div className="flex gap-2">
          <dt className="text-ink-muted">Physical demand</dt>
          <dd className="capitalize">{event.physicalDemand}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-ink-muted">Cost</dt>
          <dd>
            {event.costMinor > 0
              ? `${formatEuroMinor(event.costMinor)} party total`
              : "No extra cost"}
          </dd>
        </div>
      </dl>
      {anchored.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label="Validation messages for this event">
          {anchored.map((issue, index) => (
            <li
              key={`${issue.code}-${index}`}
              role={issue.severity === "error" ? "alert" : "status"}
              className={`text-xs ${issue.severity === "error" ? "text-clay" : "text-ink-muted"}`}
            >
              {issue.severity === "error" ? "Error" : "Warning"} ({issue.code}): {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
