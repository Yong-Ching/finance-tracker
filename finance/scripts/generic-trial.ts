/**
 * Runs the generic statement reader against statements a bank-specific parser
 * already reads, and reports how close it gets. The PDFs never enter the repo;
 * point it at a folder of them:
 *
 *   npx tsx scripts/generic-trial.ts ../data/statements [--verbose]
 *
 * --verbose prints each mismatched row, which shows real statement text: keep
 * that output local.
 */
import fs from "node:fs";
import path from "node:path";
import { extractRows, rowsToText } from "../src/lib/parsers/pdf";
import { detectParsers } from "../src/lib/parsers";
import { parseGeneric } from "../src/lib/parsers/generic";
import type { RawTxn } from "../src/lib/parsers/types";

const root = process.argv[2];
const verbose = process.argv.includes("--verbose");
if (!root) throw new Error("usage: generic-trial.ts <folder of statement PDFs> [--verbose]");

function pdfs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "encrypted" ? [] : pdfs(p);
    return e.name.toLowerCase().endsWith(".pdf") ? [p] : [];
  });
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1));
function similar(a: string, b: string): boolean {
  const A = words(a), B = words(b);
  if (!A.size && !B.size) return true;
  const both = [...A].filter((w) => B.has(w)).length;
  return both / Math.max(A.size, B.size) >= 0.6;
}

/** Pairs rows by date and amount; each row is used once. */
function pair(expected: RawTxn[], got: RawTxn[]) {
  const pool = [...got];
  const matched: Array<[RawTxn, RawTxn]> = [];
  const missing: RawTxn[] = [];
  for (const e of expected) {
    const i = pool.findIndex((g) => g.txnDate === e.txnDate && g.amountCents === e.amountCents);
    if (i < 0) missing.push(e);
    else matched.push([e, pool.splice(i, 1)[0]]);
  }
  return { matched, missing, extra: pool };
}

const money = (c: number | null) => (c === null ? "-" : (c / 100).toFixed(2));
const totals = { files: 0, exact: 0, reconciled: 0, rows: 0, rowsMatched: 0, desc: 0 };

async function main() {
for (const file of pdfs(root)) {
  const data = new Uint8Array(fs.readFileSync(file));
  const rows = await extractRows(data);
  const det = detectParsers(rowsToText(rows))[0];
  if (!det) continue;
  let truth;
  try { truth = det.parser.parse(rows); } catch { continue; }

  let got;
  let error: string | null = null;
  try { got = parseGeneric(await extractRows(data, { upright: true })); } catch (e) { error = String(e); }

  totals.files++;
  totals.rows += truth.transactions.length;
  const name = `${det.parser.name.padEnd(9)} ${path.basename(file).slice(0, 34).padEnd(34)}`;
  if (!got) { console.log(`${name}  FAILED  ${error}`); continue; }

  const { matched, missing, extra } = pair(truth.transactions, got.transactions);
  const descOk = matched.filter(([e, g]) => similar(e.descriptionRaw, g.descriptionRaw)).length;
  const sum = got.transactions.reduce((a, t) => a + t.amountCents, 0);
  const delta = got.openingBalanceCents !== null && got.closingBalanceCents !== null
    ? got.openingBalanceCents + sum - got.closingBalanceCents : null;
  const exact = !missing.length && !extra.length && got.openingBalanceCents === truth.openingBalanceCents
    && got.closingBalanceCents === truth.closingBalanceCents;

  totals.rowsMatched += matched.length;
  totals.desc += descOk;
  if (exact) totals.exact++;
  if (delta === 0) totals.reconciled++;

  console.log(
    `${name}  rows ${matched.length}/${truth.transactions.length}` +
      `${extra.length ? ` +${extra.length} extra` : ""}  desc ${descOk}/${matched.length}` +
      `  open ${got.openingBalanceCents === truth.openingBalanceCents ? "ok" : `${money(got.openingBalanceCents)}≠${money(truth.openingBalanceCents)}`}` +
      `  close ${got.closingBalanceCents === truth.closingBalanceCents ? "ok" : `${money(got.closingBalanceCents)}≠${money(truth.closingBalanceCents)}`}` +
      `  reconciles ${delta === 0 ? "yes" : delta === null ? "no balances" : `no (${money(delta)})`}` +
      `${got.warnings.length ? `  ${got.warnings.length} warnings` : ""}`,
  );
  if (verbose) {
    for (const m of missing.slice(0, 5)) console.log(`    missing ${m.txnDate} ${money(m.amountCents)} ${m.descriptionRaw.slice(0, 50)}`);
    for (const x of extra.slice(0, 5)) console.log(`    extra   ${x.txnDate} ${money(x.amountCents)} ${x.descriptionRaw.slice(0, 50)}`);
    for (const [e, g] of matched.filter(([e, g]) => !similar(e.descriptionRaw, g.descriptionRaw)).slice(0, 3)) {
      console.log(`    desc    "${e.descriptionRaw.slice(0, 45)}" vs "${g.descriptionRaw.slice(0, 45)}"`);
    }
    for (const w of got.warnings.slice(0, 3)) console.log(`    warn    ${w}`);
  }
}

console.log(
  `\n${totals.files} statements: ${totals.exact} read exactly, ${totals.reconciled} reconcile; ` +
    `rows ${totals.rowsMatched}/${totals.rows} matched, descriptions ${totals.desc}/${totals.rowsMatched} alike`,
);
}

main();
