import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { extractRows, rowsToText } from "@/lib/parsers/pdf";
import { dbsParser } from "@/lib/parsers/dbs";
import { detectParsers } from "@/lib/parsers";

/**
 * These suites run against real statement PDFs, which never enter the repo.
 * Each needs two private inputs, both outside version control:
 *   - the PDFs, under ../data/statements/{DBS,citibank,youtrip,maybank}/
 *   - tests/fixtures/statements.local.json: the balances and sample rows read
 *     off those statements (statements.example.json shows the shape)
 * Without both, the suite skips.
 */
const LOCAL = path.join(__dirname, "fixtures", "statements.local.json");
const fixture = fs.existsSync(LOCAL) ? JSON.parse(fs.readFileSync(LOCAL, "utf8")) : {};
const re = (pattern: string) => new RegExp(pattern, "i");
const pdfsIn = (dir: string) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".pdf")) : [];

const DIR = path.resolve(__dirname, "..", "..", "data", "statements", "DBS");
const DBS = fixture.dbs as
  | {
      sample: string;
      expected: Record<string, { n: number; open: number; close: number }>;
      creditPattern: string;
      debitPattern: string;
      continuationPattern: string;
    }
  | undefined;
const files = DBS ? pdfsIn(DIR).filter((f) => f in DBS.expected) : [];

describe.skipIf(files.length === 0)("DBS parser", () => {
  it.each(files)("%s parses and its balances reconcile", async (file) => {
    const rows = await extractRows(new Uint8Array(fs.readFileSync(path.join(DIR, file))));
    const r = dbsParser.parse(rows);
    const exp = DBS!.expected[file];

    expect(r.transactions.length).toBe(exp.n);
    expect(r.openingBalanceCents).toBe(exp.open);
    expect(r.closingBalanceCents).toBe(exp.close);
    expect(r.warnings).toEqual([]);

    // The continuity gate: opening + every movement must land on closing.
    const sum = r.transactions.reduce((a, t) => a + t.amountCents, 0);
    expect(r.openingBalanceCents! + sum).toBe(r.closingBalanceCents);
  }, 60_000);

  it("reads direction from the column, not from the running balance", async () => {
    const rows = await extractRows(new Uint8Array(fs.readFileSync(path.join(DIR, DBS!.sample))));
    const r = dbsParser.parse(rows);
    const credit = r.transactions.find((t) => re(DBS!.creditPattern).test(t.descriptionRaw));
    const debit = r.transactions.find((t) => re(DBS!.debitPattern).test(t.descriptionRaw));
    expect(credit!.amountCents).toBeGreaterThan(0);
    expect(debit!.amountCents).toBeLessThan(0);
  }, 60_000);

  it("keeps multi-line descriptions together", async () => {
    const rows = await extractRows(new Uint8Array(fs.readFileSync(path.join(DIR, DBS!.sample))));
    const r = dbsParser.parse(rows);
    // The payee sits on a continuation line beneath the dated row.
    expect(r.transactions.some((t) => re(DBS!.continuationPattern).test(t.descriptionRaw))).toBe(true);
  }, 60_000);

  it("recognises the document with high confidence", async () => {
    const rows = await extractRows(new Uint8Array(fs.readFileSync(path.join(DIR, DBS!.sample))));
    const [best] = detectParsers(rowsToText(rows));
    expect(best.parser.name).toBe("dbs");
    expect(best.confidence).toBeGreaterThan(0.8);
  }, 60_000);
});

describe.skipIf(files.length === 0)("extraction does not consume the caller's buffer", () => {
  it("leaves the input readable so the file can still be archived", async () => {
    const buf = new Uint8Array(fs.readFileSync(path.join(DIR, files[0])));
    const before = buf.byteLength;
    await extractRows(buf);
    // pdf.js detaches any array it takes ownership of; this must not happen here.
    expect(buf.byteLength).toBe(before);
    expect(buf.byteLength).toBeGreaterThan(0);
  }, 60_000);
});

/* ------------------------------------------------------------- Citibank --- */

import { citibankParser } from "@/lib/parsers/citibank";

const CITI_DIR = path.resolve(__dirname, "..", "..", "data", "statements", "citibank");
type Probe = { pattern: string; cents: number };
const CITI = fixture.citibank as
  | {
      sample: string;
      statementDate: string;
      /** [file, opening, closing]; each closing must equal the next opening. */
      chain: [string, number, number][];
      payment: Probe;
      purchase: Probe;
      fx: Probe & { currency: string; originalCents: number };
    }
  | undefined;
const citiFiles = CITI ? pdfsIn(CITI_DIR) : [];
const CITI_CHAIN = CITI ? CITI.chain.filter(([f]) => citiFiles.includes(f)) : [];
const citiSample = () => path.join(CITI_DIR, CITI!.sample);

describe.skipIf(CITI_CHAIN.length === 0)("Citibank parser", () => {
  it.each(CITI_CHAIN)("%s reconciles and chains to the next statement", async (file, open, close) => {
    const rows = await extractRows(new Uint8Array(fs.readFileSync(path.join(CITI_DIR, file))));
    const r = citibankParser.parse(rows);

    expect(r.openingBalanceCents).toBe(open);
    expect(r.closingBalanceCents).toBe(close);
    expect(r.warnings).toEqual([]);

    const sum = r.transactions.reduce((a, t) => a + t.amountCents, 0);
    expect(r.openingBalanceCents! + sum).toBe(r.closingBalanceCents);
  }, 60_000);

  it("treats a purchase as money out and a payment as money in", async () => {
    const rows = await extractRows(new Uint8Array(fs.readFileSync(citiSample())));
    const r = citibankParser.parse(rows);

    // Parenthesised amounts are credits: the bill payment arriving on the card.
    const payment = r.transactions.find((t) => re(CITI!.payment.pattern).test(t.descriptionRaw));
    expect(payment!.amountCents).toBe(CITI!.payment.cents);

    const purchase = r.transactions.find((t) => re(CITI!.purchase.pattern).test(t.descriptionRaw));
    expect(purchase!.amountCents).toBe(CITI!.purchase.cents);
  }, 60_000);

  it("resolves the year across the December/January boundary", async () => {
    const rows = await extractRows(new Uint8Array(fs.readFileSync(citiSample())));
    const r = citibankParser.parse(rows);
    // A January statement's December rows belong to the previous year.
    const date = CITI!.statementDate;
    const year = Number(date.slice(0, 4));
    expect(r.transactions.some((t) => t.txnDate.startsWith(`${year - 1}-12`))).toBe(true);
    expect(r.transactions.some((t) => t.txnDate.startsWith(`${year}-01`))).toBe(true);
    expect(r.transactions.every((t) => t.txnDate <= date)).toBe(true);
  }, 60_000);

  it("captures the original currency of a foreign purchase", async () => {
    const rows = await extractRows(new Uint8Array(fs.readFileSync(citiSample())));
    const r = citibankParser.parse(rows);
    const exp = CITI!.fx;
    const fx = r.transactions.find((t) => re(exp.pattern).test(t.descriptionRaw));
    expect(fx!.currencyOriginal).toBe(exp.currency);
    expect(fx!.amountOriginalCents).toBe(exp.originalCents);
    expect(fx!.amountCents).toBe(exp.cents);
  }, 60_000);

  it("is not confused with a DBS statement", async () => {
    const citi = await extractRows(new Uint8Array(fs.readFileSync(citiSample())));
    const [best] = detectParsers(rowsToText(citi));
    expect(best.parser.name).toBe("citibank");
    expect(dbsParser.detect(rowsToText(citi))).toBeLessThan(0.5);
  }, 60_000);
});

/* -------------------------------------------------------------- YouTrip --- */

import { youtripParser } from "@/lib/parsers/youtrip";

const YT_DIR = path.resolve(__dirname, "..", "..", "data", "statements", "youtrip");
const YT = fixture.youtrip as
  | {
      sample: string;
      merchantAbove: Probe & { date: string };
      topUpCents: number;
      fx: { currency: string; cents: number; originalCents: number };
      otherCurrency: string;
    }
  | undefined;
const ytFiles = YT ? pdfsIn(YT_DIR) : [];
const yt = (f: string) => path.join(YT_DIR, f);
const JUL = YT?.sample ?? "";

describe.skipIf(ytFiles.length === 0)("YouTrip parser", () => {
  it.each(ytFiles)("%s reconciles opening + movements to closing", async (file) => {
    const r = youtripParser.parse(await extractRows(new Uint8Array(fs.readFileSync(yt(file)))));
    expect(r.warnings).toEqual([]);
    expect(r.transactions.length).toBeGreaterThan(0);
    const sum = r.transactions.reduce((a, t) => a + t.amountCents, 0);
    expect(r.openingBalanceCents! + sum).toBe(r.closingBalanceCents);
  }, 60_000);

  it("groups a transaction whose merchant is printed above its date", async () => {
    const r = youtripParser.parse(await extractRows(new Uint8Array(fs.readFileSync(yt(JUL)))));
    const exp = YT!.merchantAbove;
    const row = r.transactions.find((t) => re(exp.pattern).test(t.descriptionRaw) && t.txnDate === exp.date);
    expect(row).toBeDefined();
    expect(row!.amountCents).toBe(exp.cents);
  }, 60_000);

  it("reads Money Out as spending and Money In as a top-up", async () => {
    const r = youtripParser.parse(await extractRows(new Uint8Array(fs.readFileSync(yt(JUL)))));
    const topUp = r.transactions.find((t) => /Top up/i.test(t.descriptionRaw) && t.amountCents === YT!.topUpCents);
    expect(topUp).toBeDefined();
    expect(r.transactions.filter((t) => t.amountCents < 0).length).toBeGreaterThan(0);
  }, 60_000);

  it("captures the original currency of a foreign spend", async () => {
    const r = youtripParser.parse(await extractRows(new Uint8Array(fs.readFileSync(yt(JUL)))));
    const exp = YT!.fx;
    const fx = r.transactions.find((t) => t.currencyOriginal === exp.currency && t.amountCents === exp.cents);
    expect(fx).toBeDefined();
    expect(fx!.amountOriginalCents).toBe(exp.originalCents);
    const other = r.transactions.find((t) => t.currencyOriginal === YT!.otherCurrency);
    expect(other).toBeDefined();
  }, 60_000);

  it("is told apart from the other two statement formats", async () => {
    const text = rowsToText(await extractRows(new Uint8Array(fs.readFileSync(yt(JUL)))));
    const [best] = detectParsers(text);
    expect(best.parser.name).toBe("youtrip");
    expect(dbsParser.detect(text)).toBeLessThan(0.5);
    expect(citibankParser.detect(text)).toBeLessThan(0.5);
  }, 60_000);
});

/* -------------------------------------------------------------- Maybank --- */

import { maybankParser } from "@/lib/parsers/maybank";

const MB_DIR = path.resolve(__dirname, "..", "..", "data", "statements", "maybank");
const MB = fixture.maybank as
  | {
      sample: string;
      expected: Record<string, { n: number; open: number; close: number }>;
      credit: Probe;
      debit: Probe;
      /** The last row on a page, whose description continues overleaf. */
      pageBreak: Probe & { date: string };
    }
  | undefined;
const mbFiles = MB ? pdfsIn(MB_DIR).filter((f) => f in MB.expected) : [];
const mbSample = async () => maybankParser.parse(
  await extractRows(new Uint8Array(fs.readFileSync(path.join(MB_DIR, MB!.sample)))),
);

describe.skipIf(mbFiles.length === 0)("Maybank parser", () => {
  it.each(mbFiles)("%s parses and its balances reconcile", async (file) => {
    const r = maybankParser.parse(await extractRows(new Uint8Array(fs.readFileSync(path.join(MB_DIR, file)))));
    const exp = MB!.expected[file];
    expect(r.transactions.length).toBe(exp.n);
    expect(r.openingBalanceCents).toBe(exp.open);
    expect(r.closingBalanceCents).toBe(exp.close);
    // Empty also means the footer's TOTAL CREDIT and TOTAL DEBIT matched.
    expect(r.warnings).toEqual([]);
    const sum = r.transactions.reduce((a, t) => a + t.amountCents, 0);
    expect(r.openingBalanceCents! + sum).toBe(r.closingBalanceCents);
  }, 60_000);

  it("reads direction from the sign printed after the amount", async () => {
    const r = await mbSample();
    const credit = r.transactions.find((t) => re(MB!.credit.pattern).test(t.descriptionRaw));
    const debit = r.transactions.find((t) => re(MB!.debit.pattern).test(t.descriptionRaw));
    expect(credit!.amountCents).toBe(MB!.credit.cents);
    expect(debit!.amountCents).toBe(MB!.debit.cents);
  }, 60_000);

  it("keeps a description that carries over a page break", async () => {
    const r = await mbSample();
    const exp = MB!.pageBreak;
    const row = r.transactions.find((t) => t.txnDate === exp.date && t.amountCents === exp.cents && re(exp.pattern).test(t.descriptionRaw));
    expect(row).toBeDefined();
  }, 60_000);

  it("is told apart from the other statement formats", async () => {
    const text = rowsToText(await extractRows(new Uint8Array(fs.readFileSync(path.join(MB_DIR, MB!.sample)))));
    const [best] = detectParsers(text);
    expect(best.parser.name).toBe("maybank");
    expect(best.confidence).toBeGreaterThan(0.8);
    expect(dbsParser.detect(text)).toBeLessThan(0.5);
    expect(citibankParser.detect(text)).toBeLessThan(0.5);
    expect(youtripParser.detect(text)).toBeLessThan(0.5);
  }, 60_000);
});

/* ---------------------------------------------------------- Touch 'n Go --- */

import { tngParser } from "@/lib/parsers/tng";

const TNG_DIR = path.resolve(__dirname, "..", "..", "data", "statements", "tngo");
const TNG = fixture.tng as
  | {
      sample: string;
      n: number;
      periodFrom: string;
      periodTo: string;
      reload: Probe & { date: string };
      payment: Probe & { date: string };
      /** A type the PDF prints run together with its reference ("Receive from Wallet2026…"). */
      glued: Probe & { date: string };
    }
  | undefined;
const tngFile = TNG && pdfsIn(TNG_DIR).includes(TNG.sample) ? path.join(TNG_DIR, TNG.sample) : null;
const tngRows = async () => extractRows(new Uint8Array(fs.readFileSync(tngFile!)));
const tngFind = (r: { transactions: { txnDate: string; amountCents: number; descriptionRaw: string }[] }, p: Probe & { date: string }) =>
  r.transactions.find((t) => t.txnDate === p.date && t.amountCents === p.cents && re(p.pattern).test(t.descriptionRaw));

describe.skipIf(!tngFile)("Touch 'n Go parser", () => {
  it("reads every wallet transaction, each agreeing with the balance printed after it", async () => {
    const r = tngParser.parse(await tngRows());
    expect(r.transactions.length).toBe(TNG!.n);
    expect(r.periodFrom).toBe(TNG!.periodFrom);
    expect(r.periodTo).toBe(TNG!.periodTo);
    // Empty also means no break in the running balance, row by row.
    expect(r.warnings).toEqual([]);
    const sum = r.transactions.reduce((a, t) => a + t.amountCents, 0);
    expect(r.openingBalanceCents! + sum).toBe(r.closingBalanceCents);
  }, 60_000);

  it("takes direction from the transaction type", async () => {
    const r = tngParser.parse(await tngRows());
    expect(tngFind(r, TNG!.reload)).toBeDefined();
    expect(tngFind(r, TNG!.payment)).toBeDefined();
    expect(tngFind(r, TNG!.glued)).toBeDefined();
  }, 60_000);

  it("stops at the GO+ section and keeps identical transactions apart", async () => {
    const r = tngParser.parse(await tngRows());
    expect(r.transactions.some((t) => /Daily Earnings|GO\+ Cash In/i.test(t.descriptionRaw))).toBe(false);
    // The reference makes each description unique, so equal rows never collapse.
    const keys = r.transactions.map((t) => `${t.txnDate}|${t.amountCents}|${t.descriptionRaw}`);
    expect(new Set(keys).size).toBe(keys.length);
  }, 60_000);

  it("is told apart from the other statement formats", async () => {
    const text = rowsToText(await tngRows());
    const [best] = detectParsers(text);
    expect(best.parser.name).toBe("tng");
    expect(best.confidence).toBeGreaterThan(0.8);
    for (const p of [dbsParser, citibankParser, youtripParser, maybankParser]) expect(p.detect(text)).toBeLessThan(0.5);
  }, 60_000);

  it.skipIf(mbFiles.length === 0)("does not claim a Maybank statement that pays it", async () => {
    // Maybank lines read "SALE DEBIT TNG-EWALLET": that alone must not claim the document.
    const mbText = rowsToText(await extractRows(new Uint8Array(fs.readFileSync(path.join(MB_DIR, MB!.sample)))));
    expect(tngParser.detect(mbText)).toBeLessThan(0.5);
  }, 60_000);
});
