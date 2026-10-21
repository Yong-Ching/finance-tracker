import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, sql, like, or } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import type { Period } from "./period";
import { parseAmountQuery } from "./amount-query";
import {
  assess, detectCandidates, matches, merchantKey, monthlyCents, timeline, typicalCents,
  type Candidate, type ChargeRow, type SubscriptionState, type TimelineEntry,
} from "./subscriptions";

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

/**
 * Totals are in SGD. An account in another currency (Maybank, in ringgit) is
 * shown on its own in its own currency, and left out of every combined total:
 * adding RM 100 to S$100 would make S$200 out of money that is neither.
 */
export const BASE_CURRENCY = "SGD";
const inBaseCurrency = sql`${s.transactions.accountId} in
  (select id from accounts where currency = ${BASE_CURRENCY})`;

/** One account in its own currency, or every base-currency account together. */
const forAccount = (accountId?: number) =>
  accountId ? eq(s.transactions.accountId, accountId) : inBaseCurrency;

const inPeriod = (p: Period, accountId?: number) =>
  and(
    gte(s.transactions.txnDate, p.from),
    lte(s.transactions.txnDate, p.to),
    forAccount(accountId),
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
  // Net: repayments into expense categories reduce it.
  const expenseCents = -(get("expense") + get("debt_repayment"));
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
    .where(forAccount(accountId))
    .groupBy(sql`1`, s.transactions.txnType)
    .orderBy(sql`1`)
    .all();

  const map = new Map<string, MonthRow>();
  for (const r of rows) {
    const m = map.get(r.month) ?? {
      month: r.month, incomeCents: 0, expenseCents: 0, savingsCents: 0, transferCents: 0,
    };
    if (r.txnType === "income") m.incomeCents += r.total;
    else if (r.txnType === "expense" || r.txnType === "debt_repayment") m.expenseCents -= r.total;
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
      // Signed spend, not abs(): money back into an expense category (a friend
      // repaying) nets it down, and a category repaid more than was spent in
      // the period shows as negative rather than as spending.
      totalCents: sql<number>`-sum(${s.transactions.amountCents})`,
      count: sql<number>`count(*)`,
    })
    .from(s.transactions)
    .leftJoin(s.categories, eq(s.transactions.categoryId, s.categories.id))
    .where(and(inPeriod(p, accountId), inArray(s.transactions.txnType, ["expense", "debt_repayment"])))
    .groupBy(s.transactions.categoryId)
    .orderBy(desc(sql`-sum(${s.transactions.amountCents})`))
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
  currency: string;
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
      .where(inPeriod(p, a.id))
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
      currency: a.currency,
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
  /** Exactly the charges matched to one subscription (amount tolerance included). */
  subscriptionId?: number;
  /** An amount expression ("3.98", "10-50", ">100", "~30", "-3.98"); see amount-query.ts. */
  amount?: string;
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
  currency: string;
  statementStatus: string | null;
}

/** A sum of transactions in one currency; a list can hold several. */
export interface CurrencySum {
  currency: string;
  cents: number;
}

/** An id list as a condition; an empty list matches nothing rather than everything. */
const idsIn = (ids: number[]) => (ids.length ? inArray(s.transactions.id, ids) : sql`0`);

/**
 * Conditions for an amount expression. One that cannot be read matches
 * nothing, so a typo shows an empty list instead of silently showing all.
 */
function amountClauses(raw: string | undefined) {
  if (!raw?.trim()) return [];
  const q = parseAmountQuery(raw);
  if (!q) return [sql`0`];
  const abs = sql`abs(${s.transactions.amountCents})`;
  return [
    q.minCents !== undefined ? sql`${abs} >= ${q.minCents}` : undefined,
    q.maxCents !== undefined ? sql`${abs} <= ${q.maxCents}` : undefined,
    q.direction === "out" ? sql`${s.transactions.amountCents} < 0` : undefined,
    q.direction === "in" ? sql`${s.transactions.amountCents} > 0` : undefined,
  ];
}

function txnWhere(f: TxnFilters) {
  const clauses = [
    // Search covers remarks too: "dinner with a friend" finds what the statement calls "ACME RESTAURANT".
    f.q
      ? or(
          like(sql`upper(${s.transactions.descriptionRaw})`, `%${f.q.toUpperCase()}%`),
          like(sql`upper(${s.transactions.note})`, `%${f.q.toUpperCase()}%`),
        )
      : undefined,
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
    f.subscriptionId !== undefined ? idsIn(subscriptionChargeIds(f.subscriptionId)) : undefined,
    ...amountClauses(f.amount),
  ].filter(Boolean);
  return clauses.length ? and(...clauses) : undefined;
}

export function listTransactions(f: TxnFilters): { rows: TxnRow[]; total: number; sums: CurrencySum[] } {
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
      currency: s.accounts.currency,
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

  // Summed per currency: a list can span the SGD accounts and Maybank.
  const agg = db
    .select({
      currency: s.accounts.currency,
      n: sql<number>`count(*)`,
      cents: sql<number>`sum(${s.transactions.amountCents})`,
    })
    .from(s.transactions)
    .innerJoin(s.accounts, eq(s.transactions.accountId, s.accounts.id))
    .where(where)
    .groupBy(s.accounts.currency)
    .all()
    .sort((a, b) => Number(b.currency === BASE_CURRENCY) - Number(a.currency === BASE_CURRENCY));

  return {
    rows,
    total: agg.reduce((a, r) => a + r.n, 0),
    sums: agg.map(({ currency, cents }) => ({ currency, cents })),
  };
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
      currency: s.accounts.currency,
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

/**
 * Months an account has a statement for, so gaps in coverage are visible. A
 * statement covers every month from its start to its end: a bank's is one
 * month, but a wallet export (Touch 'n Go) can span many.
 */
export function statementCoverage(accountId: number): string[] {
  const months = new Set<string>();
  const rows = db
    .select({ from: s.statements.periodFrom, to: s.statements.periodTo })
    .from(s.statements)
    .where(and(eq(s.statements.accountId, accountId), eq(s.statements.status, "imported")))
    .all();
  for (const r of rows) {
    if (!r.to) continue;
    let m = (r.from ?? r.to).slice(0, 7);
    const end = r.to.slice(0, 7);
    while (m <= end) {
      months.add(m);
      const [y, mo] = m.split("-").map(Number);
      m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
    }
  }
  return [...months].sort();
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

/* ---------------------------------------------------------- subscriptions */


export interface SubscriptionRow extends s.Subscription, SubscriptionState {
  accountName: string | null;
  /** The charge expected each cycle: the amount on record, or a variable bill's recent median. */
  typicalCents: number;
  monthlyCents: number;
  /** End of the latest statement the charges are judged against. */
  asOf: string | null;
}

export interface SubscriptionOverview {
  active: SubscriptionRow[];
  cancelled: SubscriptionRow[];
  candidates: (Candidate & { accountName: string })[];
  monthlyTotalCents: number;
  needsAttention: number;
}

/** Outflows from imported statements - the only rows a subscription can match. */
function outflows(): ChargeRow[] {
  return db
    .select({
      id: s.transactions.id,
      accountId: s.transactions.accountId,
      txnDate: s.transactions.txnDate,
      amountCents: s.transactions.amountCents,
      descriptionRaw: s.transactions.descriptionRaw,
      categoryName: s.categories.name,
      statementId: s.transactions.statementId,
    })
    .from(s.transactions)
    .leftJoin(s.categories, eq(s.categories.id, s.transactions.categoryId))
    .where(
      and(
        sql`${s.transactions.amountCents} < 0`,
        // A transfer to a pocket is not a charge; what it bought is, on the pocket's statement.
        ne(s.transactions.txnType, "internal_transfer"),
        // Amounts and cadences are compared across charges, so one currency only.
        inBaseCurrency,
        sql`(${s.transactions.statementId} is null or ${s.transactions.statementId} in
             (select id from statements where status = 'imported'))`,
      ),
    )
    .all();
}

/** Each account's latest statement end: how far the data can see. */
function statementEnds(): Map<number, string> {
  const rows = db
    .select({ accountId: s.statements.accountId, end: sql<string>`max(${s.statements.periodTo})` })
    .from(s.statements)
    .where(eq(s.statements.status, "imported"))
    .groupBy(s.statements.accountId)
    .all();
  return new Map(rows.filter((r) => r.end).map((r) => [r.accountId, r.end]));
}

function toRow(
  x: s.Subscription,
  charges: ChargeRow[],
  ends: Map<number, string>,
  accountName: Map<number, string>,
): SubscriptionRow {
  // Judge against the account the charges actually come from.
  const first = assess(x, charges, null);
  const acct = x.accountId ?? first.lastCharge?.accountId ?? null;
  const asOf = acct !== null ? ends.get(acct) ?? null : null;
  const state = assess(x, charges, asOf);
  const typical = typicalCents(x, state.charges);
  return {
    ...x,
    ...state,
    asOf,
    accountName: x.accountId !== null ? accountName.get(x.accountId) ?? null : null,
    typicalCents: typical,
    monthlyCents: monthlyCents(typical, x.cadence),
  };
}

const accountNames = () => new Map(allAccounts().map((a) => [a.id, a.name]));

export interface StatementRef {
  id: number;
  filename: string;
  periodFrom: string | null;
  periodTo: string | null;
  accountName: string;
  hasFile: boolean;
}

/** The statements a set of charges came from, keyed by id. */
function statementRefs(charges: ChargeRow[]): Record<number, StatementRef> {
  const ids = [...new Set(charges.map((c) => c.statementId).filter((x): x is number => !!x))];
  if (!ids.length) return {};
  const rows = db
    .select({
      id: s.statements.id,
      filename: s.statements.filename,
      periodFrom: s.statements.periodFrom,
      periodTo: s.statements.periodTo,
      storedPath: s.statements.storedPath,
      accountName: s.accounts.name,
    })
    .from(s.statements)
    .innerJoin(s.accounts, eq(s.accounts.id, s.statements.accountId))
    .where(inArray(s.statements.id, ids))
    .all();
  return Object.fromEntries(
    rows.map(({ storedPath, ...r }) => [r.id, { ...r, hasFile: !!storedPath }]),
  );
}

export function subscriptionOverview(): SubscriptionOverview & { statements: Record<number, StatementRef> } {
  const charges = outflows();
  const ends = statementEnds();
  const names = accountNames();
  const subs = db.select().from(s.subscriptions).orderBy(asc(s.subscriptions.name)).all();

  const rows = subs.filter((x) => x.status !== "dismissed").map((x) => toRow(x, charges, ends, names));
  const active = rows.filter((r) => r.status === "active").sort((a, b) => b.monthlyCents - a.monthlyCents);
  const candidates = detectCandidates(charges, subs, ends).map((c) => ({
    ...c,
    accountName: names.get(c.accountId) ?? "",
  }));

  return {
    active,
    cancelled: rows.filter((r) => r.status === "cancelled"),
    candidates,
    monthlyTotalCents: active.reduce((a, r) => a + r.monthlyCents, 0),
    needsAttention: active.filter((r) => r.health.kind === "overdue" || r.health.kind === "no_charges").length,
    statements: statementRefs(candidates.flatMap((c) => c.charges)),
  };
}

export function getSubscription(subscriptionId: number) {
  return db.select().from(s.subscriptions).where(eq(s.subscriptions.id, subscriptionId)).get() ?? null;
}

/** Ids of the charges matched to a subscription; empty if it does not exist. */
export function subscriptionChargeIds(subscriptionId: number): number[] {
  const sub = db.select().from(s.subscriptions).where(eq(s.subscriptions.id, subscriptionId)).get();
  if (!sub) return [];
  return outflows().filter((c) => matches(c, sub)).map((c) => c.id);
}

export interface SubscriptionDetail {
  sub: SubscriptionRow;
  /** Newest first, missed cycles included. */
  history: TimelineEntry[];
  statements: Record<number, StatementRef>;
  paidCents: number;
  averageCents: number;
}

/** One subscription with every charge traced back to its statement. */
export function subscriptionDetail(subscriptionId: number): SubscriptionDetail | null {
  const x = db.select().from(s.subscriptions).where(eq(s.subscriptions.id, subscriptionId)).get();
  if (!x || x.status === "dismissed") return null;
  const sub = toRow(x, outflows(), statementEnds(), accountNames());
  const paidCents = sub.charges.reduce((a, c) => a + Math.abs(c.amountCents), 0);
  return {
    sub,
    // A cancelled subscription is expected to stop; its silence is not "missed".
    history: timeline(sub.charges, sub.cadence, sub.status === "active" ? sub.asOf : null).reverse(),
    statements: statementRefs(sub.charges),
    paidCents,
    averageCents: sub.charges.length ? Math.round(paidCents / sub.charges.length) : 0,
  };
}

/** The merchants paid most often in a period - real starting points for the dashboard search. */
export function topMerchants(p: Period, n = 3): string[] {
  const rows = db
    .select({ d: s.transactions.descriptionRaw })
    .from(s.transactions)
    .where(and(inPeriod(p), inArray(s.transactions.txnType, ["expense", "debt_repayment"])))
    .all();
  // Bank boilerplate in front of the merchant is not something anyone searches for.
  const prefix = /^(DEBIT CARD TRANSACTION|POINT OF SALE TRANSACTION|ADVICE POINT OF SALE|NETS QR)\s+/;
  const counts = new Map<string, number>();
  for (const r of rows) {
    // One clean word when it is distinctive enough ("STREAMCO", "BAKERY-TOWN" -> "BAKERY"), else two.
    const words = merchantKey(r.d).replace(prefix, "").split(" ").map((w) => w.split("-")[0].replace(/[^A-Z0-9/&.']+$/, ""));
    const k = (words[0]?.length >= 4 ? words.slice(0, 1) : words.slice(0, 2)).join(" ").replace(/[*.\s]+$/, "");
    if (k.length >= 3) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  // Keep only terms a plain description search actually finds.
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k)
    .filter((k) => listTransactions({ q: k, from: p.from, to: p.to, perPage: 1 }).total > 0)
    .slice(0, n);
}
