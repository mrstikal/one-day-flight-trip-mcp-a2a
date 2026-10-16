"use client";

import type { PublicClarificationOption } from "@odft/contracts";

/** Bounded clarification choices: labelled opaque option ids, never raw commands. */
export function ClarificationOptions({
  question,
  options,
  busy,
  onChoose,
}: {
  readonly question: string;
  readonly options: readonly PublicClarificationOption[];
  readonly busy: boolean;
  readonly onChoose: (optionId: string) => void;
}): React.JSX.Element {
  return (
    <div
      data-testid="clarification-card"
      className="flex flex-col gap-2 rounded border border-clay bg-cream p-3"
    >
      <p className="text-sm font-medium">{question}</p>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={busy}
            onClick={() => onChoose(option.id)}
            className="rounded border border-border bg-paper px-3 py-1 text-sm disabled:opacity-50"
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
