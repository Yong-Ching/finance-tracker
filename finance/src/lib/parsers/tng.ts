import type { PositionedRow, TextItem } from "./pdf";
import { type Parser, type RawTxn, type StatementResult, ParseError, textDateToIso } from "./types";
import { parseCents } from "../money";

/**
 * Touch 'n Go eWallet (Malaysia) transaction history, in ringgit.
 *
 * The export is a table printed sideways: each COLUMN of the page is one
 * transaction, and its fields run along fixed bands of y - date at the bottom,
 * then status, type, reference, description, details, amount and the wallet
 * balance after it. So text items are grouped by x into transactions, anchored
 * on the date, and read out by band.
 *
 * Amounts carry no sign. Direction comes from the transaction type, and every
 * row is checked against the wallet balance printed after it: a type read the
 * wrong way round breaks that chain, which the continuity gate then catches.
 * One export covers any range of months, so this is one statement for all of it.
 *
 * After the wallet, the export carries a second section: GO+, the money-market
 * fund the wallet sweeps into and draws from. Only the wallet is read. Every
 * purchase is made from the wallet, so spending is complete; moves to and from
 * GO+ show as transfers. GO+ itself accrues interest in fractions of a sen
 * ("RM0.0002"), which a ledger of whole cents cannot hold.
 */

const DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const MONEY = /^RM\s?(\d{1,3}(?:,\d{3})*\.\d{2})$/;

/** The y-bands each field occupies (the date sits at y≈20 on every page). */
const BAND = {
  date: [0, 50],
  status: [50, 110],
  type: [110, 200],
  reference: [200, 270],
  description: [270, 420],
  amount: [640, 750],
  balance: [750, 820],
} as const;
type Field = keyof typeof BAND;

/** Wrapped lines of one field sit about 12pt apart in x; a column is never wider than this. */
const COLUMN_MAX_WIDTH = 48;

/** How each transaction type moves the wallet balance. */
const DIRECTION: Array<[RegExp, 1 | -1]> = [
  ["Reload", 1],
  ["Receive from Wallet", 1],
  ["Refund", 1],
  ["Cashback", 1],
  ["Payment", -1],
  ["DuitNow QR", -1],
  ["DuitNow Transfer", -1],
  ["eWallet Cash Out", -1],
  ["Transfer to Wallet", -1],
  ["Transfer to Bank", -1],
  // Not \b: the reference can follow with no space ("Wallet2026…"), and a digit is a word character.
].map(([name, sign]) => [new RegExp(`^${name}(?![A-Za-z])`, "i"), sign as 1 | -1]);

/** "Receive from Wallet20260315111" -> "Receive from Wallet": the reference can run into the type. */
function typeOf(text: string): { type: string; sign: 1 | -1 } | null {
  for (const [re, sign] of DIRECTION) {
    const m = re.exec(text);
    if (m) return { type: text.slice(0, m[0].length).trim(), sign };
  }
  return null;
}

const inBand = (it: TextItem, f: Field) => it.y >= BAND[f][0] && it.y < BAND[f][1];
const join = (items: TextItem[]) => items.sort((a, b) => a.x - b.x).map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
const money = (items: TextItem[]) => {
  const m = items.map((i) => MONEY.exec(i.str.trim())).find(Boolean);
  return m ? parseCents(m[1]) : null;
};

export const tngParser: Parser = {
  name: "tng",
  version: "1.0.0",
  accountHint: "Touch 'n Go",

  detect(text: string): number {
    let score = 0;
    if (/TNG WALLET TRANSACTION HISTORY/i.test(text)) score += 0.5;
    if (/tngd\.my|TNGOW3MY/i.test(text)) score += 0.3;
    if (/Wallet Balance/i.test(text)) score += 0.1;
    if (/Quick Reload Payment|eWallet Cash Out/i.test(text)) score += 0.1;
    return Math.min(score, 1);
  },

  parse(rows: PositionedRow[]): StatementResult {
    const warnings: string[] = [];

    // --- period: "1 January 2026 - 30 September 2026" --------------------------
    let periodFrom: string | null = null;
    let periodTo: string | null = null;
    for (const r of rows) {
      const it = r.items.find((i) => /^\d{1,2} \w+ \d{4} - \d{1,2} \w+ \d{4}$/.test(i.str.trim()));
      if (it) {
        const [a, b] = it.str.split(" - ");
        periodFrom = textDateToIso(a);
        periodTo = textDateToIso(b);
        break;
      }
    }

    // --- columns: one per transaction, anchored on its date --------------------
    const byPage = new Map<number, TextItem[]>();
    for (const r of rows) byPage.set(r.page, [...(byPage.get(r.page) ?? []), ...r.items]);

    const txns: RawTxn[] = [];
    const balances: number[] = [];
    let goPlusStarted = false;
    for (const [page, items] of [...byPage].sort((a, b) => a[0] - b[0])) {
      if (goPlusStarted) break;
      // The GO+ section's title: every column to its right, and every page after, is GO+.
      const goPlus = items.find((i) => inBand(i, "date") && /^GO\+ TRANSACTION/i.test(i.str.trim()));
      if (goPlus) goPlusStarted = true;
      const anchors = items
        .filter((i) => inBand(i, "date") && DATE.test(i.str.trim()) && (!goPlus || i.x < goPlus.x))
        .sort((a, b) => a.x - b.x);
      anchors.forEach((anchor, k) => {
        const right = Math.min(anchors[k + 1]?.x ?? Infinity, anchor.x + COLUMN_MAX_WIDTH);
        const col = items.filter((i) => i.x >= anchor.x - 1 && i.x < right - 1 && !inBand(i, "date"));
        const field = (f: Field) => col.filter((i) => inBand(i, f));

        const [, d, m, y] = DATE.exec(anchor.str.trim())!;
        const date = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
        const status = join(field("status"));
        const typeText = join(field("type"));
        const kind = typeOf(typeText);
        const amount = money(field("amount"));
        const balance = money(field("balance"));
        const where = `page ${page}, ${date} "${typeText}"`;

        if (!/^Success/i.test(status)) {
          // A failed or pending attempt moved no money; its balance says so.
          warnings.push(`skipped ${status || "unknown-status"} transaction on ${where}`);
          return;
        }
        if (!kind) throw new ParseError(`unknown transaction type on ${where}`);
        if (amount === null || balance === null) throw new ParseError(`no amount or balance on ${where}`);

        // The reference is unique per transaction; without it two identical
        // top-ups on one day would be indistinguishable.
        const reference = join(field("reference")).replace(/\s+/g, "") ||
          typeText.slice(kind.type.length).trim();
        const description = join(field("description"));
        txns.push({
          txnDate: date,
          descriptionRaw: `${kind.type} ${description} ref ${reference}`.replace(/\s+/g, " ").trim(),
          amountCents: kind.sign * amount,
          balanceAfterCents: balance,
        });
        balances.push(balance);
      });
    }
    if (!txns.length) throw new ParseError("no transactions found - not a Touch 'n Go wallet history");

    // --- the balance chain -----------------------------------------------------
    // The export prints no opening balance; the first row's balance before it is it.
    const openingBalanceCents = balances[0] - txns[0].amountCents;
    for (let i = 1; i < txns.length; i++) {
      if (balances[i - 1] + txns[i].amountCents !== balances[i]) {
        warnings.push(`balance chain breaks at ${txns[i].txnDate}: ${txns[i].descriptionRaw.slice(0, 60)}`);
      }
    }

    return {
      accountHint: "Touch 'n Go",
      periodFrom: periodFrom ?? txns[0].txnDate,
      periodTo: periodTo ?? txns[txns.length - 1].txnDate,
      openingBalanceCents,
      closingBalanceCents: balances[balances.length - 1],
      transactions: txns,
      warnings,
    };
  },
};
