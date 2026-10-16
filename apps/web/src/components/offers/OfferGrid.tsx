/** Accessible grid of offer cards. */
export function OfferGrid({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <ul className="flex flex-col gap-4" aria-label={label}>
      {children}
    </ul>
  );
}
