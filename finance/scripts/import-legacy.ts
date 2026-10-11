/**
 * One-shot Phase 0 import: the 464 transactions the Python parser already
 * produced, re-classified through the new rule engine.
 *
 * This exists to prove the new pipeline reproduces the old numbers before any
 * PDF parsing is written. Phase 1 re-imports the same months from the source
 * PDFs; these rows carry statementId = null and are replaced then.
 */
import fs from "node:fs";
import path from "node:path";
import { eq, isNull } from "drizzle-orm";
import { openDb, schema } from "../src/db/raw";
import { parseCsv, ddmmyyyyToIso } from "../src/lib/csv";
import { fromFloat, formatCents } from "../src/lib/money";
import { dedupeHash } from "../src/lib/dedupe";
import { classify, byPriority } from "../src/lib/classify";

const ROOT = path.resolve(process.cwd(), "..");
const CSV = path.join(ROOT, "data", "transactions.csv");

function main() {
  const { db, conn } = openDb();

  const account = db.select().from(schema.accounts).where(eq(schema.accounts.name, "DBS")).get();
  if (!account) throw new Error("run `npm run db:seed` first");

  const rows = parseCsv(fs.readFileSync(CSV, "utf8"));
  const rules = byPriority(db.select().from(schema.rules).all());
  const catById = new Map(db.select().from(schema.categories).all().map((c) => [c.id, c.name]));
  const catByName = new Map(db.select().from(schema.categories).all().map((c) => [c.name, c.id]));

  // ---- one-offs -> overrides, resolved against the real description text ----
  const oneOffs: Array<{ date: string; amount: number; desc: string; cat: string; kind: string; note?: string }> =
    JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "legacy-one-offs.json"), "utf8"));

  db.delete(schema.overrides).run();
  let overridesWritten = 0;
  const unresolvedOneOffs: string[] = [];

  for (const o of oneOffs) {
    const iso = ddmmyyyyToIso(o.date);
    const cents = fromFloat(o.amount);
    // date + amount alone collided in the legacy data; the desc fragment is
    // what disambiguates, exactly as the old parser required.
    const hits = rows.filter(
      (r) =>
        ddmmyyyyToIso(r.date) === iso &&
        fromFloat(Number(r.amount)) === cents &&
        r.desc.toUpperCase().includes(o.desc.toUpperCase()),
    );
    if (hits.length !== 1) {
      unresolvedOneOffs.push(`${o.date} ${o.amount} "${o.desc}" -> ${hits.length} matches`);
      continue;
    }
    const hash = dedupeHash({
      accountId: account.id,
      txnDate: iso,
      amountCents: cents,
      descriptionRaw: hits[0].desc,
    });
    db.insert(schema.overrides)
      .values({
        dedupeHash: hash,
        categoryId: catByName.get(o.cat) ?? null,
        txnType: o.kind === "income" ? "income" : o.kind === "savings" ? "savings" : "expense",
        note: o.note ?? null,
      })
      .onConflictDoNothing()
      .run();
    overridesWritten++;
  }

  const overrides = new Map(
    db.select().from(schema.overrides).all().map((o) => [o.dedupeHash, o]),
  );

  // ---- transactions -------------------------------------------------------
  db.delete(schema.transactions).where(isNull(schema.transactions.statementId)).run();

  const diffs: Array<{ date: string; desc: string; amount: number; was: string; now: string }> = [];
  let inserted = 0;

  db.transaction((tx0) => {
    for (const r of rows) {
      const txnDate = ddmmyyyyToIso(r.date);
      const amountCents = fromFloat(Number(r.amount));
      const tx = { accountId: account.id, txnDate, amountCents, descriptionRaw: r.desc };
      const hash = dedupeHash(tx);
      const c = classify(tx, rules, overrides.get(hash));

      const wasCat = r.category;
      const nowCat = c.categoryId ? catById.get(c.categoryId)! : "Uncategorized";
      if (wasCat !== nowCat) {
        diffs.push({ date: r.date, desc: r.desc.slice(0, 60), amount: Number(r.amount), was: wasCat, now: nowCat });
      }

      db.insert(schema.transactions)
        .values({
          statementId: null,
          accountId: account.id,
          txnDate,
          descriptionRaw: r.desc,
          amountCents,
          balanceAfterCents: r.balance ? fromFloat(Number(r.balance)) : null,
          categoryId: c.categoryId,
          txnType: c.txnType,
          seen: c.seen,
          note: c.note,
          isReviewed: c.isReviewed,
          matchedRuleId: c.matchedRuleId,
          dedupeHash: hash,
        })
        .run();
      inserted++;
    }
  });

  conn.close();

  console.log(`imported ${inserted} transactions, ${overridesWritten} overrides`);
  if (unresolvedOneOffs.length) {
    console.log("\nUNRESOLVED one-offs (needs attention):");
    for (const u of unresolvedOneOffs) console.log("  " + u);
  }

  // ---- the diff you were asked to review ----------------------------------
  const byPair = new Map<string, number>();
  for (const d of diffs) {
    const k = `${d.was}  ->  ${d.now}`;
    byPair.set(k, (byPair.get(k) ?? 0) + 1);
  }
  console.log(`\nclassification differences vs legacy: ${diffs.length} of ${inserted}`);
  for (const [k, n] of [...byPair].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${k}`);
  }
  fs.writeFileSync(
    path.join(process.cwd(), "data", "legacy-diff.json"),
    JSON.stringify(diffs, null, 2),
  );
  console.log("\nfull diff written to data/legacy-diff.json");
}

main();
