/** Provenance / demo labels rendered verbatim from the server projection. */
export function ProvenanceLabel({
  labels,
}: {
  readonly labels: readonly string[];
}): React.JSX.Element {
  return <p className="text-xs text-ink-muted">{labels.join(" · ")}</p>;
}
