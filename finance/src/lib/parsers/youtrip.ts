import type { PositionedRow, TextItem } from "./pdf";
import { type Parser, type RawTxn, type StatementResult, ParseError, textDateToIso } from "./types";
import { parseCents } from "../money";

/**
 * YouTrip prints one transaction as a small cluster of lines rather than a
 * single row: the merchant, the date, the amounts, the time and any exchange
 * detail each sit on their own baseline, and the merchant sometimes appears
 * ABOVE the date. So rows are regrouped into blocks by vertical proximity
 * before anything is read out of them.
 */
const BLOCK_GAP = 12;

const MONEY = /^\$?\(?-?[\d,]+\.\d{2}\)?$/;
const DATE_LINE = /^\d{1,2}\s+[A-Za-z]{3}\s+\d{4}$/;
/** "361.16 MYR", "297,990.00 IDR", "22.00 USD" - any non-SGD amount. */
const FOREIGN = /([\d,]+(?:\.\d+)?)\s+([A-Z]{3})\b/g;

const DATE_COLUMN_MAX = 120;
const DESC_MIN = 130;

interface Block {
  page: number;
  items: TextItem[];
  text: string;
}

function toBlocks(rows: PositionedRow[]): Block[] {
  const blocks: Block[] = [];
  let current: { page: number; items: TextItem[]; lastY: number } | null = null;

  for (const row of rows) {
    const near = current && current.page === row.page && current.lastY - row.y <= BLOCK_GAP;
    if (!near) {
      if (current) blocks.push(finish(current));
      current = { page: row.page, items: [...row.items], lastY: row.y };
    } else {
      current!.items.push(...row.items);
      current!.lastY = row.y;
    }
  }
  if (current) blocks.push(finish(current));
  return blocks;
}

const finish = (c: { page: number; items: TextItem[] }): Block => ({
  page: c.page,
  items: c.items,
  text: c.items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim(),
});

interface Columns { out: number; in: number; balance: number }
const DEFAULT_COLUMNS: Columns = { out: 366, in: 448, balance: 526 };

function readColumns(rows: PositionedRow[]): Columns {
  for (const r of rows) {
    if (!/Money Out.*Money In.*Balance/i.test(r.text)) continue;
    const at = (re: RegExp) => r.items.find((i) => re.test(i.str))?.x;
    const out = at(/^Money Out$/i), inn = at(/^Money In$/i), bal = at(/^Balance$/i);
    if (out && inn && bal) return { out, in: inn, balance: bal };
  }
  return DEFAULT_COLUMNS;
}

type Column = "out" | "in" | "balance";
function columnOf(item: TextItem, c: Columns): Column | null {
  if (item.x < c.out - 40) return null;
  if (item.x < (c.out + c.in) / 2) return "out";
  if (item.x < (c.in + c.balance) / 2) return "in";
  return "balance";
}

export const youtripParser: Parser = {
  name: "youtrip",
  version: "1.0.0",
  accountHint: "YouTrip",

  detect(text: string): number {
    let score = 0;
    if (/My SGD Statement/i.test(text)) score += 0.35;
    if (/SmartExchange/i.test(text)) score += 0.3;
    if (/Completed Date/i.test(text)) score += 0.2;
    if (/Money Out\s+Money In\s+Balance/i.test(text)) score += 0.15;
    return Math.min(score, 1);
  },

  parse(rows: PositionedRow[]): StatementResult {
    const warnings: string[] = [];
    const cols = readColumns(rows);
    const blocks = toBlocks(rows);

    const balanceIn = (b: Block): number | null => {
      const v = b.items.filter((i) => MONEY.test(i.str) && columnOf(i, cols) === "balance");
      return v.length ? parseCents(v[v.length - 1].str.replace("$", "")) : null;
    };

    const openBlock = blocks.find((b) => /Opening Balance/i.test(b.text));
    const closeBlock = [...blocks].reverse().find((b) => /Closing Balance/i.test(b.text));
    if (!openBlock) throw new ParseError("no 'Opening Balance' row - not a YouTrip statement");

    const openingBalanceCents = balanceIn(openBlock);
    const closingBalanceCents = closeBlock ? balanceIn(closeBlock) : null;
    if (closingBalanceCents === null) warnings.push("no closing balance found");

    // Statement period, e.g. "1 Jul 2026 to 31 Jul 2026".
    let periodFrom: string | null = null;
    let periodTo: string | null = null;
    for (const r of rows) {
      const m = /^(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})\s+to\s+(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})$/.exec(r.text.trim());
      if (m) { periodFrom = textDateToIso(m[1]); periodTo = textDateToIso(m[2]); break; }
    }

    const txns: RawTxn[] = [];
    const startAt = blocks.indexOf(openBlock);

    for (const b of blocks.slice(startAt + 1)) {
      if (/Closing Balance|Opening Balance/i.test(b.text)) continue;
      if (/Completed Date|My SGD Statement|Transactions|Remarks:|page \d+ of/i.test(b.text)) continue;

      const dateItem = b.items.find((i) => i.x <= DATE_COLUMN_MAX && DATE_LINE.test(i.str.trim()));
      if (!dateItem) continue;
      const txnDate = textDateToIso(dateItem.str);
      if (!txnDate) continue;

      const moneyOut = b.items.find((i) => MONEY.test(i.str) && columnOf(i, cols) === "out");
      const moneyIn = b.items.find((i) => MONEY.test(i.str) && columnOf(i, cols) === "in");
      if (!moneyOut && !moneyIn) {
        warnings.push(`block on ${txnDate} has no amount: ${b.text.slice(0, 60)}`);
        continue;
      }
      if (moneyOut && moneyIn) {
        throw new ParseError(`block on ${txnDate} has both Money Out and Money In: ${b.text.slice(0, 80)}`);
      }

      const magnitude = parseCents((moneyOut ?? moneyIn)!.str.replace("$", ""));
      const amountCents = moneyOut ? -magnitude : magnitude;

      // Description is everything in the description column except the printed
      // FX rate, which is derived from the amounts instead.
      const descParts = b.items
        .filter((i) => i.x >= DESC_MIN && columnOf(i, cols) === null)
        .map((i) => i.str)
        .filter((s) => !/^FX rate:/i.test(s));
      const descriptionRaw = descParts.join(" ").replace(/\s+/g, " ").trim();

      const txn: RawTxn = { txnDate, descriptionRaw, amountCents, balanceAfterCents: balanceIn(b) ?? undefined };

      // The first non-SGD amount anywhere in the block is the original currency.
      for (const m of b.text.matchAll(FOREIGN)) {
        if (m[2] === "SGD") continue;
        txn.currencyOriginal = m[2];
        txn.amountOriginalCents = parseCents(m[1]);
        txn.fxRate = magnitude > 0 ? txn.amountOriginalCents / magnitude : undefined;
        break;
      }

      txns.push(txn);
    }

    return {
      accountHint: "YouTrip",
      periodFrom: periodFrom ?? (txns[0]?.txnDate ?? null),
      periodTo,
      openingBalanceCents,
      closingBalanceCents,
      transactions: txns,
      warnings,
    };
  },
};
