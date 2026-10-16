"use client";

import { useRouter } from "next/navigation";
import type { PublicPendingDecision } from "@odft/contracts";
import { recoveryOptionHref } from "@/lib/trip-step";

const OPTION_LABELS: Readonly<Record<string, string>> = {
  change_hotel: "Adjust the hotel",
  change_meals: "Adjust the meals",
  change_program: "Adjust the program",
};

/**
 * Typed recovery decision (Phase 07 step 7, extended in Phase 09). A
 * deterministic logistics conflict or an unavailable necessary research domain
 * opens this instead of editing a reservation: the user re-opens the affected
 * step. The reason itself is not carried in the decision DTO (no free text), only
 * the offered recovery options.
 *
 * Choosing an option runs in the background, so the card navigates to the
 * reopened step itself once the resume is accepted — otherwise the click would
 * look like a no-op on the current page (e.g. "Adjust the hotel" on meals).
 */
export function RecoveryCard({
  decision,
  tripId,
  busy,
  error,
  onChoose,
}: {
  readonly decision: PublicPendingDecision;
  readonly tripId: string;
  readonly busy: boolean;
  readonly error: string | undefined;
  /** Submits the choice; resolves true only when the resume was accepted. */
  readonly onChoose: (optionId: string) => Promise<boolean>;
}): React.JSX.Element {
  const router = useRouter();

  async function choose(optionId: string): Promise<void> {
    const accepted = await onChoose(optionId);
    if (!accepted) {
      return;
    }
    const href = recoveryOptionHref(tripId, optionId);
    if (href) {
      router.push(href);
    }
  }

  return (
    <section
      className="flex flex-col gap-3 rounded border border-clay bg-paper p-6"
      aria-labelledby="recovery-heading"
    >
      <h2 id="recovery-heading" className="text-lg text-clay">
        We need one change to keep your day feasible
      </h2>
      <p className="text-sm text-ink-muted">
        The confirmed plan needs one adjustment (for example a transfer, a meal window, or an
        option that is unavailable for the selected category). Nothing has been changed
        automatically; pick which part to adjust.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-clay">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        {decision.allowedOptionIds.map((optionId) => (
          <button
            key={optionId}
            type="button"
            disabled={busy}
            onClick={() => {
              void choose(optionId);
            }}
            className="w-fit rounded bg-teal px-4 py-2 text-sm font-medium text-paper hover:bg-teal-strong disabled:opacity-50"
          >
            {OPTION_LABELS[optionId] ?? optionId}
          </button>
        ))}
      </div>
    </section>
  );
}