/**
 * Showing the app in one currency. Display only: amounts are stored in their
 * account's own currency and never rewritten. In the "original" view nothing is
 * converted and currencies are kept apart, as everywhere else in the app; in a
 * currency view every amount is converted at the latest rate - a rough figure,
 * marked as such - so SGD and MYR accounts can be added up.
 *
 * Pure and serialisable, so client components can convert rows themselves.
 */
import { formatCents, formatMoney, formatInColumn, type Cents } from "./money";

export const BASE_CURRENCY = "SGD";
export const ORIGINAL = "original";

export interface Fx {
  /** "original", or the currency everything is shown in. */
  mode: string;
  /** Units of each currency per 1 SGD; SGD itself is 1. */
  perBase: Record<string, number>;
  /** The date the rates were published. */
  asOf: string | null;
  /** The currencies the accounts hold - the views on offer. */
  currencies: string[];
  /** A currency view was asked for but no rate could be had: showing original instead. */
  unavailable?: string;
}

export const ORIGINAL_FX: Fx = { mode: ORIGINAL, perBase: { [BASE_CURRENCY]: 1 }, asOf: null, currencies: [BASE_CURRENCY] };

export const converting = (fx?: Fx | null): fx is Fx => !!fx && fx.mode !== ORIGINAL;

/** The currency a combined total is in: the base one, or the chosen view's. */
export const totalCurrency = (fx?: Fx | null) => (converting(fx) ? fx.mode : BASE_CURRENCY);

/** What one unit of `from` is worth in the view's currency; 1 when not converting. */
export function factor(from: string, fx?: Fx | null): number {
  if (!converting(fx) || from === fx.mode) return 1;
  const a = fx.perBase[from];
  const b = fx.perBase[fx.mode];
  if (!a || !b) throw new Error(`no rate for ${from} -> ${fx.mode}`);
  return b / a;
}

export interface Shown {
  cents: Cents;
  currency: string;
  /** Converted at today's rate, so only roughly what it was. */
  approx: boolean;
}

export function convert(cents: Cents, from: string, fx?: Fx | null): Shown {
  if (!converting(fx) || from === fx.mode) return { cents, currency: from, approx: false };
  return { cents: Math.round(cents * factor(from, fx)), currency: fx.mode, approx: true };
}

/** "S$12.00", or "≈RM38.34" for a converted figure. */
export function money(cents: Cents, from: string, fx?: Fx | null): string {
  const v = convert(cents, from, fx);
  return `${v.approx ? "≈" : ""}${formatMoney(v.cents, v.currency)}`;
}

/**
 * For a column of amounts. Original view: bare for SGD, marked otherwise.
 * Currency view: bare in the view's currency, "≈" for a converted one.
 */
export function moneyInColumn(cents: Cents, from: string, fx?: Fx | null): string {
  if (!converting(fx)) return formatInColumn(cents, from);
  const v = convert(cents, from, fx);
  return `${v.approx ? "≈" : ""}${formatCents(v.cents)}`;
}

/** The original amount, for a tooltip on a converted one; undefined when nothing was converted. */
export function originalTitle(cents: Cents, from: string, fx?: Fx | null): string | undefined {
  return convert(cents, from, fx).approx ? `${formatMoney(cents, from)} at the latest rate` : undefined;
}

/** "1 SGD = 3.1951 MYR" for each other currency held. */
export function rateLine(fx: Fx): string {
  return fx.currencies
    .filter((c) => c !== BASE_CURRENCY && fx.perBase[c])
    .map((c) => `1 ${BASE_CURRENCY} = ${fx.perBase[c]} ${c}`)
    .join(" · ");
}
