import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import * as schema from "@/db/schema";
import { dedupeHash } from "@/lib/dedupe";
import type { Fx } from "@/lib/fx";

// Runs on the throwaway database tests/setup.ts points FINANCE_DB at. Synthetic data only.
let conn: Database.Database;
let queries: typeof import("@/lib/queries");
const view = (mode: string): Fx => ({ mode, perBase: { SGD: 1, MYR: 3 }, asOf: "2000-01-01", currencies: ["SGD", "MYR"] });
const period = { from: "2000-01-01", to: "2000-01-31", label: "", key: "2000-01" };

beforeAll(async () => {
  conn = new Database(process.env.FINANCE_DB!);
  const db = drizzle(conn, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  const account = (name: string, currency: string) => db.insert(schema.accounts)
    .values({ name, institution: "Bank", kind: "bank", currency, isPocket: false })
    .returning({ id: schema.accounts.id }).get().id;
  const sg = account("SG bank", "SGD");
  const my = account("MY bank", "MYR");
  const add = (accountId: number, amountCents: number, txnType: "income" | "expense", descriptionRaw: string) => {
    const row = { accountId, txnDate: "2000-01-10", amountCents, descriptionRaw };
    db.insert(schema.transactions).values({ ...row, txnType, dedupeHash: dedupeHash(row) }).run();
  };
  add(sg, 100_000, "income", "ACME PAYROLL");
  add(sg, -20_000, "expense", "ACME RESTAURANT");
  add(my, -30_000, "expense", "ACME GROCER");
  queries = await import("@/lib/queries");
});

afterAll(() => conn.close());

describe("totals in a currency view", () => {
  it("keeps ringgit out of the original view's SGD totals", () => {
    const t = queries.totals(period);
    expect(t).toMatchObject({ incomeCents: 100_000, expenseCents: 20_000, count: 2 });
  });
  it("adds every account in SGD, converted", () => {
    const t = queries.totals(period, undefined, view("SGD"));
    expect(t).toMatchObject({ incomeCents: 100_000, expenseCents: 30_000, count: 3 });
  });
  it("adds every account in MYR, converted", () => {
    const t = queries.totals(period, undefined, view("MYR"));
    expect(t).toMatchObject({ incomeCents: 300_000, expenseCents: 90_000 });
    expect(queries.byMonth(undefined, view("MYR"))[0]).toMatchObject({ incomeCents: 300_000, expenseCents: 90_000 });
    expect(queries.expenseByCategory(period, undefined, 5, view("MYR"))[0].totalCents).toBe(90_000);
  });
  it("sums a transaction list once, in the view's currency", () => {
    expect(queries.listTransactions({}).sums).toEqual([
      { currency: "SGD", cents: 80_000 }, { currency: "MYR", cents: -30_000 },
    ]);
    expect(queries.listTransactions({}, view("SGD")).sums).toEqual([{ currency: "SGD", cents: 70_000 }]);
  });
  it("never changes a stored amount", () => {
    queries.totals(period, undefined, view("MYR"));
    expect(conn.prepare("select sum(amount_cents) s from transactions").get()).toEqual({ s: 50_000 });
  });
});
