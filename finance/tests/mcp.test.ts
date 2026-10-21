import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as schema from "@/db/schema";
import { dedupeHash } from "@/lib/dedupe";

// Runs on the throwaway database tests/setup.ts points FINANCE_DB at.
let conn: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let client: Client;
const txn: Record<string, number> = {};

beforeAll(async () => {
  conn = new Database(process.env.FINANCE_DB!);
  db = drizzle(conn, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  const account = (name: string, currency: string) => db.insert(schema.accounts)
    .values({ name, institution: name, kind: "bank", currency, isPocket: false })
    .returning({ id: schema.accounts.id }).get().id;
  const sg = account("SG Bank", "SGD");
  const my = account("MY Bank", "MYR");
  db.insert(schema.categories).values([
    { name: "Food", bucket: "expense" },
    { name: "Transport", bucket: "expense" },
    { name: "Salary", bucket: "income" },
  ]).run();

  // Synthetic: [key, account, day, cents, description]. All imported uncategorised.
  const rows: Array<[string, number, number, number, string]> = [
    ["bus1", my, 1, -100, "SALE DEBIT ACME BUS TERMINAL"],
    ["bus2", my, 2, -200, "SALE DEBIT ACME BUS TERMINAL"],
    ["bus3", my, 3, -100, "SALE DEBIT ACME BUS TERMINAL"],
    ["cafe", my, 4, -1_500, "SALE DEBIT ACME CAFE"],
    ["pay", sg, 5, 500_000, "ACME CORP SALARY"],
    ["lunch", sg, 6, -1_200, "ACME NOODLES"],
  ];
  for (const [key, accountId, day, amountCents, descriptionRaw] of rows) {
    const row = { accountId, txnDate: `2000-01-0${day}`, amountCents, descriptionRaw };
    txn[key] = db.insert(schema.transactions)
      .values({ ...row, txnType: amountCents > 0 ? "income" : "expense", isReviewed: false, dedupeHash: dedupeHash(row) })
      .returning({ id: schema.transactions.id }).get().id;
  }

  const { createFinanceServer } = await import("@/mcp/tools");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([createFinanceServer().connect(serverSide), client.connect(clientSide)]);
});

afterAll(async () => {
  await client.close();
  conn.close();
});

/** Calls a tool and parses its JSON reply. */
async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0].text;
  if (res.isError) throw new Error(text);
  return JSON.parse(text);
}
const txnRow = (id: number) => db.select().from(schema.transactions).where(eq(schema.transactions.id, id)).get()!;

describe("the MCP server", () => {
  it("offers the tools, marking which only read", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "categorize", "create_category", "create_rule", "find_transactions", "group_transactions",
      "list_accounts", "list_categories", "list_rules", "set_remark", "summarize",
    ]);
    expect(tools.find((t) => t.name === "find_transactions")!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "categorize")!.annotations?.readOnlyHint).toBe(false);
  });

  it("reports each amount in its account's currency", async () => {
    const r = await call("find_transactions", { account: "MY Bank" });
    expect(r.total).toBe(4);
    expect(r.sums).toEqual([{ currency: "MYR", amount: -19 }]);
    expect(r.transactions[0]).toMatchObject({ currency: "MYR", account: "MY Bank", needs_review: true });
  });

  it("groups uncategorised transactions by merchant, with every id", async () => {
    const r = await call("group_transactions", { category: "none" });
    const bus = r.groups[0];
    expect(bus).toMatchObject({ account: "MY Bank", count: 3, total: -4, currency: "MYR" });
    expect(bus.transaction_ids.sort()).toEqual([txn.bus1, txn.bus2, txn.bus3].sort());
  });

  it("files a whole group in one call, as a manual edit, after backing up once", async () => {
    const backups = path.join(path.dirname(process.env.FINANCE_DB!), "backups");
    const ids = [txn.bus1, txn.bus2, txn.bus3];
    const r = await call("categorize", { transaction_ids: ids, category: "transport" });
    expect(r).toEqual({ updated: 3, not_found: 0, category: "Transport" });
    expect(txnRow(txn.bus1).isReviewed).toBe(true);
    const override = db.select().from(schema.overrides).where(eq(schema.overrides.dedupeHash, txnRow(txn.bus1).dedupeHash)).get();
    expect(override?.categoryId).toBe(txnRow(txn.bus1).categoryId);
    expect(fs.readdirSync(backups).filter((f) => f.endsWith("-before-mcp.db"))).toHaveLength(1);

    await call("categorize", { transaction_ids: [txn.cafe], category: "Food" });
    expect(fs.readdirSync(backups).filter((f) => f.endsWith("-before-mcp.db"))).toHaveLength(1);
  });

  it("creates a rule that files existing rows and states how many", async () => {
    const r = await call("create_rule", { pattern: "ACME NOODLES", category: "Food", account: "SG Bank" });
    expect(r).toMatchObject({ category: "Food", account: "SG Bank", applied_to_existing: 1 });
    expect(txnRow(txn.lunch).matchedRuleId).toBe(r.rule_id);
  });

  it("writes a remark without marking the row reviewed", async () => {
    await call("set_remark", { transaction_id: txn.pay, remark: "January pay" });
    expect(txnRow(txn.pay).note).toBe("January pay");
    expect(txnRow(txn.pay).isReviewed).toBe(false);
    const found = await call("find_transactions", { query: "january pay" });
    expect(found.transactions.map((t: { id: number }) => t.id)).toEqual([txn.pay]);
  });

  it("summarises SGD accounts together and a ringgit account on its own", async () => {
    const sgd = await call("summarize", { from: "2000-01-01", to: "2000-01-31" });
    expect(sgd).toMatchObject({ currency: "SGD", money_in: 5000, expenses: 12 });
    const myr = await call("summarize", { from: "2000-01-01", to: "2000-01-31", account: "MY Bank" });
    expect(myr).toMatchObject({ currency: "MYR", expenses: 19 });
  });

  it("answers an unknown name with the names it knows, not a crash", async () => {
    await expect(call("categorize", { transaction_ids: [txn.cafe], category: "Groceries" }))
      .rejects.toThrow(/No category "Groceries". Known: .*Food/);
    const r = await call("create_category", { name: "food", bucket: "expense" });
    expect(r.created).toBe(false);
  });
});
