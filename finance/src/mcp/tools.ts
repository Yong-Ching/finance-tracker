import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sqlite } from "@/db/client";
import { BUCKETS, TXN_TYPES, type TxnType } from "@/db/schema";
import * as actions from "@/lib/actions";
import * as queries from "@/lib/queries";
import { merchantKey } from "@/lib/subscriptions";

/**
 * The finance data as MCP tools, so any MCP-capable assistant (Claude, Cursor,
 * Gemini CLI, LM Studio...) can read transactions and file them in bulk
 * instead of one row at a time.
 *
 * Every write goes through the same actions the app's own pages use, so an edit
 * made here is recorded exactly like one made by hand: as an override that
 * survives a statement re-import. The database is backed up once, before the
 * first write a session makes.
 */

const INSTRUCTIONS = `Personal finance data from bank statements, read and updated locally.

- Amounts are signed: negative is money out. Each account has a currency (SGD, MYR...); totals never mix currencies, and combined totals are SGD accounts only.
- A transaction's type decides how it counts: expense, income, savings, debt_repayment, or internal_transfer (between the user's own accounts; counted in neither).
- Choosing a category sets the type it implies, so money back into an expense category (a friend repaying, a refund) reduces that spending rather than counting as income. "Paid for friends" works this way.
- To sort many transactions: group_transactions finds the uncategorised ones by merchant; categorize files a whole group in one call; create_rule makes future statements file themselves.
- Ask the user before filing anything you are unsure of. Never guess a category from an amount alone.`;

/* ------------------------------------------------------------------ helpers --- */

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });
const money = (cents: number) => cents / 100;

/** An account or category given by id or by name, case-insensitively. */
function resolve<T extends { id: number; name: string }>(rows: T[], ref: string | number, what: string): T {
  const hit = typeof ref === "number"
    ? rows.find((r) => r.id === ref)
    : rows.find((r) => r.name.toLowerCase() === ref.trim().toLowerCase()) ??
      (/^\d+$/.test(ref.trim()) ? rows.find((r) => r.id === Number(ref)) : undefined);
  if (!hit) throw new Error(`No ${what} "${ref}". Known: ${rows.map((r) => r.name).join(", ")}`);
  return hit;
}
const account = (ref: string | number) => resolve(queries.allAccounts(), ref, "account");
const category = (ref: string | number) => resolve(queries.allCategories(), ref, "category");

/** The type a category implies when none is given: what the app does when one is picked by hand. */
function impliedType(bucket: string): TxnType {
  return bucket === "income" || bucket === "savings" ? bucket : bucket === "transfer" ? "internal_transfer" : "expense";
}

let backedUp = false;
/** One backup per session, beside the database, before the first write. */
async function backupOnce() {
  if (backedUp) return;
  const dir = path.join(path.dirname(sqlite.name), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await sqlite.backup(path.join(dir, `sqlite-${stamp}-before-mcp.db`));
  backedUp = true;
}

/** Wraps a tool so a bad name or id comes back as a readable error, not a crash. */
const guarded = <A,>(fn: (args: A) => Promise<ReturnType<typeof json>> | ReturnType<typeof json>) =>
  async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };

/* ------------------------------------------------------------------ filters --- */

const filterShape = {
  query: z.string().max(100).optional().describe("Text in the description or the remark"),
  amount: z.string().max(40).optional().describe('Amount expression: "12.50", "-12.50" (money out), "10-50", ">100", "~30"'),
  account: z.union([z.string(), z.number()]).optional().describe("Account name or id"),
  category: z.union([z.string(), z.number()]).optional().describe('Category name or id, or "none" for uncategorised'),
  type: z.enum(TXN_TYPES).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("First date, YYYY-MM-DD"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Last date, YYYY-MM-DD"),
  needs_review: z.boolean().optional().describe("Only rows still waiting for a category"),
};
type Filters = { [K in keyof typeof filterShape]?: z.infer<(typeof filterShape)[K]> };

function toTxnFilters(f: Filters): queries.TxnFilters {
  return {
    q: f.query,
    amount: f.amount,
    accountId: f.account !== undefined ? account(f.account).id : undefined,
    categoryId: f.category === undefined ? undefined
      : String(f.category).toLowerCase() === "none" ? "none" : category(f.category).id,
    txnType: f.type,
    from: f.from,
    to: f.to,
    reviewOnly: f.needs_review,
  };
}

const row = (r: queries.TxnRow) => ({
  id: r.id,
  date: r.txnDate,
  account: r.accountName,
  currency: r.currency,
  amount: money(r.amountCents),
  description: r.descriptionRaw,
  category: r.categoryName,
  type: r.txnType,
  remark: r.note,
  needs_review: !r.isReviewed,
});

/* -------------------------------------------------------------------- tools --- */

export function createFinanceServer(): McpServer {
  const server = new McpServer({ name: "finance-tracker", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  const read = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  server.registerTool("list_accounts", {
    title: "List accounts",
    description: "Every account, with its currency and whether it is a pocket (a wallet or card funded from another account).",
    annotations: read,
  }, guarded(() => json(queries.allAccounts().map((a) => ({
    id: a.id, name: a.name, institution: a.institution, kind: a.kind, currency: a.currency, pocket: a.isPocket,
  })))));

  server.registerTool("list_categories", {
    title: "List categories",
    description: "Every category and its bucket: expense, income, savings or transfer.",
    annotations: read,
  }, guarded(() => json(queries.allCategories().map((c) => ({ id: c.id, name: c.name, bucket: c.bucket })))));

  server.registerTool("list_rules", {
    title: "List rules",
    description: "The rules that file new transactions automatically, in the order they are tried.",
    annotations: read,
  }, guarded(() => json(queries.listRules())));

  server.registerTool("find_transactions", {
    title: "Find transactions",
    description: "Transactions matching the filters, newest first, with per-currency sums of everything matched.",
    inputSchema: {
      ...filterShape,
      page: z.number().int().min(1).default(1),
      page_size: z.number().int().min(1).max(500).default(50),
    },
    annotations: read,
  }, guarded((a: Filters & { page: number; page_size: number }) => {
    const { rows, total, sums } = queries.listTransactions({ ...toTxnFilters(a), page: a.page, perPage: a.page_size });
    return json({
      total,
      page: a.page,
      sums: sums.map((s) => ({ currency: s.currency, amount: money(s.cents) })),
      transactions: rows.map(row),
    });
  }));

  server.registerTool("group_transactions", {
    title: "Group transactions by merchant",
    description:
      "Matching transactions grouped by merchant within each account, largest groups first, with every id in each group - " +
      'the way to sort many at once. Use category "none" to see what is uncategorised.',
    inputSchema: { ...filterShape, max_groups: z.number().int().min(1).max(300).default(100) },
    annotations: read,
  }, guarded((a: Filters & { max_groups: number }) => {
    const { rows } = queries.listTransactions({ ...toTxnFilters(a), perPage: 10_000 });
    const groups = new Map<string, { merchant: string; account: string; currency: string; ids: number[]; cents: number; example: string }>();
    for (const r of rows) {
      const merchant = merchantKey(r.descriptionRaw) || r.descriptionRaw.slice(0, 40);
      const key = `${r.accountId}|${merchant}`;
      const g = groups.get(key) ?? { merchant, account: r.accountName, currency: r.currency, ids: [], cents: 0, example: r.descriptionRaw };
      g.ids.push(r.id);
      g.cents += r.amountCents;
      groups.set(key, g);
    }
    const sorted = [...groups.values()].sort((x, y) => y.ids.length - x.ids.length || Math.abs(y.cents) - Math.abs(x.cents));
    return json({
      transactions: rows.length,
      groups: sorted.slice(0, a.max_groups).map((g) => ({
        merchant: g.merchant, account: g.account, currency: g.currency, count: g.ids.length,
        total: money(g.cents), example: g.example, transaction_ids: g.ids,
      })),
      more_groups: Math.max(0, sorted.length - a.max_groups),
    });
  }));

  server.registerTool("summarize", {
    title: "Summarize a period",
    description:
      "Money in, expenses, savings and spending by category for a date range. Without an account it covers the SGD " +
      "accounts together; with one, that account alone in its own currency.",
    inputSchema: {
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      account: z.union([z.string(), z.number()]).optional(),
    },
    annotations: read,
  }, guarded((a: { from: string; to: string; account?: string | number }) => {
    const acc = a.account !== undefined ? account(a.account) : undefined;
    const p = { from: a.from, to: a.to, label: `${a.from} to ${a.to}`, key: "mcp" };
    const t = queries.totals(p, acc?.id);
    return json({
      currency: acc?.currency ?? queries.BASE_CURRENCY,
      scope: acc ? acc.name : `all ${queries.BASE_CURRENCY} accounts`,
      money_in: money(t.incomeCents),
      expenses: money(t.expenseCents),
      savings: money(t.savingsCents),
      net: money(t.netCents),
      unaccounted_in_pockets: money(t.unaccountedCents),
      transactions: t.count,
      spending_by_category: queries.expenseByCategory(p, acc?.id, 50).map((c) => ({
        category: c.name, amount: money(c.totalCents), count: c.count,
      })),
    });
  }));

  server.registerTool("categorize", {
    title: "Categorize transactions",
    description:
      "Files transactions under one category, recorded like a manual edit so it survives re-importing a statement. " +
      'The type follows the category unless one is given. Category "none" clears it.',
    inputSchema: {
      transaction_ids: z.array(z.number().int().positive()).min(1).max(5000),
      category: z.union([z.string(), z.number()]),
      type: z.enum(TXN_TYPES).optional().describe("Only to override the type the category implies, e.g. debt_repayment"),
    },
    annotations: { ...write, idempotentHint: true },
  }, guarded(async (a: { transaction_ids: number[]; category: string | number; type?: TxnType }) => {
    const target = String(a.category).toLowerCase() === "none" ? null : category(a.category);
    await backupOnce();
    const n = await actions.bulkSetCategory(a.transaction_ids, target?.id ?? null, a.type);
    return json({ updated: n, not_found: a.transaction_ids.length - n, category: target?.name ?? null });
  }));

  server.registerTool("set_remark", {
    title: "Set a remark",
    description: "Writes a remark on one transaction (who it was for, what it bought). An empty remark removes it. A remark does not mark the transaction reviewed.",
    inputSchema: {
      transaction_id: z.number().int().positive(),
      remark: z.string().max(500),
    },
    annotations: { ...write, idempotentHint: true },
  }, guarded(async (a: { transaction_id: number; remark: string }) => {
    await backupOnce();
    await actions.updateTransaction(a.transaction_id, { note: a.remark.trim() || null });
    return json({ transaction_id: a.transaction_id, remark: a.remark.trim() || null });
  }));

  server.registerTool("create_category", {
    title: "Create a category",
    description: "Adds a category. Bucket decides how it counts: expense, income, savings, or transfer (between the user's own accounts).",
    inputSchema: { name: z.string().trim().min(1).max(80), bucket: z.enum(BUCKETS) },
    annotations: write,
  }, guarded(async (a: { name: string; bucket: (typeof BUCKETS)[number] }) => {
    const existing = queries.allCategories().find((c) => c.name.toLowerCase() === a.name.toLowerCase());
    if (existing) return json({ id: existing.id, name: existing.name, bucket: existing.bucket, created: false });
    await backupOnce();
    const id = await actions.createCategory(a.name, a.bucket);
    return json({ id, name: a.name, bucket: a.bucket, created: true });
  }));

  server.registerTool("create_rule", {
    title: "Create a rule",
    description:
      "Files every transaction whose description contains the pattern (case-insensitive), now and in future statements. " +
      "Rows already edited by hand keep their edit. Scope it to an account when the text is common.",
    inputSchema: {
      pattern: z.string().trim().min(3).max(200),
      category: z.union([z.string(), z.number()]),
      account: z.union([z.string(), z.number()]).optional(),
      type: z.enum(TXN_TYPES).optional(),
      apply_to_existing: z.boolean().default(true),
    },
    annotations: write,
  }, guarded(async (a: { pattern: string; category: string | number; account?: string | number; type?: TxnType; apply_to_existing: boolean }) => {
    const cat = category(a.category);
    const acc = a.account !== undefined ? account(a.account) : null;
    await backupOnce();
    const id = await actions.createRule({
      pattern: a.pattern,
      matchType: "substring",
      categoryId: cat.id,
      txnType: a.type ?? impliedType(cat.bucket),
      seen: true,
      accountId: acc?.id ?? null,
      priority: 60,
      note: "Added through MCP",
    }, false);
    const applied = a.apply_to_existing ? await actions.applyRule(id) : 0;
    return json({ rule_id: id, pattern: a.pattern, category: cat.name, account: acc?.name ?? "all accounts", applied_to_existing: applied });
  }));

  return server;
}
