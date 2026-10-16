"use client";

import type { ItineraryEvent, ItineraryIssue } from "@odft/contracts";
import { EventCard } from "./event-card";

/** Chronological destination-local timeline (Phase 10 section 7). */
export function Timeline({
  events,
  zone,
  issues,
}: {
  readonly events: readonly ItineraryEvent[];
  readonly zone: string;
  readonly issues: readonly ItineraryIssue[];
}): React.JSX.Element {
  return (
    <section aria-labelledby="itinerary-timeline-heading" className="flex flex-col gap-3">
      <h2 id="itinerary-timeline-heading" className="text-xl">
        Day timeline ({zone})
      </h2>
      {events.length === 0 ? (
        <p className="text-sm text-ink-muted">No planned events yet.</p>
      ) : (
        <ol data-testid="itinerary-timeline" className="flex flex-col gap-3">
          {events.map((event) => (
            <li key={event.id}>
              <EventCard event={event} zone={zone} issues={issues} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
