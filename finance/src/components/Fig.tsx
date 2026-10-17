/**
 * A money figure the dashboard's eye toggle can mask. While figures are hidden,
 * CSS swaps the inner text for asterisks; doing it in CSS means the real value
 * never paints, even before hydration.
 */
export function Fig({ children }: { children: React.ReactNode }) {
  return <span className="fig"><span>{children}</span></span>;
}
