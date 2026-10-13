/**
 * The Transactions page's amount search, typed as a short expression:
 *
 *   3.98        exactly S$3.98 (in or out)
 *   10-50       S$10 to S$50 inclusive (also "10 to 50", "10..50")
 *   >100  >=100 above, or at least
 *   <5    <=5   below, or at most
 *   ~30         roughly S$30: within 10%, never under 50 cents
 *   -3.98       a leading "-" means money out only, "+" money in only;
 *               it combines with every form above ("-10-50", "+>1000")
 *
 * "S$", "$", commas and spaces are ignored. Amounts compare by size, so the
 * sign of the stored amount only matters when a direction is given.
 */
import { parseCents } from "./money";

export interface AmountQuery {
  /** Inclusive bounds on the absolute amount, in cents. */
  minCents?: number;
  maxCents?: number;
  direction?: "out" | "in";
}

const cents = (raw: string): number | null => {
  try {
    const c = parseCents(raw);
    return c >= 0 ? c : null;
  } catch {
    return null;
  }
};

/** null when the text is not an amount expression (the caller should say so). */
export function parseAmountQuery(input: string): AmountQuery | null {
  let t = input.trim().toUpperCase().replace(/S\$|\$|,|\s+/g, "");
  if (!t) return null;

  let direction: AmountQuery["direction"];
  if (t[0] === "-" || t[0] === "+") {
    direction = t[0] === "-" ? "out" : "in";
    t = t.slice(1);
  }

  let q: AmountQuery | null = null;
  const cmp = /^(>=|<=|>|<)(.+)$/.exec(t);
  const range = /^([\d.]+)(?:-|TO|\.\.)([\d.]+)$/.exec(t);

  if (cmp) {
    const v = cents(cmp[2]);
    if (v === null) return null;
    q = {
      ">": { minCents: v + 1 },
      ">=": { minCents: v },
      "<": { maxCents: Math.max(0, v - 1) },
      "<=": { maxCents: v },
    }[cmp[1] as ">" | ">=" | "<" | "<="];
  } else if (range) {
    const a = cents(range[1]);
    const b = cents(range[2]);
    if (a === null || b === null) return null;
    q = { minCents: Math.min(a, b), maxCents: Math.max(a, b) };
  } else if (t.startsWith("~")) {
    const v = cents(t.slice(1));
    if (v === null) return null;
    const tol = Math.max(50, Math.round(v * 0.1));
    q = { minCents: Math.max(0, v - tol), maxCents: v + tol };
  } else {
    const v = cents(t);
    if (v === null) return null;
    q = { minCents: v, maxCents: v };
  }

  return direction ? { ...q, direction } : q;
}
