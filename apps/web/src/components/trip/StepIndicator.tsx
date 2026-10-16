import { tripStepHeading, type TripStepKey } from "@/lib/trip-step";

/**
 * Screen-header step indicator. Every screen of the journey renders the same
 * `Step N of M` caption from the shared step order in `lib/trip-step.ts`, so the
 * captions can never disagree with each other or with the sticky step nav.
 */
export function StepIndicator({ step }: { readonly step: TripStepKey }): React.JSX.Element {
  return (
    <p
      data-testid="step-indicator"
      className="text-sm font-medium uppercase tracking-wide text-teal"
    >
      {tripStepHeading(step)}
    </p>
  );
}
