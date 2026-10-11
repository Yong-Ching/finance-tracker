import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { extractRows, rowsToText } from "@/lib/parsers/pdf";
import { dbsParser } from "@/lib/parsers/dbs";
import { detectParsers } from "@/lib/parsers";

/**
 * These suites run against real statement PDFs, which never enter the repo.
 * Each needs two private inputs, both outside version control:
 *   - the PDFs, under ../data/statements/{DBS,citibank,youtrip}/
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
