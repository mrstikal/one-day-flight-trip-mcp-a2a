"use client";

import type { PublicInterpretation } from "@odft/contracts";

/** Safe interpretation card: understanding, preserved constraints, and options. */
export function InterpretationCard({
  interpretation,
}: {
  readonly interpretation: PublicInterpretation;
}): React.JSX.Element {
  const preserve = interpretation.preserve ?? [];
  return (
    <div data-testid="interpretation-card" className="mt-2 flex flex-col gap-1 text-xs text-ink-muted">
      <p>
        <span className="font-medium">Understood as:</span>{" "}
        {interpretation.interpretation ?? interpretation.question ?? interpretation.kind}
      </p>
      {preserve.length > 0 ? <p>Keeping: {preserve.join(", ")}</p> : null}
      {interpretation.kind === "clarification" ? <p>A clarification is open below.</p> : null}
      {interpretation.kind === "unsupported" ? (
        <p>The graphical controls remain available.</p>
      ) : null}
    </div>
  );
}
