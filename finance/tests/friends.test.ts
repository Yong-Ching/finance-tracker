import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { dedupeHash } from "@/lib/dedupe";

// Runs on the throwaway database tests/setup.ts points FINANCE_DB at.
let conn: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let actions: typeof import("@/lib/actions");
let queries: typeof import("@/lib/queries");
let friends: number;
let transfers: number;
const txn: Record<string, number> = {};

const JULY = { from: "2026-07-01", to: "2026-07-31", label: "July", key: "2026-07" };

beforeAll(async () => {
  conn = new Database(process.env.FINANCE_DB!);
  db = drizzle(conn, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  const accountId = db.insert(schema.accounts)
    .values({ name: "Bank", institution: "Bank", kind: "bank", currency: "SGD", isPocket: false })
    .returning({ id: schema.accounts.id }).get().id;
  const category = (name: string, bucket: schema.Bucket) =>
    db.insert(schema.categories).values({ name, bucket }).returning({ id: schema.categories.id }).get().id;
  category("Salary", "income");
  friends = category("Paid for friends", "expense");
  transfers = category("Transfer received", "transfer");

  // Synthetic: [key, day, cents, description, type as imported]. Negative = money out.
  const rows: Array<[string, number, number, string, schema.TxnType]> = [
    ["salary", 1, 500_000, "SALARY", "income"],
    ["concert", 3, -20_000, "TWO CONCERT TICKETS", "expense"],
    ["paidBack", 9, 10_000, "INCOMING PAYNOW FRIEND", "income"],
    ["dinner", 12, -6_000, "DINNER FOR A FRIEND", "expense"],
    ["dinnerBack", 20, 6_000, "INCOMING PAYNOW FRIEND", "income"],
  ];
  for (const [key, day, amountCents, descriptionRaw, txnType] of rows) {
    const row = { accountId, txnDate: `2026-07-${String(day).padStart(2, "0")}`, amountCents, descriptionRaw };
    txn[key] = db.insert(schema.transactions)
      .values({ ...row, txnType, dedupeHash: dedupeHash(row) })
      .returning({ id: schema.transactions.id }).get().id;
  }
  actions = await import("@/lib/actions");
  queries = await import("@/lib/queries");
});

afterAll(() => conn.close());

const typeOf = (id: number) =>
  db.select({ t: schema.transactions.txnType }).from(schema.transactions).where(eq(schema.transactions.id, id)).get()!.t;

describe("paying for a friend who pays it back", () => {
  it("a repayment counts as income until it is filed", () => {
    expect(queries.totals(JULY).incomeCents).toBe(516_000);
  });

  it("filing a repayment under an expense category makes it reduce spending, not add income", async () => {
    await actions.updateTransaction(txn.paidBack, { categoryId: friends });
    expect(typeOf(txn.paidBack)).toBe("expense");
    await actions.bulkSetCategory([txn.dinner, txn.dinnerBack, txn.concert], friends);
    expect(typeOf(txn.dinnerBack)).toBe("expense");

    const t = queries.totals(JULY);
    expect(t.incomeCents).toBe(500_000);
    // 200 + 60 paid out, 100 + 60 paid back: the friend still owes 100.
    expect(t.expenseCents).toBe(10_000);
    const slice = queries.expenseByCategory(JULY).find((c) => c.categoryId === friends)!;
    expect(slice.totalCents).toBe(10_000);
  });

  it("a category repaid more than was spent in a period shows as negative, not as spending", () => {
    // The dinner was paid on the 12th and repaid on the 20th: a window holding only the repayment.
    const late = { from: "2026-07-15", to: "2026-07-31", label: "late July", key: "late" };
    const slice = queries.expenseByCategory(late).find((c) => c.categoryId === friends)!;
    expect(slice.totalCents).toBe(-6_000);
    expect(queries.totals(late).expenseCents).toBe(-6_000);
  });

  it("a type chosen alongside the category wins, and a transfer category implies none", async () => {
    await actions.updateTransaction(txn.salary, { categoryId: friends, txnType: "income" });
    expect(typeOf(txn.salary)).toBe("income");
    await actions.updateTransaction(txn.salary, { categoryId: transfers });
    expect(typeOf(txn.salary)).toBe("income");
  });
});
