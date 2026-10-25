import type { PositionedRow, TextItem } from "./pdf";
import { type RawTxn, type StatementResult, ParseError } from "./types";

/**
 * A statement reader that knows no bank.
 *
 * It finds the transaction table by its header row (a date column and at least
 * one money column: withdrawal/deposit, debit/credit, money out/in, amount,
 * balance), takes each column's position from where its header sits, and reads
 * every dated row below it. Direction comes, in order of trust, from the column
 * an amount sits in, from a sign or marker printed with it ("-", "+", "CR",
 * "DR", parentheses), and failing both from the running balance moving.
 *
 * Nothing here is trusted on its own: the caller's continuity gate (opening
 * balance + every row = closing balance) is what decides whether a read is
 * right. A wrong guess about a column almost never reconciles.
 */

type Role = "out" | "in" | "amount" | "balance";

interface Column {
  role: Role;
  left: number;
  right: number;
}

interface Layout {
  /** The header's text: a header that reads differently starts another section. */
  signature: string;
  dateX: number;
  /** Description text sits between the date column and the first money column. */
  descLeft: number;
  descRight: number;
  /** Where each text column under the header starts, left to right. */
  descCols: number[];
  /** The right edge of the last column. */
  right: number;
  columns: Column[];
}

const DATE_HEADER = /^(?:(?:txn|trans(?:action)?|entry|posting|post|value|completed|booking)\.?\s+)?date\b/i;
const HEADERS: Array<[Role, RegExp]> = [
  ["balance", /\bbalance\b/i],
  ["out", /\b(withdrawals?|debits?|money out|paid out|payments?|out)\b/i],
  ["in", /\b(deposits?|credits?|money in|paid in|receipts?|in)\b/i],
  ["amount", /\bamount\b/i],
];

/** Money as statements print it: S$1,234.56, RM 12.00, (15.63), 42.10-, 500.00 CR. */
const MONEY = /^(?:[A-Z]{3}\s?|RM\s?|S?\$\s?)?(\(?)(-?)(?:S?\$)?(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})(\)?)\s?([+-]|CR|DR)?$/i;

interface Money {
  cents: number;
  /** -1 or +1 when the statement printed a direction with the number. */
  marked: -1 | 1 | 0;
  /** Parentheses, which mean a credit on a card. */
  paren: boolean;
}

function readMoney(s: string): Money | null {
  const m = MONEY.exec(s.trim());
  if (!m) return null;
  const cents = Number(m[3].replace(/,/g, "")) * 100 + Number(m[4]);
  const paren = !!m[1] && !!m[5];
  const suffix = (m[6] ?? "").toUpperCase();
  const marked = m[2] === "-" || suffix === "-" || suffix === "DR" ? -1
    : suffix === "+" || suffix === "CR" ? 1 : 0;
  return { cents, marked, paren };
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

interface DateParts { y: number | null; a: number; b: number; named: boolean }

/** A date in any common form; `a`/`b` are day/month in an order resolved later. */
function readDate(s: string): DateParts | null {
  const t = s.trim().replace(/,/g, "");
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return { y: +m[1], a: +m[3], b: +m[2], named: true };
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t);
  if (m) return { y: m[3].length === 2 ? 2000 + +m[3] : +m[3], a: +m[1], b: +m[2], named: false };
  m = /^(\d{1,2})[\s-]([A-Za-z]{3,9})\.?(?:[\s-](\d{2}|\d{4}))?$/.exec(t);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null;
    return { y, a: +m[1], b: MONTHS[m[2].slice(0, 3).toLowerCase()], named: true };
  }
  m = /^([A-Za-z]{3,9})\.?\s(\d{1,2})(?:\s(\d{4}))?$/.exec(t);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) {
    return { y: m[3] ? +m[3] : null, a: +m[2], b: MONTHS[m[1].slice(0, 3).toLowerCase()], named: true };
  }
  return null;
}

const OPENING = /\b(opening balance|beginning balance|balance brought forward|brought forward|balance b\/?f|previous (statement )?balance|balance previous statement|last statement balance)\b/i;
const CLOSING = /\b(closing balance|ending balance|balance carried forward|carried forward|balance c\/?f|new balance|grand total|statement balance)\b/i;
/** Summary lines: only when they lead the row, so "BUS TOTAL FARE" is still a purchase. */
const STOP = /^(sub-?total|total)\b|\bpage \d+ of \d+\b/i;

function headerLayout(row: PositionedRow): Layout | null {
  const date = row.items.find((i) => DATE_HEADER.test(i.str.trim()));
  if (!date) return null;
  const columns: Column[] = [];
  for (const it of row.items) {
    if (it === date || it.x < date.x) continue;
    const hits = HEADERS.filter(([, re]) => re.test(it.str));
    if (hits.length !== 1) continue;
    columns.push({ role: hits[0][0], left: it.x, right: it.x + it.width });
  }
  if (!columns.some((c) => c.role !== "balance")) return null;
  // A lone "in"/"out" word is too weak without its partner.
  const roles = new Set(columns.map((c) => c.role));
  if ((roles.has("in") !== roles.has("out")) && !roles.has("amount")) {
    const lone = roles.has("in") ? "in" : "out";
    // "Credit"/"Debit" alone is how some cards title their one amount column.
    for (const c of columns) if (c.role === lone) c.role = "amount";
  }
  const firstMoney = Math.min(...columns.map((c) => c.left));
  const descLeft = date.x + date.width + 2;
  const descRight = firstMoney - 4;
  const descCols = row.items.filter((i) => i !== date && i.x >= descLeft - 2 && i.x < descRight).map((i) => i.x);
  return {
    signature: row.text, dateX: date.x, descLeft, descRight,
    descCols: descCols.length ? descCols : [descLeft],
    right: Math.max(...columns.map((c) => c.right)),
    columns,
  };
}

/** The column an amount belongs to: the one it overlaps most, else the nearest. */
function columnOf(it: TextItem, layout: Layout): Column | null {
  const l = it.x, r = it.x + it.width, c = (l + r) / 2;
  if (r < layout.descRight) return null;
  let best: Column | null = null;
  let bestScore = Infinity;
  for (const col of layout.columns) {
    const gap = Math.max(0, col.left - r, l - col.right);
    const score = gap * 1000 + Math.abs((col.left + col.right) / 2 - c);
    if (score < bestScore) { bestScore = score; best = col; }
  }
  return best;
}

/** The last amount printed on a labelled row (opening / closing balance lines). */
function labelledAmount(row: PositionedRow): Money | null {
  const amounts = row.items.map((i) => readMoney(i.str)).filter((m): m is Money => m !== null);
  return amounts.length ? amounts[amounts.length - 1] : null;
}

/** One line of description text, kept with its position. */
interface Line { y: number; page: number; items: TextItem[] }

interface Draft {
  date: DateParts;
  items: TextItem[];
  amounts: Partial<Record<Role, Money>>;
  lastY: number;
  page: number;
  /** Description-only lines after it, which may lead the next transaction instead. */
  pending: Line[];
  /** Past a gap or a footer: take no more lines until the table resumes overleaf. */
  suspended: boolean;
}

function settle(d: Draft) {
  for (const l of d.pending) d.items.push(...l.items);
  const last = d.pending[d.pending.length - 1];
  if (last) { d.lastY = last.y; d.page = last.page; }
  d.pending = [];
}

/**
 * The description, column by column: a cell wrapped over several lines is read
 * whole before the next column starts, so wrapped references and names stay
 * together instead of interleaving.
 */
function describe(items: TextItem[], layout: Layout): string {
  const cols = layout.descCols;
  const bucket = (it: TextItem) => {
    let k = 0;
    for (let i = 0; i < cols.length; i++) if (it.x >= cols[i] - 8) k = i;
    return k;
  };
  const parts: string[][] = cols.map(() => []);
  for (const it of items) parts[bucket(it)].push(it.str);
  return parts.map((p) => p.join(" ")).join(" ").replace(/\s+/g, " ").trim();
}

export function parseGeneric(rows: PositionedRow[]): StatementResult {
  const warnings: string[] = [];

  // --- the reference year, for dates printed without one ------------------------
  const fullDates = rows.flatMap((r) => r.items.map((i) => readDate(i.str))).filter((d): d is DateParts => !!d && d.y !== null);

  // Day-first unless the document says otherwise (a second part over 12).
  const unnamed = fullDates.filter((d) => !d.named);
  const monthFirst = unnamed.some((d) => d.b > 12) && !unnamed.some((d) => d.a > 12);
  const iso = (d: DateParts, refYear: number, refMonth: number): string => {
    const [day, month] = !d.named && monthFirst ? [d.b, d.a] : [d.a, d.b];
    const year = d.y ?? (month > refMonth ? refYear - 1 : refYear);
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  };
  const latest = fullDates.map((d) => iso(d, 0, 12)).sort().pop();
  const refYear = latest ? +latest.slice(0, 4) : new Date().getFullYear();
  const refMonth = latest ? +latest.slice(5, 7) : 12;

  // Pages that repeat the table header: above it is the page's own letterhead.
  // Only the first table's header counts: another section's starts below rows that are still ours.
  const headerAt = new Map<number, number>();
  let first: string | null = null;
  for (const r of rows) {
    const h = headerLayout(r);
    if (!h) continue;
    first ??= h.signature;
    if (h.signature === first && !headerAt.has(r.page)) headerAt.set(r.page, r.y);
  }

  // --- the table ------------------------------------------------------------------
  let layout: Layout | null = null;
  let lineGap = 12;
  let opening: Money | null = null;
  let closing: Money | null = null;
  const drafts: Array<{ draft: Draft; layout: Layout }> = [];
  let current: Draft | null = null;
  /** Description lines belonging to no transaction yet: they may lead the next. */
  let loose: Line[] = [];
  const flush = () => {
    if (current) { settle(current); drafts.push({ draft: current, layout: layout! }); }
    current = null;
    loose = [];
  };
  const suspend = () => {
    if (current) { settle(current); current.suspended = true; }
    loose = [];
  };

  for (const row of rows) {
    const top = headerAt.get(row.page);
    if (top !== undefined && row.y > top) continue; // letterhead above a repeated header

    const header = headerLayout(row);
    if (header) {
      if (layout && header.signature !== layout.signature) {
        flush();
        warnings.push(`another section follows ("${header.signature.slice(0, 60)}"); only the first was read`);
        break;
      }
      // The same header again (a new page): the transaction above may carry on.
      if (current) current.suspended = false;
      loose = [];
      layout = header;
      lineGap = Math.max(8, ...row.items.map((i) => i.height * 1.6));
      continue;
    }

    // Balance lines can sit above the first header (a summary) or in the table.
    if (OPENING.test(row.text)) {
      flush();
      opening ??= labelledAmount(row);
      continue;
    }
    if (CLOSING.test(row.text)) {
      flush();
      closing = labelledAmount(row) ?? closing;
      continue;
    }
    if (!layout) continue;
    if (STOP.test(row.text)) { flush(); continue; }

    const L: Layout = layout;
    const dateText = row.items.filter((i) => i.x < L.descLeft - 2).map((i) => i.str).join(" ");
    const date = readDate(dateText) ?? readDate(row.items[0]?.str ?? "");
    const amounts: Partial<Record<Role, Money>> = {};
    const desc: TextItem[] = [];
    for (const it of row.items) {
      const money = readMoney(it.str);
      const col = money ? columnOf(it, L) : null;
      if (money && col) { amounts[col.role] ??= money; continue; }
      if (it.x >= L.descLeft - 2 && it.x < L.descRight) desc.push(it);
    }
    const outside = row.items.some((i) => i.x < L.dateX - 10 || i.x + i.width > L.right + 40);

    if (date) {
      // Lines nearer this date than the line above them lead this transaction
      // (some statements print the merchant above the date).
      const leading: Line[] = [];
      const near = (l: Line, below: { y: number; page: number }) => l.page === below.page && l.y - below.y <= lineGap * 2;
      if (current && !current.suspended) {
        const p = current.pending;
        while (p.length) {
          const l = p[p.length - 1];
          const above = p.length > 1 ? p[p.length - 2] : { y: current.lastY, page: current.page };
          if (l.page !== row.page || above.page !== l.page || (l.y - row.y) >= (above.y - l.y) * 0.75) break;
          leading.unshift(p.pop()!);
        }
      } else {
        let below = { y: row.y, page: row.page };
        for (let i = loose.length - 1; i >= 0 && near(loose[i], below); i--) {
          leading.unshift(loose[i]);
          below = loose[i];
        }
      }
      flush();
      current = {
        date, items: [...leading.flatMap((l) => l.items), ...desc], amounts,
        lastY: row.y, page: row.page, pending: [], suspended: false,
      };
      continue;
    }

    const line: Line = { y: row.y, page: row.page, items: desc };
    const hasMoney = Object.keys(amounts).length > 0;
    if (outside) { suspend(); continue; }

    if (!current || current.suspended) {
      // Overleaf, before any new date: the description carries on.
      if (current && current.suspended && row.page !== current.page && !hasMoney && desc.length) {
        current.suspended = false;
        current.items.push(...desc);
        current.lastY = row.y;
        current.page = row.page;
        continue;
      }
      if (!hasMoney && desc.length) {
        const prev = loose[loose.length - 1];
        if (prev && (prev.page !== row.page || prev.y - row.y > lineGap * 2)) loose = [];
        loose.push(line);
      } else loose = [];
      continue;
    }

    // A continuation: more description, or the amounts printed a line lower.
    const lastY = current.pending.length ? current.pending[current.pending.length - 1].y : current.lastY;
    const lastPage = current.pending.length ? current.pending[current.pending.length - 1].page : current.page;
    if (row.page === lastPage && lastY - row.y > lineGap * 2) {
      suspend();
      if (!hasMoney && desc.length) loose = [line];
      continue;
    }
    if (!hasMoney) {
      if (desc.length) current.pending.push(line);
      continue;
    }
    settle(current);
    current.items.push(...desc);
    for (const [role, m] of Object.entries(amounts) as Array<[Role, Money]>) current.amounts[role] ??= m;
    current.lastY = row.y;
    current.page = row.page;
  }
  flush();

  if (!layout) throw new ParseError("no transaction table found (no header row with a date and an amount column)");

  // --- direction --------------------------------------------------------------
  const hasBalance = drafts.some(({ draft }) => draft.amounts.balance);
  const card = !hasBalance && !layout.columns.some((c) => c.role === "in");
  // A card's balance is money owed, so it is negative in a signed ledger.
  const signed = (m: Money | null) => (m === null ? null : card ? -m.cents : m.marked < 0 ? -m.cents : m.cents);
  const txns: RawTxn[] = [];
  let prevBalance = signed(opening);

  for (const { draft: d, layout: dl } of drafts) {
    const a = d.amounts;
    const balance = a.balance ? (a.balance.marked < 0 ? -a.balance.cents : a.balance.cents) : undefined;
    let cents: number | null = null;
    if (a.out && !a.in) cents = -a.out.cents;
    else if (a.in && !a.out) cents = a.in.cents;
    else if (a.amount) {
      const m = a.amount;
      if (card) cents = m.paren || m.marked > 0 ? m.cents : -m.cents;
      else if (m.marked) cents = m.marked * m.cents;
      else if (m.paren) cents = -m.cents;
      else if (balance !== undefined && prevBalance !== null) {
        if (balance === prevBalance && m.cents !== 0) {
          // The balance did not move: a failed or pending attempt, not money.
          warnings.push(`skipped a row on ${iso(d.date, refYear, refMonth)}: the balance did not move`);
          continue;
        }
        cents = balance - prevBalance === -m.cents ? -m.cents : m.cents;
        if (Math.abs(balance - prevBalance) !== m.cents) warnings.push(`direction unclear on ${iso(d.date, refYear, refMonth)}`);
      } else if (balance !== undefined) {
        // No opening balance to go from. An amount equal to the balance after it
        // came in from nothing; one larger than it can only have gone out of more.
        cents = balance === m.cents ? m.cents : -m.cents;
        warnings.push(`direction of the first row inferred from its balance (${iso(d.date, refYear, refMonth)})`);
      } else {
        cents = -m.cents;
        warnings.push(`direction assumed (money out) on ${iso(d.date, refYear, refMonth)}`);
      }
    }
    if (cents === null) {
      if (!a.balance) continue; // a dated line with no money: not a transaction
      warnings.push(`no amount on ${iso(d.date, refYear, refMonth)}`);
      continue;
    }
    if (a.out && a.in) warnings.push(`amounts in both columns on ${iso(d.date, refYear, refMonth)}`);
    txns.push({
      txnDate: iso(d.date, refYear, refMonth),
      descriptionRaw: describe(d.items, dl),
      amountCents: cents,
      balanceAfterCents: balance,
    });
    if (balance !== undefined) prevBalance = balance;
  }

  // --- opening and closing ------------------------------------------------------
  let openingBalanceCents = signed(opening);
  let closingBalanceCents = signed(closing);
  const withBalance = txns.filter((t) => t.balanceAfterCents !== undefined);
  if (openingBalanceCents === null && withBalance.length && txns[0].balanceAfterCents !== undefined) {
    openingBalanceCents = txns[0].balanceAfterCents - txns[0].amountCents;
    warnings.push("no opening balance printed; taken from the first row's balance");
  }
  if (closingBalanceCents === null && withBalance.length) {
    closingBalanceCents = withBalance[withBalance.length - 1].balanceAfterCents!;
  }

  // Every printed running balance should follow from the one before it.
  let run = openingBalanceCents;
  for (const t of txns) {
    if (run !== null) run += t.amountCents;
    if (t.balanceAfterCents !== undefined) {
      if (run !== null && run !== t.balanceAfterCents) warnings.push(`balance chain breaks on ${t.txnDate}`);
      run = t.balanceAfterCents;
    }
  }

  const dates = txns.map((t) => t.txnDate).sort();
  return {
    accountHint: "",
    periodFrom: dates[0] ?? null,
    periodTo: dates[dates.length - 1] ?? null,
    openingBalanceCents,
    closingBalanceCents,
    transactions: txns,
    warnings,
  };
}
