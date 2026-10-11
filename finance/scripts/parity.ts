/**
 * Phase 0 gate: the new database must reproduce the legacy money figures.
 *
 * Classification differences are expected and reviewed separately (see
 * import-legacy.ts). What must NOT differ is the money: the same rows, the same
 * amounts, the same monthly flows, the same opening and closing balance.
 */
import fs from "node:fs";
import path from "node:path";
import { openDb, schema } from "../src/db/raw";
import { formatCents, fromFloat } from "../src/lib/money";

const legacy = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "..", "data", "summary.json"), "utf8"),
);

const { db, conn } = openDb();

// The legacy summary covered DBS only, so the comparison must too. Other
// accounts are verified by their own statements' continuity checks.
const dbs = db.select().from(schema.accounts).all().find((a) => a.name === "DBS")!;
const txs = db.select().from(schema.transactions).all().filter((t) => t.accountId === dbs.id);
const cats = new Map(db.select().from(schema.categories).all().map((c) => [c.id, c]));
conn.close();

let failures = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        got ${got}\n        want ${want}`);
};

console.log("=== row-level (DBS only; the legacy summary covered DBS alone) ===");
check("transaction count", txs.length, legacy.transactions);

const total = txs.reduce((a, t) => a + t.amountCents, 0);
const expectedNet = fromFloat(legacy.closing_balance) - fromFloat(legacy.opening_balance);
check("net movement = closing - opening", formatCents(total), formatCents(expectedNet));

const balances = txs
  .filter((t) => t.balanceAfterCents !== null)
  .sort((a, b) => (a.txnDate < b.txnDate ? -1 : 1));
check(
  "closing balance",
  formatCents(balances[balances.length - 1].balanceAfterCents!),
  formatCents(fromFloat(legacy.closing_balance)),
);

console.log("\n=== monthly flows (all amounts, sign-preserving) ===");
const legacyMonthly = new Map<string, number>();
for (const [month, kinds] of Object.entries<Record<string, number>>(legacy.by_month)) {
  legacyMonthly.set(month, fromFloat(Object.values(kinds).reduce((a, b) => a + b, 0)));
}
const newMonthly = new Map<string, number>();
for (const t of txs) {
  const m = t.txnDate.slice(0, 7);
  newMonthly.set(m, (newMonthly.get(m) ?? 0) + t.amountCents);
}
for (const month of [...legacyMonthly.keys()].sort()) {
  check(`  ${month}`, formatCents(newMonthly.get(month) ?? 0), formatCents(legacyMonthly.get(month)!));
}

console.log("\n=== bucket reconciliation ===");
const byType = new Map<string, number>();
for (const t of txs) byType.set(t.txnType, (byType.get(t.txnType) ?? 0) + t.amountCents);

const legacyKind = legacy.by_kind as Record<string, number>;
console.log("legacy:");
for (const [k, v] of Object.entries(legacyKind)) console.log(`  ${k.padEnd(20)} ${formatCents(fromFloat(v))}`);
console.log("new:");
for (const [k, v] of [...byType].sort()) console.log(`  ${k.padEnd(20)} ${formatCents(v)}`);

// The one intended structural change: pocket top-ups left `spending` and became
// `internal_transfer`. Legacy spending minus the pockets must equal new expense.
const transfers = byType.get("internal_transfer") ?? 0;
const legacySpending = fromFloat(legacyKind.spending ?? 0);
check(
  "legacy spending - pocket transfers = new expense",
  formatCents(byType.get("expense") ?? 0),
  formatCents(legacySpending - transfers),
);
check(
  "pocket transfers = legacy unseen_total",
  formatCents(Math.abs(transfers)),
  formatCents(fromFloat(legacy.unseen_total)),
);

console.log("\n=== invariant: transfers never enter a reporting bucket ===");
const reporting = ["income", "expense", "savings", "debt_repayment"];
const reportingSum = txs
  .filter((t) => reporting.includes(t.txnType))
  .reduce((a, t) => a + t.amountCents, 0);
check("reporting buckets + transfers = all amounts", formatCents(reportingSum + transfers), formatCents(total));

console.log("\n=== review queue ===");
const unreviewed = txs.filter((t) => !t.isReviewed);
console.log(`  ${unreviewed.length} transactions need a category`);
console.log(`  ${formatCents(unreviewed.reduce((a, t) => a + t.amountCents, 0))} of unclassified flow`);

console.log(failures === 0 ? "\nALL PARITY CHECKS PASSED" : `\n${failures} PARITY CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
