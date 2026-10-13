import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import path from "node:path";
import * as schema from "@/db/schema";
import { dedupeHash } from "@/lib/dedupe";

// Runs on the throwaway database tests/setup.ts points FINANCE_DB at.
let conn: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let actions: typeof import("@/lib/actions");
let queries: typeof import("@/lib/queries");
let accountId: number;

const STREAM = "STREAMCO*PREMIUM, Some Street, SG";

beforeAll(async () => {
  conn = new Database(process.env.FINANCE_DB!);
  db = drizzle(conn, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });

  accountId = db.insert(schema.accounts)
    .values({ name: "Card", institution: "Bank", kind: "credit_card", currency: "SGD", isPocket: false })
    .returning({ id: schema.accounts.id }).get().id;
  const stmt = db.insert(schema.statements)
    .values({
      accountId, filename: "synthetic.pdf", sha256: "x", periodFrom: "2026-01-01", periodTo: "2026-06-30",
      parserName: "test", parserVersion: "0",
    })
    .returning({ id: schema.statements.id }).get();

  for (const m of ["02", "03", "04", "05", "06"]) {
    const row = { accountId, txnDate: `2026-${m}-15`, amountCents: -1598, descriptionRaw: STREAM };
    db.insert(schema.transactions)
      .values({ ...row, statementId: stmt.id, txnType: "expense", dedupeHash: dedupeHash(row) })
      .run();
  }

  actions = await import("@/lib/actions");
  queries = await import("@/lib/queries");
});

afterAll(() => conn.close());

describe("subscription actions", () => {
  it("suggests the repeating charge before anything is tracked", () => {
    const o = queries.subscriptionOverview();
    expect(o.active).toEqual([]);
    expect(o.candidates).toHaveLength(1);
    expect(o.candidates[0]).toMatchObject({ pattern: "STREAMCO*PREMIUM", amountCents: 1598, count: 5 });
  });

  it("tracking a candidate moves it into the monthly total", async () => {
    const c = queries.subscriptionOverview().candidates[0];
    await actions.createSubscription({
      name: "Streaming", pattern: c.pattern, accountId: c.accountId, amountCents: c.amountCents, cadence: c.cadence,
    });
    const o = queries.subscriptionOverview();
    expect(o.candidates).toEqual([]);
    expect(o.active).toHaveLength(1);
    expect(o.active[0]).toMatchObject({ name: "Streaming", monthlyCents: 1598, nextDue: "2026-07-15" });
    expect(o.active[0].health.kind).toBe("on_track");
    expect(o.monthlyTotalCents).toBe(1598);
  });

  it("cancelling keeps the record but leaves the total", async () => {
    const [sub] = queries.subscriptionOverview().active;
    await actions.setSubscriptionStatus(sub.id, "cancelled");
    let o = queries.subscriptionOverview();
    expect(o.monthlyTotalCents).toBe(0);
    expect(o.cancelled.map((r) => r.id)).toEqual([sub.id]);
    expect(db.select().from(schema.subscriptions).where(eq(schema.subscriptions.id, sub.id)).get()!.cancelledAt)
      .not.toBeNull();

    await actions.setSubscriptionStatus(sub.id, "active");
    o = queries.subscriptionOverview();
    expect(o.monthlyTotalCents).toBe(1598);
  });

  it("a dismissed candidate is never suggested again and counts for nothing", async () => {
    await actions.deleteSubscription(queries.subscriptionOverview().active[0].id);
    expect(queries.subscriptionOverview().candidates).toHaveLength(1);

    await actions.dismissCandidate({ pattern: "STREAMCO*PREMIUM", accountId, amountCents: 1598 });
    const o = queries.subscriptionOverview();
    expect(o.candidates).toEqual([]);
    expect(o.active).toEqual([]);
    expect(o.cancelled).toEqual([]);
    expect(o.monthlyTotalCents).toBe(0);
  });

  it("rejects input that is not a subscription", async () => {
    const ok = { name: "X", pattern: "X", accountId: null, amountCents: 100, cadence: "monthly" as const };
    await expect(actions.createSubscription({ ...ok, amountCents: -5 })).rejects.toThrow();
    await expect(actions.createSubscription({ ...ok, name: "  " })).rejects.toThrow();
    await expect(actions.createSubscription({ ...ok, cadence: "daily" as never })).rejects.toThrow();
  });
});
