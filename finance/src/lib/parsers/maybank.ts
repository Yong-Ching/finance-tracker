import type { PositionedRow, TextItem } from "./pdf";
import { type Parser, type RawTxn, type StatementResult, ParseError } from "./types";
import { parseCents } from "../money";

/**
 * Maybank (Malaysia) savings account statements, in ringgit.
 *
 * Unlike DBS there is a single amount column, and direction is the sign the
 * statement prints after the number: "42.10-" out, "500.00+" in. Each
 * transaction is a dated row followed by description lines, and a description
 * can carry over a page break, so the table is read across pages rather than
 * restarting on each one. The footer's TOTAL CREDIT and TOTAL DEBIT are
 * checked against the rows read.
 */

/** "1,234.56", "42.10-", "500.00+" */
const AMOUNT = /^(\d{1,3}(?:,\d{3})*\.\d{2})([+-]?)$/;
const DATE = /^(\d{2})\/(\d{2})\/(\d{2})$/;

const DATE_COLUMN_MAX = 80;
const DESC_MIN = 80;
/** The amount column starts near x=320; the balance column near x=415. */
const AMOUNT_MIN = 300;
const BALANCE_MIN = 420;

/** The column header that starts the table on every page. */
const TABLE_START = /ENTRY DATE.*TRANSACTION DESCRIPTION/i;
/** What ends the table on a page: the notes block, or the statement footer. */
const TABLE_END = /^(Perhatian|Perhation|ENDING BALANCE|TOTAL CREDIT|TOTAL DEBIT)\b/i;

/** "30/06/26" -> "2026-06-30". */
function shortDateToIso(s: string): string | null {
  const m = DATE.exec(s.trim());
  return m ? `20${m[3]}-${m[2]}-${m[1]}` : null;
}

/** A signed amount in cents; a trailing "-" is money out. */
function signedCents(item: TextItem): number | null {
  const m = AMOUNT.exec(item.str.trim());
  if (!m) return null;
  const cents = parseCents(m[1]);
  return m[2] === "-" ? -cents : cents;
}

/** The last amount on a labelled row, e.g. "ENDING BALANCE : 1,234.56". */
function labelled(rows: PositionedRow[], label: RegExp): number | null {
  const row = rows.find((r) => label.test(r.text));
  if (!row) return null;
  const amounts = row.items.map(signedCents).filter((c): c is number => c !== null);
  return amounts.length ? amounts[amounts.length - 1] : null;
}

export const maybankParser: Parser = {
  name: "maybank",
  version: "1.0.0",
  accountHint: "Maybank",

  detect(text: string): number {
    let score = 0;
    if (/Maybank Islamic Berhad|Malayan Banking Berhad/i.test(text)) score += 0.4;
    if (/ENTRY DATE.*TRANSACTION DESCRIPTION.*TRANSACTION AMOUNT/i.test(text)) score += 0.3;
    if (/BEGINNING BALANCE/i.test(text)) score += 0.2;
    if (/ENDING BALANCE/i.test(text)) score += 0.1;
    return Math.min(score, 1);
  },

  parse(rows: PositionedRow[]): StatementResult {
    const warnings: string[] = [];

    // --- statement date -----------------------------------------------------
    // The header prints it beside its label: "結單日期 : 30/06/26".
    let periodTo: string | null = null;
    for (const r of rows) {
      if (TABLE_START.test(r.text)) break;
      const d = r.items.find((i) => i.x > 400 && DATE.test(i.str.trim()));
      if (d) { periodTo = shortDateToIso(d.str); break; }
    }

    // --- opening / closing balance -----------------------------------------
    const openingBalanceCents = labelled(rows, /^BEGINNING BALANCE\b/i);
    if (openingBalanceCents === null) {
      throw new ParseError("no 'BEGINNING BALANCE' row - not a Maybank account statement");
    }
    const closingBalanceCents = labelled(rows, /^ENDING BALANCE\b/i);
    if (closingBalanceCents === null) warnings.push("no closing balance found");

    // --- transactions -------------------------------------------------------
    const txns: RawTxn[] = [];
    let current: { date: string; parts: string[]; amount: number; balance: number | null } | null = null;

    const flush = () => {
      if (!current) return;
      txns.push({
        txnDate: current.date,
        descriptionRaw: current.parts.join(" ").replace(/\s+/g, " ").trim(),
        amountCents: current.amount,
        balanceAfterCents: current.balance ?? undefined,
      });
      current = null;
    };

    let inTable = false;
    let page = 0;
    for (const row of rows) {
      // A new page starts in its header; the table resumes after the column titles.
      if (row.page !== page) { page = row.page; inTable = false; }
      if (TABLE_START.test(row.text)) { inTable = true; continue; }
      if (!inTable) continue;
      // Not a flush: the last transaction's description may go on overleaf.
      if (TABLE_END.test(row.text)) { inTable = false; continue; }
      if (/^BEGINNING BALANCE\b/i.test(row.text)) continue;

      const first = row.items[0];
      const date = first && first.x <= DATE_COLUMN_MAX ? shortDateToIso(first.str) : null;

      if (date) {
        flush();
        const amountItem = row.items.find((i) => i.x >= AMOUNT_MIN && i.x < BALANCE_MIN && AMOUNT.test(i.str.trim()));
        const balanceItem = row.items.find((i) => i.x >= BALANCE_MIN && AMOUNT.test(i.str.trim()));
        const amount = amountItem ? signedCents(amountItem) : null;
        if (amount === null || !/[+-]$/.test(amountItem!.str.trim())) {
          throw new ParseError(`row on ${date} has no signed amount: ${row.text.slice(0, 80)}`);
        }
        current = {
          date,
          parts: row.items.filter((i) => i.x >= DESC_MIN && i.x < AMOUNT_MIN).map((i) => i.str),
          amount,
          balance: balanceItem ? signedCents(balanceItem) : null,
        };
        continue;
      }

      // A continuation line: description text only, possibly on the next page.
      const cont = row.items.filter((i) => i.x >= DESC_MIN && i.x < AMOUNT_MIN);
      if (current && cont.length && cont.length === row.items.length) {
        current.parts.push(...cont.map((i) => i.str));
      } else if (row.items.some((i) => AMOUNT.test(i.str.trim()))) {
        warnings.push(`unread row with an amount: ${row.text.slice(0, 80)}`);
      }
    }
    flush();

    // --- the statement's own totals ------------------------------------------
    const credit = labelled(rows, /^TOTAL CREDIT\b/i);
    const debit = labelled(rows, /^TOTAL DEBIT\b/i);
    const readCredit = txns.filter((t) => t.amountCents > 0).reduce((a, t) => a + t.amountCents, 0);
    const readDebit = -txns.filter((t) => t.amountCents < 0).reduce((a, t) => a + t.amountCents, 0);
    if (credit !== null && credit !== readCredit) {
      warnings.push(`TOTAL CREDIT is ${credit} cents but the rows add up to ${readCredit}`);
    }
    if (debit !== null && debit !== readDebit) {
      warnings.push(`TOTAL DEBIT is ${debit} cents but the rows add up to ${readDebit}`);
    }

    return {
      accountHint: "Maybank",
      periodFrom: txns.length ? txns[0].txnDate : periodTo,
      periodTo,
      openingBalanceCents,
      closingBalanceCents,
      transactions: txns,
      warnings,
    };
  },
};
