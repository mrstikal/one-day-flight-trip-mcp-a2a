/** Currency formatting for EUR minor units (server sends minor units only). */
export function formatEuroMinor(minor: number): string {
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  }).format(minor / 100);
}
