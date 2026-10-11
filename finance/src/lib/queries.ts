import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, sql, like, or } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import type { Period } from "./period";

/** txnTypes that count toward the dashboard's three buckets. */
const REPORTING = ["income", "expense", "savings", "debt_repayment"] as const;

export function availableMonths(): string[] {
  return db
    .select({ m: sql<string>`substr(${s.transactions.txnDate}, 1, 7)` })
    .from(s.transactions)
    .groupBy(sql`1`)
    .orderBy(sql`1`)
    .all()
    .map((r) => r.m);
}

const inPeriod = (p: Period, accountId?: number) =>
  and(
    gte(s.transactions.txnDate, p.from),
    lte(s.transactions.txnDate, p.to),
    accountId ? eq(s.transactions.accountId, accountId) : undefined,
    // A quarantined statement's rows never enter a total.
    sql`(${s.transactions.statementId} is null or ${s.transactions.statementId} in
         (select id from statements where status = 'imported'))`,
  );

export interface Totals {
  incomeCents: number;
  expenseCents: number;
  savingsCents: number;
  /** Money moved to a pocket with no confirmed itemised statement behind it. */
  unaccountedCents: number;
  netCents: number;
  savingsRate: number | null;
  count: number;
}

export function totals(p: Period, accountId?: number): Totals {
  const rows = db
    .select({
      txnType: s.transactions.txnType,
      total: sql<number>`sum(${s.transactions.amountCents})`,
      n: sql<number>`count(*)`,
    })
    .from(s.transactions)
    .where(inPeriod(p, accountId))
    .groupBy(s.transactions.txnType)
    .all();

  const get = (t: string) => rows.find((r) => r.txnType === t)?.total ?? 0;
  const incomeCents = get("income");
  const expenseCents = Math.abs(get("expense") + get("debt_repayment"));
  const savingsCents = Math.abs(get("savings"));

  // A transfer is unaccounted until a confirmed link ties it to real spending.
  const unaccountedCents = Math.abs(
    db
      .select({ total: sql<number>`coalesce(sum(${s.transactions.amountCents}), 0)` })
      .from(s.transactions)
      .where(
        and(
          inPeriod(p, accountId),
          eq(s.transactions.txnType, "internal_transfer"),
          sql`${s.transactions.id} not in (
                select source_txn_id from transfer_links where status = 'confirmed')`,
        ),
      )
      .get()!.total,
  );

  return {
    incomeCents,
    expenseCents,
    savingsCents,
    unaccountedCents,
    netCents: incomeCents - expenseCents,
    savingsRate: incomeCents > 0 ? savingsCents / incomeCents : null,
    count: rows.reduce((a, r) => a + r.n, 0),
  };
}

export interface MonthRow {
  month: string;
  incomeCents: number;
  expenseCents: number;
  savingsCents: number;
  transferCents: number;
}

export function byMonth(accountId?: number): MonthRow[] {
  const rows = db
    .select({
      month: sql<string>`substr(${s.transactions.txnDate}, 1, 7)`,
      txnType: s.transactions.txnType,
      total: sql<number>`sum(${s.transactions.amountCents})`,
    })
    .from(s.transactions)
    .where(accountId ? eq(s.transactions.accountId, accountId) : undefined)
    .groupBy(sql`1`, s.transactions.txnType)
    .orderBy(sql`1`)
    .all();

  const map = new Map<string, MonthRow>();
  for (const r of rows) {
    const m = map.get(r.month) ?? {
      month: r.month, incomeCents: 0, expenseCents: 0, savingsCents: 0, transferCents: 0,
    };
    if (r.txnType === "income") m.incomeCents += r.total;
    else if (r.txnType === "expense" || r.txnType === "debt_repayment") m.expenseCents += Math.abs(r.total);
    else if (r.txnType === "savings") m.savingsCents += Math.abs(r.total);
    else m.transferCents += Math.abs(r.total);
    map.set(r.month, m);
  }
  return [...map.values()];
}

export interface CategorySlice {
  categoryId: number | null;
  name: string;
  totalCents: number;
  count: number;
  share: number;
  /** For the folded "Other" slice: every category it stands for. */
  memberIds?: number[];
}

/** Expense breakdown, capped at the top 5 plus "Other". */
export function expenseByCategory(p: Period, accountId?: number, cap = 5): CategorySlice[] {
  const rows = db
    .select({
      categoryId: s.transactions.categoryId,
      name: sql<string>`coalesce(${s.categories.name}, 'Uncategorized')`,
      totalCents: sql<number>`abs(sum(${s.transactions.amountCents}))`,
      count: sql<number>`count(*)`,
    })
    .from(s.transactions)
    .leftJoin(s.categories, eq(s.transactions.categoryId, s.categories.id))
    .where(and(inPeriod(p, accountId), inArray(s.transactions.txnType, ["expense", "debt_repayment"])))
    .groupBy(s.transactions.categoryId)
    .orderBy(desc(sql`abs(sum(${s.transactions.amountCents}))`))
    .all();

  const grand = rows.reduce((a, r) => a + r.totalCents, 0) || 1;
  const head = rows.slice(0, cap);
  const tail = rows.slice(cap);
  const out: CategorySlice[] = head.map((r) => ({ ...r, share: r.totalCents / grand }));
  if (tail.length) {
    const totalCents = tail.reduce((a, r) => a + r.totalCents, 0);
    out.push({
      categoryId: null,
      name: `Other (${tail.length} categories)`,
      totalCents,
      count: tail.reduce((a, r) => a + r.count, 0),
      share: totalCents / grand,
      memberIds: tail.map((r) => r.categoryId).filter((id): id is number => id !== null),
    });
  }
  return out;
}

/**
 * A running-balance line for ONE account.
 *
 * Never leave this unfiltered: pooling DBS (tens of thousands) with a prepaid
 * wallet (tens) into a single series draws cliffs that are not real movements,
 * just a switch between accounts. Defaults to the main bank account.
 */
export function balanceSeries(p: Period, accountId?: number) {
  const target =
    accountId ??
    db.select().from(s.accounts).where(eq(s.accounts.kind, "bank"))
      .orderBy(asc(s.accounts.sortOrder)).limit(1).get()?.id;
  if (!target) return [];
  return db
    .select({
      date: s.transactions.txnDate,
      balanceCents: sql<number>`max(${s.transactions.balanceAfterCents})`,
    })
    .from(s.transactions)
    .where(and(inPeriod(p, target), sql`${s.transactions.balanceAfterCents} is not null`))
    .groupBy(s.transactions.txnDate)
    .orderBy(asc(s.transactions.txnDate))
    .all();
}

export interface AccountCard {
  id: number;
  name: string;
  institution: string;
  kind: string;
  isPocket: boolean;
  balanceCents: number | null;
  flowCents: number;
  lastStatement: string | null;
  txnCount: number;
}

export function accountCards(p: Period): AccountCard[] {
  const accounts = db.select().from(s.accounts).orderBy(asc(s.accounts.sortOrder)).all();
  return accounts.map((a) => {
    const flow = db
      .select({
        total: sql<number>`coalesce(sum(${s.transactions.amountCents}), 0)`,
        n: sql<number>`count(*)`,
      })
      .from(s.transactions)
      .where(and(inPeriod(p), eq(s.transactions.accountId, a.id)))
      .get()!;
    const last = db
      .select({ d: s.transactions.txnDate, b: s.transactions.balanceAfterCents })
      .from(s.transactions)
      .where(and(eq(s.transactions.accountId, a.id), sql`${s.transactions.balanceAfterCents} is not null`))
      .orderBy(desc(s.transactions.txnDate), desc(s.transactions.id))
      .limit(1)
      .get();
    const stmt = db
      .select({ to: s.statements.periodTo })
      .from(s.statements)
      .where(eq(s.statements.accountId, a.id))
      .orderBy(desc(s.statements.periodTo))
      .limit(1)
      .get();
    // A credit-card statement prints no per-line running balance, so fall back
    // to the closing balance the newest statement states.
    const stmtBalance = db
      .select({ b: s.statements.closingBalanceCents })
      .from(s.statements)
      .where(and(eq(s.statements.accountId, a.id), eq(s.statements.status, "imported")))
      .orderBy(desc(s.statements.periodTo))
      .limit(1)
      .get();

    return {
      id: a.id,
      name: a.name,
      institution: a.institution,
      kind: a.kind,
      isPocket: a.isPocket,
      balanceCents: last?.b ?? stmtBalance?.b ?? null,
      flowCents: flow.total,
      lastStatement: stmt?.to ?? null,
      txnCount: flow.n,
    };
  });
}

export interface Attention {
  needsReview: number;
  quarantined: number;
  proposedLinks: number;
  unmatchedTransfers: number;
}

export function attention(): Attention {
  const one = (q: { n: number } | undefined) => q?.n ?? 0;
  return {
    needsReview: one(
      db.select({ n: sql<number>`count(*)` }).from(s.transactions)
        .where(eq(s.transactions.isReviewed, false)).get(),
    ),
    quarantined: one(
      db.select({ n: sql<number>`count(*)` }).from(s.statements)
        .where(eq(s.statements.status, "quarantined")).get(),
    ),
    proposedLinks: one(
      db.select({ n: sql<number>`count(*)` }).from(s.transferLinks)
        .where(eq(s.transferLinks.status, "proposed")).get(),
    ),
    unmatchedTransfers: one(
      db.select({ n: sql<number>`count(*)` }).from(s.transactions)
        .where(and(
          eq(s.transactions.txnType, "internal_transfer"),
          sql`${s.transactions.id} not in (select source_txn_id from transfer_links where status = 'confirmed')`,
        )).get(),
    ),
  };
}

/* ------------------------------------------------------ transactions list --- */

export interface TxnFilters {
  q?: string;
  accountId?: number;
  /**
   * A single category, several (so the dashboard's "Other" slice can drill in
   * exactly rather than to a superset), or "none" for uncategorized.
   */
  categoryId?: number | "none" | number[];
  txnType?: string;
  from?: string;
  to?: string;
  reviewOnly?: boolean;
  page?: number;
  perPage?: number;
}

export interface TxnRow {
  id: number;
  txnDate: string;
  descriptionRaw: string;
  amountCents: number;
  balanceAfterCents: number | null;
  categoryId: number | null;
  categoryName: string | null;
  txnType: string;
  seen: boolean;
  note: string | null;
  isReviewed: boolean;
  accountId: number;
  accountName: string;
  statementStatus: string | null;
}

function txnWhere(f: TxnFilters) {
  const clauses = [
    f.q ? like(sql`upper(${s.transactions.descriptionRaw})`, `%${f.q.toUpperCase()}%`) : undefined,
    f.accountId ? eq(s.transactions.accountId, f.accountId) : undefined,
    f.categoryId === "none"
      ? isNull(s.transactions.categoryId)
      : Array.isArray(f.categoryId)
        ? f.categoryId.length
          ? inArray(s.transactions.categoryId, f.categoryId)
          : undefined
        : typeof f.categoryId === "number"
          ? eq(s.transactions.categoryId, f.categoryId)
          : undefined,
    f.txnType ? eq(s.transactions.txnType, f.txnType as never) : undefined,
    f.from ? gte(s.transactions.txnDate, f.from) : undefined,
    f.to ? lte(s.transactions.txnDate, f.to) : undefined,
    f.reviewOnly ? eq(s.transactions.isReviewed, false) : undefined,
  ].filter(Boolean);
  return clauses.length ? and(...clauses) : undefined;
}

export function listTransactions(f: TxnFilters): { rows: TxnRow[]; total: number; sumCents: number } {
  const where = txnWhere(f);
  const perPage = f.perPage ?? 100;
  const page = Math.max(1, f.page ?? 1);

  const rows = db
    .select({
      id: s.transactions.id,
      txnDate: s.transactions.txnDate,
      descriptionRaw: s.transactions.descriptionRaw,
      amountCents: s.transactions.amountCents,
      balanceAfterCents: s.transactions.balanceAfterCents,
      categoryId: s.transactions.categoryId,
      categoryName: s.categories.name,
      txnType: s.transactions.txnType,
      seen: s.transactions.seen,
      note: s.transactions.note,
      isReviewed: s.transactions.isReviewed,
      accountId: s.transactions.accountId,
      accountName: s.accounts.name,
      statementStatus: s.statements.status,
    })
    .from(s.transactions)
    .leftJoin(s.categories, eq(s.transactions.categoryId, s.categories.id))
    .innerJoin(s.accounts, eq(s.transactions.accountId, s.accounts.id))
    .leftJoin(s.statements, eq(s.transactions.statementId, s.statements.id))
    .where(where)
    .orderBy(desc(s.transactions.txnDate), desc(s.transactions.id))
    .limit(perPage)
    .offset((page - 1) * perPage)
    .all() as TxnRow[];

  const agg = db
    .select({
      n: sql<number>`count(*)`,
      total: sql<number>`coalesce(sum(${s.transactions.amountCents}), 0)`,
    })
    .from(s.transactions)
    .where(where)
    .get()!;

  return { rows, total: agg.n, sumCents: agg.total };
}

export function allCategories() {
  return db.select().from(s.categories).orderBy(asc(s.categories.name)).all();
}

export function allAccounts() {
  return db.select().from(s.accounts).orderBy(asc(s.accounts.sortOrder)).all();
}

/** How many existing transactions a pattern would match - the rule preview. */
export function countMatching(pattern: string, accountId?: number | null): number {
  if (!pattern.trim()) return 0;
  return db
    .select({ n: sql<number>`count(*)` })
    .from(s.transactions)
    .where(
      and(
        like(sql`upper(${s.transactions.descriptionRaw})`, `%${pattern.toUpperCase()}%`),
        accountId ? eq(s.transactions.accountId, accountId) : undefined,
      ),
    )
    .get()!.n;
}

export function listRules() {
  return db
    .select({
      id: s.rules.id,
      pattern: s.rules.pattern,
      matchType: s.rules.matchType,
      categoryId: s.rules.categoryId,
      categoryName: s.categories.name,
      txnType: s.rules.txnType,
      seen: s.rules.seen,
      priority: s.rules.priority,
      active: s.rules.active,
      accountId: s.rules.accountId,
      note: s.rules.note,
      hitCount: sql<number>`(select count(*) from transactions t where t.matched_rule_id = ${s.rules.id})`,
      lastMatchedAt: sql<string | null>`(select max(t.txn_date) from transactions t where t.matched_rule_id = ${s.rules.id})`,
    })
    .from(s.rules)
    .innerJoin(s.categories, eq(s.rules.categoryId, s.categories.id))
    .orderBy(asc(s.rules.priority))
    .all();
}

/* ----------------------------------------------------------- statements --- */

export function listStatements() {
  return db
    .select({
      id: s.statements.id,
      accountName: s.accounts.name,
      filename: s.statements.filename,
      periodFrom: s.statements.periodFrom,
      periodTo: s.statements.periodTo,
      openingBalanceCents: s.statements.openingBalanceCents,
      closingBalanceCents: s.statements.closingBalanceCents,
      continuityDelta: s.statements.continuityDelta,
      status: s.statements.status,
      parserName: s.statements.parserName,
      parserVersion: s.statements.parserVersion,
      importedAt: s.statements.importedAt,
      txnCount: sql<number>`(select count(*) from transactions t where t.statement_id = ${s.statements.id})`,
    })
    .from(s.statements)
    .innerJoin(s.accounts, eq(s.statements.accountId, s.accounts.id))
    .orderBy(desc(s.statements.periodTo))
    .all();
}

/** Months an account has a statement for, so gaps in coverage are visible. */
export function statementCoverage(accountId: number): string[] {
  return db
    .select({ m: sql<string>`substr(${s.statements.periodTo}, 1, 7)` })
    .from(s.statements)
    .where(and(eq(s.statements.accountId, accountId), eq(s.statements.status, "imported")))
    .groupBy(sql`1`)
    .orderBy(sql`1`)
    .all()
    .map((r) => r.m);
}

/* --------------------------------------------------------- AI suggestions --- */

export interface SuggestionRow {
  id: number;
  kind: string;
  dedupeHash: string | null;
  categoryId: number | null;
  categoryName: string | null;
  newCategoryName: string | null;
  txnType: string | null;
  pattern: string | null;
  flagType: string | null;
  confidence: number;
  reasoning: string | null;
  status: string;
  txnId: number | null;
  txnDate: string | null;
  txnDesc: string | null;
  txnAmountCents: number | null;
}

export function listSuggestions(
  kind?: string,
  status: "pending" | "accepted" | "rejected" = "pending",
): SuggestionRow[] {
  return db
    .select({
      id: s.aiSuggestions.id,
      kind: s.aiSuggestions.kind,
      dedupeHash: s.aiSuggestions.dedupeHash,
      categoryId: s.aiSuggestions.categoryId,
      categoryName: s.categories.name,
      newCategoryName: s.aiSuggestions.newCategoryName,
      txnType: s.aiSuggestions.txnType,
      pattern: s.aiSuggestions.pattern,
      flagType: s.aiSuggestions.flagType,
      confidence: s.aiSuggestions.confidence,
      reasoning: s.aiSuggestions.reasoning,
      status: s.aiSuggestions.status,
      txnId: sql<number | null>`(select id from transactions t where t.dedupe_hash = ${s.aiSuggestions.dedupeHash})`,
      txnDate: sql<string | null>`(select txn_date from transactions t where t.dedupe_hash = ${s.aiSuggestions.dedupeHash})`,
      txnDesc: sql<string | null>`(select description_raw from transactions t where t.dedupe_hash = ${s.aiSuggestions.dedupeHash})`,
      txnAmountCents: sql<number | null>`(select amount_cents from transactions t where t.dedupe_hash = ${s.aiSuggestions.dedupeHash})`,
    })
    .from(s.aiSuggestions)
    .leftJoin(s.categories, eq(s.aiSuggestions.categoryId, s.categories.id))
    .where(
      and(
        eq(s.aiSuggestions.status, status),
        kind ? eq(s.aiSuggestions.kind, kind as never) : undefined,
      ),
    )
    .orderBy(desc(s.aiSuggestions.confidence))
    .all() as SuggestionRow[];
}

/** Pending category suggestions keyed by transaction id, for the table. */
export function suggestionsByTxnId(): Map<number, SuggestionRow> {
  const m = new Map<number, SuggestionRow>();
  for (const row of listSuggestions("category")) {
    if (row.txnId !== null) m.set(row.txnId, row);
  }
  return m;
}

export function flagsByTxnId(): Map<number, SuggestionRow[]> {
  const m = new Map<number, SuggestionRow[]>();
  for (const row of listSuggestions("flag")) {
    if (row.txnId === null) continue;
    m.set(row.txnId, [...(m.get(row.txnId) ?? []), row]);
  }
  return m;
}

export function reviewSummary() {
  const runs = db
    .select({
      id: s.aiReviews.id,
      model: s.aiReviews.model,
      sentCount: s.aiReviews.sentCount,
      skippedExistingCount: s.aiReviews.skippedExistingCount,
      inputTokens: s.aiReviews.inputTokens,
      outputTokens: s.aiReviews.outputTokens,
      error: s.aiReviews.error,
      createdAt: s.aiReviews.createdAt,
      statementId: s.aiReviews.statementId,
    })
    .from(s.aiReviews)
    .orderBy(desc(s.aiReviews.createdAt))
    .all();
  const pending = db
    .select({ kind: s.aiSuggestions.kind, n: sql<number>`count(*)` })
    .from(s.aiSuggestions)
    .where(eq(s.aiSuggestions.status, "pending"))
    .groupBy(s.aiSuggestions.kind)
    .all();
  return { runs, pending };
}

/** Every transaction id matching a filter, for "select all matching". */
export function matchingTransactionIds(f: TxnFilters): number[] {
  return db
    .select({ id: s.transactions.id })
    .from(s.transactions)
    .where(txnWhere(f))
    .all()
    .map((r) => r.id);
}
