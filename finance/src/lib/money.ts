/**
 * Money is stored and computed as integer cents. Floats are never used for
 * ledger arithmetic: a half-cent of drift turns reconciliation into guesswork.
 */

export type Cents = number;

/** Parse a statement amount ("1,234.56", "-42.00", "(15.00)") into signed cents. */
export function parseCents(raw: string): Cents {
  const t = raw.trim();
  if (!t) throw new Error("empty amount");
  // Accountancy parentheses mean negative.
  const paren = /^\((.*)\)$/.exec(t);
  const body = paren ? paren[1] : t;
  const cleaned = body.replace(/[,\s$]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error(`unparseable amount: ${JSON.stringify(raw)}`);
  }
  const neg = paren !== null || cleaned.startsWith("-");
  const [whole, frac = ""] = cleaned.replace(/^-/, "").split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new Error(`amount out of range: ${raw}`);
  return neg ? -cents : cents;
}

/** Cents -> "1,234.56" (no currency symbol, always two decimals). */
export function formatCents(c: Cents): string {
  const neg = c < 0;
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100).toLocaleString("en-SG");
  const frac = String(abs % 100).padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** Cents -> "S$1,234.56". */
export function formatMoney(c: Cents, currency = "SGD"): string {
  const sym = currency === "SGD" ? "S$" : `${currency} `;
  const neg = c < 0;
  return `${neg ? "-" : ""}${sym}${formatCents(Math.abs(c))}`;
}

export const sumCents = (xs: Cents[]): Cents => xs.reduce((a, b) => a + b, 0);

/** A float from legacy data (transactions.csv) rounded to the nearest cent. */
export function fromFloat(n: number): Cents {
  const c = Math.round(n * 100);
  if (!Number.isSafeInteger(c)) throw new Error(`amount out of range: ${n}`);
  return c;
}
