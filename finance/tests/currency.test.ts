import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import * as schema from "@/db/schema";
import { dedupeHash } from "@/lib/dedupe";
import { formatInColumn, formatMoney } from "@/lib/money";

// Runs on the throwaway database tests/setup.ts points FINANCE_DB at.
let conn: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let queries: typeof import("@/lib/queries");
let sgd: number;
let myr: number;

const JUNE = { from: "2026-06-01", to: "2026-06-30", label: "June", key: "2026-06" };

beforeAll(async () => {
  conn = new Database(process.env.FINANCE_DB!);
  db = drizzle(conn, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  const account = (name: string, currency: string) =>
    db.insert(schema.accounts)
      .values({ name, institution: name, kind: "bank", currency, isPocket: false })
      .returning({ id: schema.accounts.id }).get().id;
  sgd = account("SG Bank", "SGD");
  myr = account("MY Bank", "MYR");

  // Synthetic: [account, day, cents, description]. Negative = money out.
  const rows: Array<[number, number, number, string]> = [
    [sgd, 1, 500_000, "SALARY"],
    [sgd, 2, -12_000, "GROCER"],
    [myr, 3, 30_000, "GIRO CR"],
    [myr, 4, -10_000, "TOLL TOP UP"],
  ];
  for (const [accountId, day, amountCents, descriptionRaw] of rows) {
    const row = { accountId, txnDate: `2026-06-0${day}`, amountCents, descriptionRaw };
    db.insert(schema.transactions)
      .values({ ...row, txnType: amountCents > 0 ? "income" : "expense", dedupeHash: dedupeHash(row) })
      .run();
  }
  queries = await import("@/lib/queries");
});

afterAll(() => conn.close());

describe("an account in another currency", () => {
  it("stays out of the combined SGD totals", () => {
    const t = queries.totals(JUNE);
    expect(t.incomeCents).toBe(500_000);
    expect(t.expenseCents).toBe(12_000);
    expect(queries.byMonth()).toEqual([
      expect.objectContaining({ month: "2026-06", incomeCents: 500_000, expenseCents: 12_000 }),
    ]);
    expect(queries.expenseByCategory(JUNE).reduce((a, c) => a + c.totalCents, 0)).toBe(12_000);
  });

  it("is totalled on its own, in its own currency", () => {
    const t = queries.totals(JUNE, myr);
    expect(t.incomeCents).toBe(30_000);
    expect(t.expenseCents).toBe(10_000);
    const card = queries.accountCards(JUNE).find((a) => a.id === myr)!;
    expect(card.currency).toBe("MYR");
    expect(card.flowCents).toBe(20_000);
  });

  it("is summed apart from SGD when a list spans both", () => {
    const { total, sums, rows } = queries.listTransactions({});
    expect(total).toBe(4);
    expect(sums).toEqual([
      { currency: "SGD", cents: 488_000 },
      { currency: "MYR", cents: 20_000 },
    ]);
    expect(rows.find((r) => r.descriptionRaw === "TOLL TOP UP")!.currency).toBe("MYR");
  });

  it("is written so a ringgit figure cannot pass for dollars", () => {
    expect(formatMoney(-10_000, "MYR")).toBe("-RM100.00");
    expect(formatInColumn(-10_000, "MYR")).toBe("-RM100.00");
    expect(formatInColumn(-10_000, "SGD")).toBe("-100.00");
  });
});
