"use client";

import type { ItineraryReview, PublicItinerary } from "@odft/contracts";

/**
 * Validation summary (Phase 10 section 7): blocking errors, warnings with their
 * visible explanation, the qualitative review notes, and the labeled injected
 * failure. Approval stays disabled while blocking errors remain.
 */
export function ValidationSummary({
  itinerary,
}: {
  readonly itinerary: PublicItinerary;
}): React.JSX.Element {
  const validation = itinerary.validation;
  const review: ItineraryReview | null = itinerary.review;
  const hasErrors = validation.errors.length > 0;
  return (
    <section aria-labelledby="validation-heading" className="flex flex-col gap-3">
      <h2 id="validation-heading" className="text-xl">
        Plan validation
      </h2>
      {itinerary.simulatedFailure ? (
        <p
          data-testid="simulated-failure-label"
          className="w-fit rounded border border-clay px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-clay"
        >
          Simulated failure
        </p>
      ) : null}
      {itinerary.simulatedFailureNote ? (
        <p data-testid="simulated-failure-note" className="text-xs text-ink-muted">
          {itinerary.simulatedFailureNote}
        </p>
      ) : null}
      {hasErrors ? (
        <div
          role="alert"
          data-testid="validation-errors"
          className="flex flex-col gap-2 rounded border border-clay bg-cream p-4"
        >
          <h3 className="text-base">Blocking errors ({validation.errors.length})</h3>
          <p className="text-sm text-ink-muted">
            Approval is disabled while blocking errors remain; resolve them in the assistant.
          </p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {validation.errors.map((error, index) => (
              <li key={`${error.code}-${index}`}>
                <span className="font-medium">({error.code})</span> {error.message}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p data-testid="validation-ok" className="text-sm text-teal">
          No blocking errors. The deterministic checks and the pace profile pass.
        </p>
      )}
      {validation.warnings.length > 0 ? (
        <div
          data-testid="validation-warnings"
          className="flex flex-col gap-2 rounded border border-border bg-paper p-4"
        >
          <h3 className="text-base">Warnings ({validation.warnings.length})</h3>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink-muted">
            {validation.warnings.map((warning, index) => (
              <li key={`${warning.code}-${index}`}>
                <span className="font-medium">({warning.code})</span> {warning.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {review && review.issues.length > 0 ? (
        <div
          data-testid="review-notes"
          className="flex flex-col gap-2 rounded border border-border bg-paper p-4"
        >
          <h3 className="text-base">
            Reviewer notes ({review.verdict}
            {review.suggestionsAsWarnings ? ", nonblocking at the attempt bound" : ""})
          </h3>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink-muted">
            {review.issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>
                <span className="font-medium">({issue.code})</span> {issue.explanation}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
