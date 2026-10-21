import "server-only";
import { and, asc, desc, eq, gte, isNotNull, lte, ne, sql } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";

/**
 * Ties a transfer out of DBS to the pocket credit it became.
 *
 * Without this, the same money is either counted twice - once leaving DBS and
 * again as itemised spend on the pocket statement - or lost entirely. Matches
 * are written as `proposed`; nothing is linked silently.
 */

/** Days either side of the transfer to look for its counterpart. */
const WINDOW: Record<string, number> = { topup: 3, bill_payment: 5 };

export interface Proposal {
  sourceTxnId: number;
  targetTxnId: number;
  kind: "topup" | "bill_payment";
  amountCents: number;
  dateGapDays: number;
  confidence: number;
}

const addDays = (iso: string, n: number) =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

const gapDays = (a: string, b: string) =>
  Math.abs(Math.round(
    (new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86_400_000,
  ));

/**
 * A Citibank payment settles a prior billing period, so it is matched to the
 * statement's own "payment received" line - never to individual purchases.
 */
const isBillPayment = (accountKind: string) => accountKind === "credit_card";

export function proposeLinks(): Proposal[] {
  // Unlinked transfers out, and the pocket each one funds.
  const transfers = db
    .select({
      id: s.transactions.id,
      txnDate: s.transactions.txnDate,
      amountCents: s.transactions.amountCents,
      pocketAccountId: s.categories.pocketAccountId,
      pocketKind: s.accounts.kind,
    })
    .from(s.transactions)
    .innerJoin(s.categories, eq(s.transactions.categoryId, s.categories.id))
    .innerJoin(s.accounts, eq(s.categories.pocketAccountId, s.accounts.id))
    .where(
      and(
        eq(s.transactions.txnType, "internal_transfer"),
        isNotNull(s.categories.pocketAccountId),
        // A transfer leaves an account, so the source is always an outflow.
        // Without this a credit arriving on the pocket qualifies as its own
        // source and matches itself.
        sql`${s.transactions.amountCents} < 0`,
        // And it must leave a different account than the pocket it funds.
        sql`${s.transactions.accountId} != ${s.categories.pocketAccountId}`,
        sql`${s.transactions.id} not in (select source_txn_id from transfer_links where status in ('confirmed','proposed'))`,
      ),
    )
    .all();

  const proposals: Proposal[] = [];
  const claimed = new Set<number>(
    db.select({ id: s.transferLinks.targetTxnId }).from(s.transferLinks).all().map((r) => r.id),
  );

  for (const t of transfers) {
    const kind = isBillPayment(t.pocketKind) ? "bill_payment" : "topup";
    const window = WINDOW[kind];
    const magnitude = Math.abs(t.amountCents);

    // The other side is a credit on the pocket account of the same magnitude.
    const candidates = db
      .select({ id: s.transactions.id, txnDate: s.transactions.txnDate, amountCents: s.transactions.amountCents })
      .from(s.transactions)
      .where(
        and(
          eq(s.transactions.accountId, t.pocketAccountId!),
          eq(s.transactions.amountCents, magnitude),
          ne(s.transactions.id, t.id),
          gte(s.transactions.txnDate, addDays(t.txnDate, -window)),
          lte(s.transactions.txnDate, addDays(t.txnDate, window)),
        ),
      )
      .all()
      .filter((c) => !claimed.has(c.id));

    if (!candidates.length) continue;

    // Exact amount is required; nearest date breaks the tie.
    candidates.sort((a, b) => gapDays(a.txnDate, t.txnDate) - gapDays(b.txnDate, t.txnDate));
    const best = candidates[0];
    const gap = gapDays(best.txnDate, t.txnDate);
    claimed.add(best.id);

    proposals.push({
      sourceTxnId: t.id,
      targetTxnId: best.id,
      kind,
      amountCents: magnitude,
      dateGapDays: gap,
      // Exact amount plus same-day is as good as it gets; confidence decays
      // with the date gap, and an ambiguous field of candidates costs a little.
      confidence: Math.max(0.5, 1 - gap * 0.1 - (candidates.length > 1 ? 0.1 : 0)),
    });
  }
  return proposals;
}

/** Runs the matcher and stores anything new as a proposal. */
export function runReconcile(): number {
  const proposals = proposeLinks();
  if (!proposals.length) return 0;
  db.transaction(() => {
    for (const p of proposals) {
      db.insert(s.transferLinks)
        .values({ ...p, method: "auto", status: "proposed" })
        .onConflictDoNothing()
        .run();
    }
  });
  return proposals.length;
}

/* -------------------------------------------------------- pocket ledger --- */

export interface PocketLedger {
  accountId: number;
  accountName: string;
  kind: string;
  currency: string;
  /** Confirmed money in from linked transfers. */
  fundedCents: number;
  /** Transfers out of DBS with no confirmed link yet. */
  unmatchedCents: number;
  unmatchedCount: number;
  /** Itemised spend on the pocket's own statements. */
  itemisedCents: number;
  /** funded - itemised. Meaningful for a prepaid wallet, not for a card. */
  floatCents: number;
  /** The balance the newest statement itself reports - authoritative for a card. */
  statementBalanceCents: number | null;
  statementDate: string | null;
  hasStatements: boolean;
}

export function pocketLedgers(): PocketLedger[] {
  const pockets = db.select().from(s.accounts).where(eq(s.accounts.isPocket, true)).all();

  return pockets.map((a) => {
    const funded = db
      .select({ total: sql<number>`coalesce(sum(${s.transferLinks.amountCents}), 0)` })
      .from(s.transferLinks)
      .innerJoin(s.transactions, eq(s.transferLinks.targetTxnId, s.transactions.id))
      .where(and(eq(s.transferLinks.status, "confirmed"), eq(s.transactions.accountId, a.id)))
      .get()!.total;

    const unmatched = db
      .select({
        total: sql<number>`coalesce(sum(abs(${s.transactions.amountCents})), 0)`,
        n: sql<number>`count(*)`,
      })
      .from(s.transactions)
      .innerJoin(s.categories, eq(s.transactions.categoryId, s.categories.id))
      .where(
        and(
          eq(s.categories.pocketAccountId, a.id),
          eq(s.transactions.txnType, "internal_transfer"),
          sql`${s.transactions.id} not in (select source_txn_id from transfer_links where status = 'confirmed')`,
        ),
      )
      .get()!;

    const itemised = db
      .select({ total: sql<number>`coalesce(sum(abs(${s.transactions.amountCents})), 0)` })
      .from(s.transactions)
      .where(and(eq(s.transactions.accountId, a.id), sql`${s.transactions.amountCents} < 0`))
      .get()!.total;

    const stmts = db
      .select({ n: sql<number>`count(*)` })
      .from(s.statements)
      .where(eq(s.statements.accountId, a.id))
      .get()!.n;

    // For a card, what is owed is a fact the statement states; deriving it from
    // payments minus purchases would only be right if every statement were held.
    const latest = db
      .select({ b: s.statements.closingBalanceCents, d: s.statements.periodTo })
      .from(s.statements)
      .where(and(eq(s.statements.accountId, a.id), eq(s.statements.status, "imported")))
      .orderBy(desc(s.statements.periodTo))
      .limit(1)
      .get();

    return {
      accountId: a.id,
      accountName: a.name,
      kind: a.kind,
      currency: a.currency,
      fundedCents: funded,
      unmatchedCents: unmatched.total,
      unmatchedCount: unmatched.n,
      itemisedCents: itemised,
      floatCents: funded - itemised,
      statementBalanceCents: latest?.b ?? null,
      statementDate: latest?.d ?? null,
      hasStatements: stmts > 0,
    };
  });
}

export interface LinkRow {
  id: number;
  status: string;
  kind: string;
  amountCents: number;
  dateGapDays: number;
  confidence: number;
  method: string;
  sourceDate: string;
  sourceDesc: string;
  sourceAccount: string;
  /** The amount is the source's, so it is in the source account's currency. */
  currency: string;
  targetDate: string;
  targetDesc: string;
  targetAccount: string;
}

export function listLinks(status?: string): LinkRow[] {
  const src = sql`(select json_object('d', txn_date, 'x', description_raw) from transactions where id = ${s.transferLinks.sourceTxnId})`;
  const rows = db
    .select({
      id: s.transferLinks.id,
      status: s.transferLinks.status,
      kind: s.transferLinks.kind,
      amountCents: s.transferLinks.amountCents,
      dateGapDays: s.transferLinks.dateGapDays,
      confidence: s.transferLinks.confidence,
      method: s.transferLinks.method,
      sourceDate: sql<string>`(select txn_date from transactions where id = ${s.transferLinks.sourceTxnId})`,
      sourceDesc: sql<string>`(select description_raw from transactions where id = ${s.transferLinks.sourceTxnId})`,
      sourceAccount: sql<string>`(select a.name from transactions t join accounts a on a.id = t.account_id where t.id = ${s.transferLinks.sourceTxnId})`,
      currency: sql<string>`(select a.currency from transactions t join accounts a on a.id = t.account_id where t.id = ${s.transferLinks.sourceTxnId})`,
      targetDate: sql<string>`(select txn_date from transactions where id = ${s.transferLinks.targetTxnId})`,
      targetDesc: sql<string>`(select description_raw from transactions where id = ${s.transferLinks.targetTxnId})`,
      targetAccount: sql<string>`(select a.name from transactions t join accounts a on a.id = t.account_id where t.id = ${s.transferLinks.targetTxnId})`,
    })
    .from(s.transferLinks)
    .where(status ? eq(s.transferLinks.status, status as never) : undefined)
    .orderBy(desc(s.transferLinks.confidence))
    .all();
  return rows as LinkRow[];
}

export interface UnmatchedTransfer {
  id: number;
  txnDate: string;
  descriptionRaw: string;
  amountCents: number;
  currency: string;
  pocketName: string | null;
  categoryName: string | null;
}

export function unmatchedTransfers(): UnmatchedTransfer[] {
  return db
    .select({
      id: s.transactions.id,
      txnDate: s.transactions.txnDate,
      descriptionRaw: s.transactions.descriptionRaw,
      amountCents: s.transactions.amountCents,
      currency: s.accounts.currency,
      pocketName: sql<string | null>`(select name from accounts where id = ${s.categories.pocketAccountId})`,
      categoryName: s.categories.name,
    })
    .from(s.transactions)
    .leftJoin(s.categories, eq(s.transactions.categoryId, s.categories.id))
    .innerJoin(s.accounts, eq(s.transactions.accountId, s.accounts.id))
    .where(
      and(
        eq(s.transactions.txnType, "internal_transfer"),
        sql`${s.transactions.id} not in (select source_txn_id from transfer_links where status = 'confirmed')`,
      ),
    )
    .orderBy(desc(s.transactions.txnDate))
    .all() as UnmatchedTransfer[];
}
