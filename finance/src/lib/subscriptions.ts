/**
 * Subscriptions: matching tracked ones to their charges, judging whether each is
 * still running, and proposing new ones from repeating outflows.
 *
 * Pure functions over plain rows - no database - so the rules can be tested on
 * synthetic data. Detection only ever PROPOSES; a candidate becomes a
 * subscription when the user tracks it.
 */
import type { SubscriptionCadence } from "@/db/schema";

export interface ChargeRow {
  id: number;
  accountId: number;
  txnDate: string; // yyyy-mm-dd
  amountCents: number; // signed; outflows are negative
  descriptionRaw: string;
  categoryName?: string | null;
  /** The statement the charge was read from - the bill it can be traced to. */
  statementId?: number | null;
}

export interface TrackedLike {
  pattern: string;
  accountId: number | null;
  amountCents: number;
  /** A bill that differs every cycle: matched on description and account alone. */
  variableAmount?: boolean;
}

/* --------------------------------------------------------------- matching */

/**
 * Upper-cased, with reference numbers and digit runs removed. A statement line
 * carries a fresh reference on every charge (PAYNOW TRANSFER 1234567, QR codes),
 * so matching must look past them. Patterns go through the same function, so a
 * pattern typed by hand and a description always compare like for like.
 */
export function normalise(text: string): string {
  return text
    .toUpperCase()
    .replace(/\b(?=[A-Z0-9]*\d)[A-Z0-9]{5,}\b/g, " ")
    .replace(/\d+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The part of a statement line that names who was paid. DBS puts a PayNow payee
 * after "TO:" and a GIRO payee after "via GIRO"; card lines lead with the
 * merchant and trail a location after a comma.
 */
export function merchantKey(description: string): string {
  const d = description.toUpperCase();
  let m = d;
  const to = d.match(/\bTO:\s*(.+?)(?:\s+PAYNOW\b|$)/);
  const giro = d.match(/\bVIA GIRO\s+(.+)$/);
  if (to) m = to[1];
  else if (giro) m = giro[1];
  else m = d.split(/,|\s{2,}/)[0];
  return normalise(m).split(" ").slice(0, 4).join(" ");
}

/** Charges vary a little (FX, tax rounding): within 10%, and never under 50 cents. */
export function amountMatches(chargeCents: number, expectedCents: number): boolean {
  const a = Math.abs(chargeCents);
  return Math.abs(a - expectedCents) <= Math.max(50, Math.round(expectedCents * 0.1));
}

export function matches(charge: ChargeRow, sub: TrackedLike): boolean {
  if (charge.amountCents >= 0) return false;
  if (sub.accountId !== null && charge.accountId !== sub.accountId) return false;
  const pattern = normalise(sub.pattern);
  if (!pattern || !normalise(charge.descriptionRaw).includes(pattern)) return false;
  return sub.variableAmount || amountMatches(charge.amountCents, sub.amountCents);
}

/* ---------------------------------------------------------------- cadence */

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const CADENCE_DAYS: Record<SubscriptionCadence, number> = {
  weekly: 7,
  monthly: 30.44,
  quarterly: 91.31,
  yearly: 365.25,
};

/**
 * What a variable bill is expected to cost: the median of its last six charges,
 * or the estimate on record before any are seen. A fixed one costs its amount.
 */
export function typicalCents(sub: TrackedLike, charges: ChargeRow[]): number {
  if (!sub.variableAmount || !charges.length) return sub.amountCents;
  const recent = [...charges].sort((a, b) => a.txnDate.localeCompare(b.txnDate)).slice(-6);
  return median(recent.map((c) => Math.abs(c.amountCents)));
}

/** What a charge costs per month, so different cadences can be summed. */
export function monthlyCents(amountCents: number, cadence: SubscriptionCadence): number {
  const perMonth = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 }[cadence];
  return Math.round(amountCents * perMonth);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}

function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  // Clamp the 31st to the month's last day rather than spilling into the next.
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

export function nextDue(lastIso: string, cadence: SubscriptionCadence): string {
  if (cadence === "weekly") return addDays(lastIso, 7);
  return addMonths(lastIso, { monthly: 1, quarterly: 3, yearly: 12 }[cadence]);
}

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/* ----------------------------------------------------------------- status */

export type SubscriptionHealth =
  | { kind: "no_charges" }
  | { kind: "on_track" }
  | { kind: "price_changed"; nowCents: number }
  | { kind: "overdue"; daysLate: number };

export interface SubscriptionState {
  charges: ChargeRow[]; // oldest first
  lastCharge: ChargeRow | null;
  nextDue: string | null;
  health: SubscriptionHealth;
}

/**
 * `asOf` is the end of the latest statement for the account the charges come
 * from - not today. Between statements nothing new can be seen, so judging
 * against the calendar would flag every subscription as late.
 */
export function assess(
  sub: TrackedLike & { cadence: SubscriptionCadence },
  all: ChargeRow[],
  asOf: string | null,
): SubscriptionState {
  const charges = all.filter((c) => matches(c, sub)).sort((a, b) => a.txnDate.localeCompare(b.txnDate));
  const lastCharge = charges.at(-1) ?? null;
  if (!lastCharge) return { charges, lastCharge, nextDue: null, health: { kind: "no_charges" } };

  const due = nextDue(lastCharge.txnDate, sub.cadence);
  const grace = Math.max(7, Math.round(CADENCE_DAYS[sub.cadence] * 0.25));
  const late = asOf ? daysBetween(due, asOf) : 0;
  let health: SubscriptionHealth = { kind: "on_track" };
  if (late > grace) health = { kind: "overdue", daysLate: late };
  else if (!sub.variableAmount && Math.abs(lastCharge.amountCents) !== sub.amountCents) {
    health = { kind: "price_changed", nowCents: Math.abs(lastCharge.amountCents) };
  }
  return { charges, lastCharge, nextDue: due, health };
}

/* --------------------------------------------------------------- timeline */

export type TimelineEntry =
  | { kind: "charge"; charge: ChargeRow }
  | { kind: "missed"; due: string };

/**
 * The charge history with its gaps made visible: a cycle that passed (by more
 * than the grace period) with no charge becomes a "missed" entry, including any
 * after the last charge up to the statement end. Oldest first.
 */
export function timeline(
  charges: ChargeRow[],
  cadence: SubscriptionCadence,
  asOf: string | null,
): TimelineEntry[] {
  const sorted = [...charges].sort((a, b) => a.txnDate.localeCompare(b.txnDate));
  const grace = Math.max(7, Math.round(CADENCE_DAYS[cadence] * 0.25));
  const out: TimelineEntry[] = [];
  // Between two charges: a due date was skipped only if the later charge lands
  // near or after the NEXT due date - a late charge still pays its own cycle.
  const gapsBefore = (from: string, chargeDate: string) => {
    let due = nextDue(from, cadence);
    while (daysBetween(nextDue(due, cadence), chargeDate) >= -grace) {
      out.push({ kind: "missed", due });
      due = nextDue(due, cadence);
    }
  };
  // After the last charge: a due date is missed once it is past by more than
  // the grace period at the statement end.
  const gapsAfter = (from: string, end: string) => {
    let due = nextDue(from, cadence);
    while (daysBetween(due, end) > grace) {
      out.push({ kind: "missed", due });
      due = nextDue(due, cadence);
    }
  };
  sorted.forEach((c, i) => {
    if (i > 0) gapsBefore(sorted[i - 1].txnDate, c.txnDate);
    out.push({ kind: "charge", charge: c });
  });
  if (sorted.length && asOf) gapsAfter(sorted.at(-1)!.txnDate, asOf);
  return out;
}

/* -------------------------------------------------------------- detection */

export interface Candidate {
  pattern: string;
  accountId: number;
  amountCents: number; // median charge, positive
  /** The amount differs from charge to charge (a utility bill), so match any. */
  variableAmount: boolean;
  cadence: SubscriptionCadence;
  count: number;
  firstDate: string;
  lastDate: string;
  categoryName: string | null;
  /** The charges the suggestion rests on, oldest first, so it can be checked. */
  charges: ChargeRow[];
}

/** Median gap between charges that reads as each cadence. Yearly needs years of data. */
const WINDOWS: Array<[SubscriptionCadence, number, number]> = [
  ["weekly", 6, 8],
  ["monthly", 26, 35],
  ["quarterly", 85, 100],
];


/**
 * Repeating outflows that look like a subscription: the same merchant on the
 * same account, at least three charges in three different months (or weeks), a
 * typical gap that fits a cadence, a charge in at least three of every four
 * cycles, and still running as of the account's latest statement. A steady
 * amount makes a fixed plan; one merchant can carry several, split by amount.
 * A merchant charged monthly, at least four times, that never settles on an
 * amount (a utility bill) is proposed once, as a variable bill. Anything already tracked
 * - or dismissed - is left out, so a dismissal is permanent.
 */
export function detectCandidates(
  charges: ChargeRow[],
  known: TrackedLike[],
  asOfByAccount: Map<number, string>,
): Candidate[] {
  const groups = new Map<string, ChargeRow[]>();
  for (const c of charges) {
    if (c.amountCents >= 0) continue;
    const key = merchantKey(c.descriptionRaw);
    if (!key) continue;
    const g = `${c.accountId}|${key}`;
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }

  const out: Candidate[] = [];
  for (const [g, rows] of groups) {
    const [accountIdStr, pattern] = [g.slice(0, g.indexOf("|")), g.slice(g.indexOf("|") + 1)];
    const accountId = Number(accountIdStr);
    const asOf = asOfByAccount.get(accountId);
    const sorted = [...rows].sort((a, b) => a.txnDate.localeCompare(b.txnDate));

    /** The candidate a run of charges makes, or null if it does not repeat like a plan. */
    const propose = (cl: ChargeRow[], variableAmount: boolean): Candidate | null => {
      if (cl.length < 3) return null;
      const gaps = cl.slice(1).map((r, i) => daysBetween(cl[i].txnDate, r.txnDate));
      const gap = median(gaps);
      const fit = WINDOWS.find(([, lo, hi]) => gap >= lo && gap <= hi);
      if (!fit) return null;
      const cadence = fit[0];

      const periods = new Set(
        cl.map((r) => (cadence === "weekly" ? Math.floor(Date.parse(r.txnDate) / 6.048e8) : r.txnDate.slice(0, 7))),
      );
      if (periods.size < 3) return null;

      // A subscription charges every cycle. Habits (a weekly bakery visit that
      // happens one week in three) have a plausible median gap but gaps in
      // coverage. Even spacing is NOT required: real plans drift by weeks.
      const cycles = Math.round(daysBetween(cl[0].txnDate, cl.at(-1)!.txnDate) / CADENCE_DAYS[cadence]) + 1;
      if (periods.size / cycles < 0.75) return null;
      // With no amount to tell them apart, a shop visited now and then looks
      // like a bill. Bills are monthly, come once a cycle, and need more proof.
      if (variableAmount && (cadence !== "monthly" || cl.length < 4 || cl.length > cycles + 1)) return null;

      const amountCents = median(cl.map((r) => Math.abs(r.amountCents)));
      const last = cl.at(-1)!;
      const grace = Math.max(7, Math.round(CADENCE_DAYS[cadence] * 0.25));
      if (asOf && daysBetween(nextDue(last.txnDate, cadence), asOf) > grace) return null; // lapsed

      const cats = cl.map((r) => r.categoryName).filter(Boolean) as string[];
      const categoryName = cats.length
        ? [...new Set(cats)].sort((a, b) => cats.filter((x) => x === b).length - cats.filter((x) => x === a).length)[0]
        : null;

      return {
        pattern, accountId, amountCents, variableAmount, cadence,
        count: cl.length, firstDate: cl[0].txnDate, lastDate: last.txnDate, categoryName,
        charges: cl,
      };
    };

    // Split one merchant into its separate plans by amount.
    const clusters: ChargeRow[][] = [];
    for (const r of sorted) {
      const home = clusters.find((cl) => amountMatches(r.amountCents, Math.abs(cl[0].amountCents)));
      if (home) home.push(r);
      else clusters.push([r]);
    }
    let found = clusters.map((cl) => propose(cl, false)).filter((c): c is Candidate => !!c);
    // No steady amount, but a steady rhythm: one bill whose amount moves.
    if (!found.length && clusters.length > 1) found = [propose(sorted, true)].filter((c): c is Candidate => !!c);

    const isKnown = (c: Candidate) => known.some((k) => matches({ ...c.charges.at(-1)!, amountCents: -c.amountCents }, k));
    out.push(...found.filter((c) => !isKnown(c)));
  }
  return out.sort((a, b) => monthlyCents(b.amountCents, b.cadence) - monthlyCents(a.amountCents, a.cadence));
}

/** "APPLE.COM/BILL" -> "Apple.com/bill": a starting point the user can rename. */
export function suggestName(pattern: string): string {
  return pattern.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}
