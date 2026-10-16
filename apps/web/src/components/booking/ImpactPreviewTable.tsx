export interface ImpactRow {
  readonly label: string;
  readonly before: string;
  readonly after: string;
}

/** Deterministic before/after impact preview for a replacement (09 section 7). */
export function ImpactPreviewTable({
  rows,
  caption = "Impact of this change",
}: {
  readonly rows: readonly ImpactRow[];
  readonly caption?: string;
}): React.JSX.Element {
  return (
    <table className="w-full border-collapse text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col" className="border-b border-border py-1 text-left font-medium">
            Item
          </th>
          <th scope="col" className="border-b border-border py-1 text-left font-medium">
            Current
          </th>
          <th scope="col" className="border-b border-border py-1 text-left font-medium">
            Proposed
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <th scope="row" className="py-1 text-left font-normal text-ink-muted">
              {row.label}
            </th>
            <td className="py-1">{row.before}</td>
            <td className="py-1 font-medium">{row.after}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
