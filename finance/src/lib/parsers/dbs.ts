import type { PositionedRow, TextItem } from "./pdf";
import {
  type Parser,
  type RawTxn,
  type StatementResult,
  ParseError,
  slashDateToIso,
  textDateToIso,
} from "./types";
import { parseCents } from "../money";

const AMOUNT = /^\d{1,3}(,\d{3})*\.\d{2}$/;

/** Column x-positions on the DBS transaction table, read from its header row. */
interface Columns {
  withdrawal: number;
  deposit: number;
  balance: number;
}

const DEFAULT_COLUMNS: Columns = { withdrawal: 338, deposit: 430, balance: 515 };

function readColumns(rows: PositionedRow[]): Columns {
  for (const r of rows) {
    if (!/Withdrawal.*Deposit.*Balance/i.test(r.text)) continue;
    const find = (re: RegExp) => r.items.find((i) => re.test(i.str))?.x;
    const withdrawal = find(/Withdrawal/i);
    const deposit = find(/Deposit/i);
    const balance = find(/Balance/i);
    if (withdrawal && deposit && balance) return { withdrawal, deposit, balance };
  }
  return DEFAULT_COLUMNS;
}

type Column = "withdrawal" | "deposit" | "balance";

/**
 * Which column an amount sits in. Amounts are right-aligned, so a wider number
 * starts further left; the midpoints between column origins separate them
 * safely for any amount that fits its column.
 */
function columnOf(item: TextItem, c: Columns): Column | null {
  if (item.x < (c.withdrawal + c.deposit) / 2) {
    return item.x >= c.withdrawal - 40 ? "withdrawal" : null;
  }
  if (item.x < (c.deposit + c.balance) / 2) return "deposit";
  return "balance";
}

const DATE_COLUMN_MAX = 90;
const DESC_MIN = 100;
const DESC_MAX = 335;

/** Rows that end the current transaction's description. */
const STOP = /^(Balance (Brought|Carried) Forward|Date\b|Transaction Details|Total:|Page \d+ of \d+)/i;

export const dbsParser: Parser = {
  name: "dbs",
  version: "1.0.0",
  accountHint: "DBS",

  detect(text: string): number {
    let score = 0;
    if (/DBS Co\. Reg\. No\./i.test(text)) score += 0.4;
    if (/Withdrawal \(-\)\s*Deposit \(\+\)/i.test(text)) score += 0.3;
    if (/DBS Multiplier Account|POSB|Consolidated Statement/i.test(text)) score += 0.2;
    if (/Balance Brought Forward/i.test(text)) score += 0.1;
    return Math.min(score, 1);
  },

  parse(rows: PositionedRow[]): StatementResult {
    const cols = readColumns(rows);
    const warnings: string[] = [];

    // --- statement period ---------------------------------------------------
    let periodTo: string | null = null;
    for (const r of rows) {
      if (/Transaction Details|Account Summary/i.test(r.text)) {
        const d = textDateToIso(r.text);
        if (d) { periodTo = d; break; }
      }
    }

    // --- opening / closing balance -----------------------------------------
    const balanceOf = (r: PositionedRow): number | null => {
      const nums = r.items.filter((i) => AMOUNT.test(i.str.replace(/^SGD\s*/, "").trim()));
      const last = nums[nums.length - 1];
      return last ? parseCents(last.str.replace(/^SGD\s*/, "")) : null;
    };

    const brought = rows.filter((r) => /Balance Brought Forward/i.test(r.text));
    const carried = rows.filter((r) => /Balance Carried Forward/i.test(r.text));
    if (!brought.length) throw new ParseError("no 'Balance Brought Forward' row - not a DBS statement section");

    const openingBalanceCents = balanceOf(brought[0]);
    const closingBalanceCents = carried.length
      ? balanceOf(carried[carried.length - 1])
      : null;
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

    // Only rows after the first Brought Forward are in the transaction table.
    const start = rows.indexOf(brought[0]);

    for (const row of rows.slice(start + 1)) {
      const first = row.items[0];
      const dateItem =
        first && first.x <= DATE_COLUMN_MAX ? slashDateToIso(first.str) : null;

      if (dateItem) {
        flush();
        const amounts = row.items
          .slice(1)
          .filter((i) => AMOUNT.test(i.str))
          .map((i) => ({ item: i, col: columnOf(i, cols) }));

        const withdrawal = amounts.find((a) => a.col === "withdrawal");
        const deposit = amounts.find((a) => a.col === "deposit");
        const balance = amounts.find((a) => a.col === "balance");

        if (!withdrawal && !deposit) {
          warnings.push(`row on ${dateItem} has no amount in either column: ${row.text.slice(0, 60)}`);
          continue;
        }
        if (withdrawal && deposit) {
          throw new ParseError(
            `row on ${dateItem} has amounts in both withdrawal and deposit columns: ${row.text.slice(0, 80)}`,
          );
        }

        // Direction comes from the column the statement printed it in.
        const magnitude = parseCents((withdrawal ?? deposit)!.item.str);
        current = {
          date: dateItem,
          parts: row.items
            .slice(1)
            .filter((i) => i.x >= DESC_MIN && i.x <= DESC_MAX)
            .map((i) => i.str),
          amount: withdrawal ? -magnitude : magnitude,
          balance: balance ? parseCents(balance.item.str) : null,
        };
        continue;
      }

      if (!current) continue;
      if (STOP.test(row.text)) { flush(); continue; }

      // A continuation line: description text only, inside the description band.
      const cont = row.items.filter((i) => i.x >= DESC_MIN && i.x <= DESC_MAX);
      if (cont.length && cont.length === row.items.length) {
        current.parts.push(...cont.map((i) => i.str));
      } else {
        flush();
      }
    }
    flush();

    const periodFrom = txns.length ? txns[0].txnDate : null;

    return {
      accountHint: "DBS",
      periodFrom,
      periodTo,
      openingBalanceCents,
      closingBalanceCents,
      transactions: txns,
      warnings,
    };
  },
};
