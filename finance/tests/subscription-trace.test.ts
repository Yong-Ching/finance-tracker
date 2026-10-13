import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { inArray } from "drizzle-orm";
import path from "node:path";
import * as schema from "@/db/schema";
import { dedupeHash } from "@/lib/dedupe";

// Runs on the throwaway database tests/setup.ts points FINANCE_DB at.
let conn: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let actions: typeof import("@/lib/actions");
let queries: typeof import("@/lib/queries");
let small: number[] = []; // the 3.98 plan's charges
let large: number[] = []; // the 29.98 plan's charges, same merchant
let subId: number;
let stmtA: number;
let stmtB: number;

const MERCHANT = "STREAMCO*BILL, Some Street, SG";

beforeAll(async () => {
  conn = new Database(process.env.FINANCE_DB!);
  db = drizzle(conn, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });

  const accountId = db.insert(schema.accounts)
    .values({ name: "Wallet", institution: "Bank", kind: "prepaid", currency: "SGD", isPocket: false })
    .returning({ id: schema.accounts.id }).get().id;
  const stmt = (from: string, to: string, file: string) =>
    db.insert(schema.statements)
      .values({ accountId, filename: file, sha256: file, storedPath: `data/statements/W/${file}`,
        periodFrom: from, periodTo: to, parserName: "test", parserVersion: "0" })
      .returning({ id: schema.statements.id }).get().id;
  stmtA = stmt("2026-01-01", "2026-03-31", "q1.pdf");
  stmtB = stmt("2026-04-01", "2026-06-30", "q2.pdf");

  const add = (date: string, cents: number) => {
    const row = { accountId, txnDate: date, amountCents: -cents, descriptionRaw: MERCHANT };
    return db.insert(schema.transactions)
      .values({ ...row, statementId: date < "2026-04" ? stmtA : stmtB, txnType: "expense", dedupeHash: dedupeHash(row) })
      .returning({ id: schema.transactions.id }).get().id;
  };
  // Monthly 3.98, except April is missing. And a 29.98 plan billed under the same name.
  small = ["2026-01-15", "2026-02-15", "2026-03-15", "2026-05-15", "2026-06-15"].map((d) => add(d, 398));
  large = ["2026-01-02", "2026-02-02", "2026-03-02", "2026-04-02", "2026-05-02", "2026-06-02"].map((d) => add(d, 2998));

  actions = await import("@/lib/actions");
  queries = await import("@/lib/queries");
  subId = await actions.createSubscription({
    name: "Storage", pattern: "STREAMCO*BILL", accountId, amountCents: 398, cadence: "monthly",
  });
});

afterAll(() => conn.close());

describe("tracing a subscription to its charges and statements", () => {
  it("returns exactly its own charges, not the other plan at the same merchant", () => {
    expect(queries.subscriptionChargeIds(subId).sort((a, b) => a - b)).toEqual(small);
  });

  it("the Transactions filter shows exactly those charges", () => {
    const { rows, total, sumCents } = queries.listTransactions({ subscriptionId: subId });
    expect(total).toBe(5);
    expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual(small);
    expect(sumCents).toBe(-5 * 398);
  });

  it("an unknown subscription matches nothing rather than everything", () => {
    expect(queries.listTransactions({ subscriptionId: 999_999 }).total).toBe(0);
  });

  it("a bulk edit under the subscription filter touches only its charges", async () => {
    const cat = db.insert(schema.categories).values({ name: "Subscriptions", bucket: "expense" })
      .returning({ id: schema.categories.id }).get().id;
    const n = await actions.bulkSetCategoryForFilter({ subscriptionId: subId }, cat);
    expect(n).toBe(5);
    const got = db.select({ id: schema.transactions.id, c: schema.transactions.categoryId })
      .from(schema.transactions).where(inArray(schema.transactions.id, [...small, ...large])).all();
    expect(got.filter((r) => r.c === cat).map((r) => r.id).sort((a, b) => a - b)).toEqual(small);
  });

  it("the history links each charge to its statement and marks the missed month", () => {
    const d = queries.subscriptionDetail(subId)!;
    const lines = d.history.map((e) =>
      e.kind === "missed" ? `missed ${e.due}` : `${e.charge.txnDate} ${d.statements[e.charge.statementId!].filename}`);
    expect(lines).toEqual([
      "2026-06-15 q2.pdf", "2026-05-15 q2.pdf", "missed 2026-04-15",
      "2026-03-15 q1.pdf", "2026-02-15 q1.pdf", "2026-01-15 q1.pdf",
    ]);
    expect(d.paidCents).toBe(5 * 398);
    expect(d.statements[stmtA]).toMatchObject({ periodFrom: "2026-01-01", periodTo: "2026-03-31", hasFile: true });
  });

  it("a suggestion carries the charges and statements it rests on", () => {
    const o = queries.subscriptionOverview();
    const c = o.candidates.find((x) => x.amountCents === 2998)!;
    expect(c.charges.map((x) => x.id)).toEqual(large);
    expect(o.statements[stmtB].filename).toBe("q2.pdf");
  });
});
