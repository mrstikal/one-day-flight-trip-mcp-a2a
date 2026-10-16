"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWizardDraft } from "./WizardDraft";

/**
 * Shown on the draft steps once the trip exists: the wizard only creates trips,
 * so the recorded values stay visible but read-only here; route and preference
 * changes are made from the trip page.
 */
export function TripCreatedNotice(): React.JSX.Element {
  const { draft, reset } = useWizardDraft();
  const router = useRouter();

  return (
    <div
      role="note"
      className="flex flex-col gap-2 rounded border border-border bg-paper p-3 text-sm text-ink-muted"
    >
      <p>
        This trip has already been created, so these values are shown read-only. Route and
        preference changes are made from the trip page.
      </p>
      <div className="flex items-center gap-4">
        <Link href={`/trips/${draft.tripId}/flights`} className="text-ink underline">
          Back to trip
        </Link>
        <button
          type="button"
          onClick={() => {
            reset();
            router.push("/");
          }}
          className="rounded bg-teal px-3 py-1.5 font-medium text-paper hover:bg-teal-strong"
        >
          Start a new trip
        </button>
      </div>
    </div>
  );
}
