import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { dedupeHash } from "@/lib/dedupe";
import { classify } from "@/lib/classify";

// Runs on the throwaway database tests/setup.ts points FINANCE_DB at.
let conn: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let actions: typeof import("@/lib/actions");
let queries: typeof import("@/lib/queries");
let accountId: number;
let food: number;
const txn: Record<string, number> = {};

beforeAll(async () => {
  conn = new Database(process.env.FINANCE_DB!);
  db = drizzle(conn, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  accountId = db.insert(schema.accounts)
    .values({ name: "Bank", institution: "Bank", kind: "bank", currency: "SGD", isPocket: false })
    .returning({ id: schema.accounts.id }).get().id;
  food = db.insert(schema.categories).values({ name: "Food", bucket: "expense" })
    .returning({ id: schema.categories.id }).get().id;

  // Synthetic: [key, cents, description]. Imported uncategorised, so awaiting review.
  for (const [key, amountCents, descriptionRaw] of [
    ["vague", -10_000, "ACME RESTAURANT"],
    ["plain", -500, "ACME BAKERY"],
  ] as const) {
    const row = { accountId, txnDate: "2000-01-01", amountCents, descriptionRaw };
    txn[key] = db.insert(schema.transactions)
      .values({ ...row, txnType: "expense", isReviewed: false, dedupeHash: dedupeHash(row) })
      .returning({ id: schema.transactions.id }).get().id;
  }
  actions = await import("@/lib/actions");
  queries = await import("@/lib/queries");
});

afterAll(() => conn.close());

const row = (id: number) => db.select().from(schema.transactions).where(eq(schema.transactions.id, id)).get()!;
const overrideFor = (id: number) =>
  db.select().from(schema.overrides).where(eq(schema.overrides.dedupeHash, row(id).dedupeHash)).get();

describe("a remark on a transaction", () => {
  it("is saved without taking an uncategorised row out of the review queue", async () => {
    await actions.updateTransaction(txn.vague, { note: "Team lunch, paid for everyone" });
    expect(row(txn.vague).note).toBe("Team lunch, paid for everyone");
    expect(row(txn.vague).isReviewed).toBe(false);
    expect(row(txn.vague).categoryId).toBeNull();
  });

  it("survives a re-import, still awaiting a category", () => {
    const o = overrideFor(txn.vague)!;
    expect(o.note).toBe("Team lunch, paid for everyone");
    const c = classify(row(txn.vague), [], { ...o, seen: o.seen ?? null, txnType: o.txnType ?? null });
    expect(c.note).toBe("Team lunch, paid for everyone");
    expect(c.isReviewed).toBe(false);
  });

  it("is kept when the row is categorised afterwards", async () => {
    await actions.updateTransaction(txn.vague, { categoryId: food });
    expect(row(txn.vague).note).toBe("Team lunch, paid for everyone");
    expect(row(txn.vague).isReviewed).toBe(true);
  });

  it("is found by search, alongside the description", () => {
    const hit = queries.listTransactions({ q: "team lunch" });
    expect(hit.rows.map((r) => r.id)).toEqual([txn.vague]);
    expect(queries.listTransactions({ q: "bakery" }).rows.map((r) => r.id)).toEqual([txn.plain]);
  });

  it("is removed by saving it empty", async () => {
    await actions.updateTransaction(txn.vague, { note: null });
    expect(row(txn.vague).note).toBeNull();
    expect(queries.listTransactions({ q: "team lunch" }).total).toBe(0);
  });
});
