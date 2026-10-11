import type { PositionedRow, TextItem } from "./pdf";
import { type Parser, type RawTxn, type StatementResult, ParseError, textDateToIso } from "./types";
import { parseCents } from "../money";

/** Money, optionally in accountancy parentheses: 15.63 or (1,031.99). */
const AMOUNT = /^\(?\d{1,3}(,\d{3})*\.\d{2}\)?$/;
const TXN_DATE = /^(\d{2})\s+([A-Z]{3})$/i;
const FOREIGN = /FOREIGN AMOUNT\s+([A-Z][A-Z .]*[A-Z])\s+([\d,]+\.\d{2})/i;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Currency names as Citibank prints them, mapped to ISO codes. */
const CURRENCY: Record<string, string> = {
  "MALAYSIAN RINGGIT": "MYR",
  YEN: "JPY",
  "JAPANESE YEN": "JPY",
  "US DOLLAR": "USD",
  "UNITED STATES DOLLAR": "USD",
  "EURO": "EUR",
  "POUND STERLING": "GBP",
  "HONG KONG DOLLAR": "HKD",
  "THAI BAHT": "THB",
  "AUSTRALIAN DOLLAR": "AUD",
  "CHINESE YUAN RENMINBI": "CNY",
  "KOREAN WON": "KRW",
  "NEW TAIWAN DOLLAR": "TWD",
  "INDONESIAN RUPIAH": "IDR",
  "VIETNAMESE DONG": "VND",
  "SWISS FRANC": "CHF",
  "CANADIAN DOLLAR": "CAD",
  "NEW ZEALAND DOLLAR": "NZD",
  "INDIAN RUPEE": "INR",
  "PHILIPPINE PESO": "PHP",
};

const DATE_COLUMN_MAX = 90;
const DESC_MIN = 100;
/** Right of this is the AMOUNT (SGD) column; left of it is description text. */
const AMOUNT_COLUMN_MIN = 480;

/** Rows that are structure, not transactions. */
const SKIP = /^(XXXX-XXXX-XXXX|SUB-TOTAL|GRAND TOTAL|DATE\b|CITI CASH BACK|TRANSACTIONS FOR|ALL TRANSACTIONS BILLED|BALANCE PREVIOUS STATEMENT|YOUR CASH BACK|Page \d+ of)/i;

function amountColumn(rows: PositionedRow[]): number {
  for (const r of rows) {
    const h = r.items.find((i) => /^AMOUNT \(SGD\)$/i.test(i.str));
    // The header sits at the left edge of a right-aligned column; step back a
    // little so a wide figure is still counted as being in it.
    if (h) return h.x - 20;
  }
  return AMOUNT_COLUMN_MIN;
}

export const citibankParser: Parser = {
  name: "citibank",
  version: "1.0.0",
  accountHint: "Citibank",

  detect(text: string): number {
    let score = 0;
    if (/Citibank Singapore Ltd/i.test(text)) score += 0.4;
    if (/CITI CASH BACK|CITI .*MASTERCARD|CITI .*VISA/i.test(text)) score += 0.3;
    if (/BALANCE PREVIOUS STATEMENT/i.test(text)) score += 0.2;
    if (/AMOUNT \(SGD\)/i.test(text)) score += 0.1;
    return Math.min(score, 1);
  },

  parse(rows: PositionedRow[]): StatementResult {
    const warnings: string[] = [];
    const amountX = amountColumn(rows);

    // --- statement date, which is also how transaction years are resolved ---
    let periodTo: string | null = null;
    for (const r of rows) {
      if (/Statement Date/i.test(r.text)) {
        const d = textDateToIso(r.text);
        if (d) { periodTo = d; break; }
      }
    }
    if (!periodTo) throw new ParseError("no statement date found");
    const stmtYear = Number(periodTo.slice(0, 4));
    const stmtMonth = Number(periodTo.slice(5, 7));

    /**
     * Rows carry a day and a month but no year. A statement dated January
     * covers December, so a month later than the statement's belongs to the
     * previous year.
     */
    const resolveDate = (day: string, mon: string): string => {
      const m = MONTHS[mon.slice(0, 3).toLowerCase()];
      if (!m) throw new ParseError(`unknown month: ${mon}`);
      const year = m > stmtMonth ? stmtYear - 1 : stmtYear;
      return `${year}-${String(m).padStart(2, "0")}-${day.padStart(2, "0")}`;
    };

    const amountOf = (items: TextItem[]): number | null => {
      const nums = items.filter((i) => i.x >= amountX && AMOUNT.test(i.str));
      if (!nums.length) return null;
      return parseCents(nums[nums.length - 1].str);
    };

    // --- opening balance ----------------------------------------------------
    const prev = rows.find((r) => /BALANCE PREVIOUS STATEMENT/i.test(r.text));
    if (!prev) throw new ParseError("no 'BALANCE PREVIOUS STATEMENT' row");
    const prevOwed = amountOf(prev.items);
    if (prevOwed === null) throw new ParseError("could not read the previous balance");

    // A card balance is money owed, so it is negative in a signed ledger. That
    // also makes the continuity check plain arithmetic.
    const openingBalanceCents = -Math.abs(prevOwed);

    // --- closing balance ----------------------------------------------------
    const grand = [...rows].reverse().find((r) => /^GRAND TOTAL/i.test(r.text.trim()));
    const closing = grand ? amountOf(grand.items) : null;
    const closingBalanceCents = closing === null ? null : -Math.abs(closing);
    if (closingBalanceCents === null) warnings.push("no grand total found");

    // --- transactions -------------------------------------------------------
    const txns: RawTxn[] = [];
    const start = rows.indexOf(prev);

    for (const row of rows.slice(start + 1)) {
      const first = row.items[0];
      const m = first && first.x <= DATE_COLUMN_MAX ? TXN_DATE.exec(first.str.trim()) : null;

      if (!m) {
        // A continuation line naming the original currency belongs to the row
        // above it; the card-number line is noise.
        const f = FOREIGN.exec(row.text);
        if (f && txns.length) {
          const last = txns[txns.length - 1];
          const name = f[1].trim().toUpperCase();
          last.currencyOriginal = CURRENCY[name] ?? name;
          last.amountOriginalCents = parseCents(f[2]);
          const sgd = Math.abs(last.amountCents);
          last.fxRate = sgd > 0 ? last.amountOriginalCents / sgd : undefined;
        }
        continue;
      }
      if (SKIP.test(row.text)) continue;

      const raw = row.items.filter((i) => i.x >= amountX && AMOUNT.test(i.str));
      if (!raw.length) {
        warnings.push(`row on ${first.str} has no amount: ${row.text.slice(0, 60)}`);
        continue;
      }
      const token = raw[raw.length - 1].str;
      const magnitude = parseCents(token.replace(/[()]/g, ""));

      // Parentheses mark a credit - a payment or refund reducing what is owed,
      // which is money arriving in this account. Everything else is a purchase.
      const isCredit = token.startsWith("(");

      txns.push({
        txnDate: resolveDate(m[1], m[2]),
        descriptionRaw: row.items
          .filter((i) => i.x >= DESC_MIN && i.x < amountX)
          .map((i) => i.str)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
        amountCents: isCredit ? magnitude : -magnitude,
      });
    }

    const periodFrom = txns.length
      ? txns.reduce((a, t) => (t.txnDate < a ? t.txnDate : a), txns[0].txnDate)
      : null;

    return {
      accountHint: "Citibank",
      periodFrom,
      periodTo,
      openingBalanceCents,
      closingBalanceCents,
      transactions: txns,
      warnings,
    };
  },
};
