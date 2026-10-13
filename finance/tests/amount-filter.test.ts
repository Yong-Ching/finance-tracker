import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import * as schema from "@/db/schema";
import { dedupeHash } from "@/lib/dedupe";

// Runs on the throwaway database tests/setup.ts points FINANCE_DB at.
let conn: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let actions: typeof import("@/lib/actions");
let queries: typeof import("@/lib/queries");

// Synthetic: [amount in cents, description]. Negative = money out.
const ROWS: Array<[number, string]> = [
  [-398, "CLOUD STORAGE"],
  [398, "REFUND CLOUD STORAGE"],
  [-1250, "LUNCH"],
  [-2998, "STREAMING"],
  [-3100, "STREAMING FX"],
  [-75_000, "RENT"],
  [500_000, "SALARY"],
];

beforeAll(async () => {
  conn = new Database(process.env.FINANCE_DB!);
  db = drizzle(conn, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  const accountId = db.insert(schema.accounts)
    .values({ name: "Bank", institution: "Bank", kind: "bank", currency: "SGD", isPocket: false })
    .returning({ id: schema.accounts.id }).get().id;
  ROWS.forEach(([amountCents, descriptionRaw], i) => {
    const row = { accountId, txnDate: `2026-06-${String(i + 1).padStart(2, "0")}`, amountCents, descriptionRaw };
    db.insert(schema.transactions)
      .values({ ...row, txnType: amountCents > 0 ? "income" : "expense", dedupeHash: dedupeHash(row) })
      .run();
  });
  actions = await import("@/lib/actions");
  queries = await import("@/lib/queries");
});

afterAll(() => conn.close());

const found = (amount: string) =>
  queries.listTransactions({ amount }).rows.map((r) => r.descriptionRaw).sort();

describe("searching transactions by amount", () => {
  it("an exact amount finds it in both directions", () => {
    expect(found("3.98")).toEqual(["CLOUD STORAGE", "REFUND CLOUD STORAGE"]);
  });

  it("a sign narrows to money out or money in", () => {
    expect(found("-3.98")).toEqual(["CLOUD STORAGE"]);
    expect(found("+3.98")).toEqual(["REFUND CLOUD STORAGE"]);
  });

  it("a range is inclusive at both ends", () => {
    expect(found("12.50-31")).toEqual(["LUNCH", "STREAMING", "STREAMING FX"]);
  });

  it("comparisons and 'roughly'", () => {
    expect(found(">750")).toEqual(["SALARY"]);
    expect(found(">=750")).toEqual(["RENT", "SALARY"]);
    expect(found("<12.50")).toEqual(["CLOUD STORAGE", "REFUND CLOUD STORAGE"]);
    expect(found("~30")).toEqual(["STREAMING", "STREAMING FX"]);
  });

  it("combines with the other filters", () => {
    expect(queries.listTransactions({ amount: "~30", q: "FX" }).rows.map((r) => r.descriptionRaw)).toEqual(["STREAMING FX"]);
  });

  it("an unreadable amount matches nothing instead of everything", () => {
    expect(queries.listTransactions({ amount: "abc" }).total).toBe(0);
    expect(queries.listTransactions({ amount: "  " }).total).toBe(ROWS.length);
  });

  it("a bulk edit under an amount filter touches only those rows", async () => {
    const cat = db.insert(schema.categories).values({ name: "Streaming", bucket: "expense" })
      .returning({ id: schema.categories.id }).get().id;
    expect(await actions.bulkSetCategoryForFilter({ amount: "-~30" }, cat)).toBe(2);
    const tagged = db.select().from(schema.transactions).all()
      .filter((r) => r.categoryId === cat).map((r) => r.descriptionRaw).sort();
    expect(tagged).toEqual(["STREAMING", "STREAMING FX"]);
  });
});
