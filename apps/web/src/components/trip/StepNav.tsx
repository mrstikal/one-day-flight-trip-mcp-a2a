"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback } from "react";
import { hasSavedProgram, tripStepStates } from "@/lib/trip-step";
import { useTripEvents } from "@/lib/use-sse";
import { useTripProjection } from "@/lib/use-trip-projection";

/**
 * Sticky step navigation for the trip workspace (desktop layout only). Every step
 * is listed; a step whose prerequisite milestone is not done yet stays visible but
 * disabled, and the step that needs the user next is marked. It reads the live
 * projection through SSE events only (no polling of its own), so it never doubles
 * the page's request loop.
 */
export function StepNav({ tripId }: { readonly tripId: string }): React.JSX.Element {
  const { projection, refresh } = useTripProjection(tripId, { poll: false });
  const onEvent = useCallback(() => refresh(), [refresh]);
  useTripEvents(tripId, onEvent);
  const pathname = usePathname();

  if (!projection) {
    return (
      <nav
        data-testid="step-nav"
        aria-label="Trip steps"
        className="shrink-0 rounded border border-border bg-paper p-3 text-sm text-ink-muted"
      >
        Trip steps…
      </nav>
    );
  }

  const steps = tripStepStates({
    tripId,
    reservations: projection.reservations,
    hasProgram: hasSavedProgram(projection.program),
    hasItinerary: projection.itinerary !== null,
    flightSelected: projection.selections.flights.offerId !== null,
    hotelSelected: projection.selections.hotel.offerId !== null,
    pendingDecisionKind: projection.pendingDecision?.kind ?? null,
    proposalServiceKey: projection.proposal?.serviceKey ?? null,
  });

  const firstDisabled = steps.findIndex((step) => !step.enabled);

  return (
    <nav
      data-testid="step-nav"
      aria-label="Trip steps"
      className="flex shrink-0 flex-col gap-1 rounded border border-border bg-paper p-3"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">Trip steps</p>
      <ol className="flex flex-col">
        {steps.map((step, index) => {
          const active = pathname === step.href;
          const itemClass = `flex items-center gap-2 rounded px-2 py-1.5 text-sm ${
            active ? "bg-teal-50 font-medium text-teal-strong" : "text-ink"
          }`;
          return (
            <li key={step.key} className="contents">
              {step.enabled ? (
                <Link
                  href={step.href}
                  data-testid={`step-nav-${step.key}`}
                  aria-current={active ? "page" : undefined}
                  className={`${itemClass} hover:bg-cream`}
                >
                  <span className="w-4 text-right text-xs text-ink-muted">{index + 1}</span>
                  <span>{step.label}</span>
                  {step.next ? (
                    <span className="ml-auto rounded bg-teal-50 px-1.5 text-xs text-teal-strong">
                      next
                    </span>
                  ) : null}
                </Link>
              ) : (
                <span
                  data-testid={`step-nav-${step.key}`}
                  aria-disabled="true"
                  title={step.requires ?? undefined}
                  className={`${itemClass} cursor-not-allowed text-ink-muted opacity-60`}
                >
                  <span className="w-4 text-right text-xs text-ink-muted">{index + 1}</span>
                  <span>{step.label}</span>
                  {index === firstDisabled ? (
                    <span className="ml-auto text-right text-xs">{step.requires}</span>
                  ) : null}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}