/**
 * Phase 1 backfill: re-import every statement PDF through the real pipeline,
 * replacing the Phase 0 CSV rows.
 */
import fs from "node:fs";
import path from "node:path";
import { and, eq, like, sql } from "drizzle-orm";
import { openDb, schema } from "../src/db/raw";
import { ingestPdf } from "../src/lib/ingest";
import { dedupeHash } from "../src/lib/dedupe";
import { formatCents, fromFloat } from "../src/lib/money";
import { classify, byPriority } from "../src/lib/classify";

const SRC = path.resolve(process.cwd(), "..", "data", "statements");

async function main() {
  const { db, conn } = openDb();

  if (process.argv.includes("--reset")) {
    db.delete(schema.transferLinks).run();
    db.delete(schema.transactions).run();
    db.delete(schema.statements).run();
    console.log("cleared transactions and statements\n");
  }

  // Every account folder under data/statements. The parser is chosen by
  // content, not by folder name, so a misfiled statement still lands correctly.
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
  const files = fs
    .readdirSync(SRC, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (!only || d.name.toLowerCase() === only.toLowerCase()))
    .flatMap((d) =>
      fs
        .readdirSync(path.join(SRC, d.name))
        .filter((f) => f.toLowerCase().endsWith(".pdf"))
        .map((f) => path.join(SRC, d.name, f)),
    )
    .sort();

  for (const f of files) {
    const out = await ingestPdf(db, {
      buffer: new Uint8Array(fs.readFileSync(f)),
      filename: path.basename(f),
    });
    console.log(
      `${path.basename(f).padEnd(26)} ${(out.accountName ?? "?").padEnd(9)} ${out.status.padEnd(12)} ` +
        `${String(out.inserted).padStart(3)} in, ${out.skippedExisting} dup, ` +
        `${out.needsReview} to review, continuity ${out.continuityDelta}` +
        (out.message ? `  -- ${out.message}` : ""),
    );
  }

  // --- re-attach the legacy one-offs to the freshly parsed descriptions -----
  const oneOffs: Array<{ date: string; amount: number; desc: string; cat: string; kind: string; note?: string }> =
    JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "legacy-one-offs.json"), "utf8"));
  const catByName = new Map(db.select().from(schema.categories).all().map((c) => [c.name, c.id]));

  let attached = 0;
  for (const o of oneOffs) {
    const [d, m, y] = o.date.split("/");
    const iso = `${y}-${m}-${d}`;
    const cents = fromFloat(o.amount);
    const hits = db
      .select()
      .from(schema.transactions)
      .where(and(eq(schema.transactions.txnDate, iso), eq(schema.transactions.amountCents, cents)))
      .all()
      .filter((t) => t.descriptionRaw.toUpperCase().includes(o.desc.toUpperCase()));

    if (hits.length !== 1) {
      console.log(`  ! one-off ${o.date} ${o.amount} "${o.desc}" matched ${hits.length} rows`);
      continue;
    }
    const t = hits[0];
    const categoryId = catByName.get(o.cat) ?? null;
    const txnType = o.kind === "income" ? "income" : o.kind === "savings" ? "savings" : "expense";
    db.insert(schema.overrides)
      .values({ dedupeHash: t.dedupeHash, categoryId, txnType, note: o.note ?? null })
      .onConflictDoUpdate({
        target: schema.overrides.dedupeHash,
        set: { categoryId, txnType, note: o.note ?? null },
      })
      .run();
    db.update(schema.transactions)
      .set({ categoryId, txnType, note: o.note ?? null, isReviewed: true })
      .where(eq(schema.transactions.id, t.id))
      .run();
    attached++;
  }
  console.log(`\n${attached}/${oneOffs.length} one-off overrides re-attached`);

  const total = db.select({ n: sql<number>`count(*)` }).from(schema.transactions).get()!.n;
  const review = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.transactions)
    .where(eq(schema.transactions.isReviewed, false))
    .get()!.n;
  console.log(`${total} transactions in database, ${review} awaiting a category`);

  conn.close();
}
main();
