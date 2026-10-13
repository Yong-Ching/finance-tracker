"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq, isNull, like, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { TXN_TYPES, MATCH_TYPES, SUBSCRIPTION_CADENCES } from "@/db/schema";
import type { TxnType, MatchType } from "@/db/schema";

/*
 * Server actions are a public HTTP boundary: TypeScript types are erased at
 * runtime, so every input is validated here rather than trusted.
 */
const id = z.number().int().positive();
const txnType_ = z.enum(TXN_TYPES);
const txnType = txnType_;

/** Mirrors TxnFilters; validated because it arrives from the client. */
const txnFilters = z.object({
  q: z.string().max(200).optional(),
  accountId: id.optional(),
  categoryId: z.union([id, z.literal("none"), z.array(id).max(200)]).optional(),
  txnType: txnType_.optional(),
  from: z.string().max(10).optional(),
  to: z.string().max(10).optional(),
  reviewOnly: z.boolean().optional(),
  // Must be listed: zod drops unknown keys, and a dropped filter would widen a
  // bulk edit from one subscription's charges to everything else matching.
  subscriptionId: id.optional(),
  amount: z.string().max(50).optional(),
});

const txnPatch = z.object({
  categoryId: id.nullable().optional(),
  txnType: txnType.optional(),
  note: z.string().max(500).nullable().optional(),
  seen: z.boolean().optional(),
});

const ruleInput = z.object({
  pattern: z.string().trim().min(1).max(200),
  matchType: z.enum(MATCH_TYPES),
  categoryId: id,
  txnType,
  seen: z.boolean(),
  accountId: id.nullable(),
  priority: z.number().int(),
  note: z.string().max(500).nullable().optional(),
});

/**
 * Revalidation is a UI concern and runs after the write has already committed,
 * so it must never turn a successful edit into a thrown error. Outside a Next
 * request context - a script, a test - there is no cache to revalidate.
 */
const refresh = () => {
  try {
    for (const p of ["/", "/transactions", "/rules", "/reconcile", "/review", "/accounts", "/subscriptions"]) {
      revalidatePath(p);
    }
  } catch {
    /* no request context; nothing to revalidate */
  }
};

/**
 * A manual edit is recorded twice: on the transaction (so the page updates) and
 * as an override keyed by content hash (so it survives a statement re-import).
 */
export async function updateTransaction(
  rawId: number,
  rawPatch: { categoryId?: number | null; txnType?: TxnType; note?: string | null; seen?: boolean },
) {
  const txId = id.parse(rawId);
  const patch = txnPatch.parse(rawPatch);

  const tx = db.select().from(s.transactions).where(eq(s.transactions.id, txId)).get();
  if (!tx) throw new Error("No such transaction");

  db.update(s.transactions)
    .set({ ...patch, isReviewed: true, updatedAt: sql`(unixepoch())` })
    .where(eq(s.transactions.id, txId))
    .run();

  const next = { ...tx, ...patch };
  db.insert(s.overrides)
    .values({
      dedupeHash: tx.dedupeHash,
      categoryId: next.categoryId ?? null,
      txnType: next.txnType,
      seen: next.seen,
      note: next.note ?? null,
    })
    .onConflictDoUpdate({
      target: s.overrides.dedupeHash,
      set: {
        categoryId: next.categoryId ?? null,
        txnType: next.txnType,
        seen: next.seen,
        note: next.note ?? null,
      },
    })
    .run();

  refresh();
}

/**
 * Applies one category to many transactions in a single database transaction
 * with a single revalidation.
 *
 * Deliberately not a loop over updateTransaction: that revalidates every route
 * per row, which is fine for one edit and pathological for a select-all over
 * the review queue.
 */
function applyCategory(ids: number[], categoryId: number | null, txnType?: TxnType): number {
  if (!ids.length) return 0;
  let n = 0;
  db.transaction(() => {
    for (const txId of ids) {
      const tx = db.select().from(s.transactions).where(eq(s.transactions.id, txId)).get();
      if (!tx) continue;

      const nextType = txnType ?? tx.txnType;
      db.update(s.transactions)
        .set({ categoryId, txnType: nextType, isReviewed: true, updatedAt: sql`(unixepoch())` })
        .where(eq(s.transactions.id, txId))
        .run();

      // Same as a single edit: record it against the content hash so it
      // survives deleting and re-importing the statement.
      db.insert(s.overrides)
        .values({ dedupeHash: tx.dedupeHash, categoryId, txnType: nextType, seen: tx.seen, note: tx.note })
        .onConflictDoUpdate({
          target: s.overrides.dedupeHash,
          set: { categoryId, txnType: nextType, seen: tx.seen, note: tx.note },
        })
        .run();
      n++;
    }
  });
  return n;
}

export async function bulkSetCategory(ids: number[], categoryId: number | null, txnType?: TxnType) {
  const checked = z.array(id).max(5000).parse(ids);
  const catId = id.nullable().parse(categoryId);
  const n = applyCategory(checked, catId, txnType ? txnType_.parse(txnType) : undefined);
  refresh();
  return n;
}

/**
 * Applies a category to every transaction matching the current filters, not
 * just the ones on screen. This is what makes clearing a review queue of a few
 * hundred rows practical.
 */
export async function bulkSetCategoryForFilter(
  filters: unknown,
  categoryId: number | null,
  txnType?: TxnType,
) {
  const f = txnFilters.parse(filters);
  const { matchingTransactionIds } = await import("./queries");
  const ids = matchingTransactionIds(f);
  const n = applyCategory(ids, id.nullable().parse(categoryId), txnType ? txnType_.parse(txnType) : undefined);
  refresh();
  return n;
}

/* ------------------------------------------------------------------ rules --- */

export interface RuleInput {
  pattern: string;
  matchType: MatchType;
  categoryId: number;
  txnType: TxnType;
  seen: boolean;
  accountId: number | null;
  priority: number;
  note?: string | null;
}

export async function createRule(input: RuleInput, backfill: boolean) {
  const clean = ruleInput.parse(input);
  const r = db.insert(s.rules).values(clean).returning({ id: s.rules.id }).get();
  if (backfill) await applyRule(r.id);
  refresh();
  return r.id;
}

export async function updateRule(ruleId: number, input: Partial<RuleInput> & { active?: boolean }) {
  const clean = ruleInput.partial().extend({ active: z.boolean().optional() }).parse(input);
  db.update(s.rules).set(clean).where(eq(s.rules.id, id.parse(ruleId))).run();
  refresh();
}

export async function deleteRule(rawRuleId: number) {
  const ruleId = id.parse(rawRuleId);
  db.update(s.transactions).set({ matchedRuleId: null }).where(eq(s.transactions.matchedRuleId, ruleId)).run();
  db.delete(s.rules).where(eq(s.rules.id, ruleId)).run();
  refresh();
}

/**
 * Applies a rule to transactions already in the database.
 *
 * A manual override always wins, so rows carrying one are left alone - a new
 * rule fixes history without undoing decisions the user already made.
 */
export async function applyRule(rawRuleId: number): Promise<number> {
  const ruleId = id.parse(rawRuleId);
  const rule = db.select().from(s.rules).where(eq(s.rules.id, ruleId)).get();
  if (!rule) return 0;

  const candidates = db
    .select({ id: s.transactions.id, hash: s.transactions.dedupeHash })
    .from(s.transactions)
    .where(
      and(
        rule.matchType === "substring"
          ? like(sql`upper(${s.transactions.descriptionRaw})`, `%${rule.pattern.toUpperCase()}%`)
          : sql`1 = 1`,
        rule.accountId ? eq(s.transactions.accountId, rule.accountId) : undefined,
        sql`${s.transactions.dedupeHash} not in (select dedupe_hash from overrides)`,
      ),
    )
    .all();

  let n = 0;
  db.transaction(() => {
    for (const c of candidates) {
      db.update(s.transactions)
        .set({
          categoryId: rule.categoryId,
          txnType: rule.txnType,
          seen: rule.seen,
          matchedRuleId: rule.id,
          isReviewed: true,
          updatedAt: sql`(unixepoch())`,
        })
        .where(eq(s.transactions.id, c.id))
        .run();
      n++;
    }
  });
  refresh();
  return n;
}

/* -------------------------------------------------------------- categories --- */

export async function createCategory(name: string, bucket: "expense" | "savings" | "income" | "transfer") {
  const clean = z.object({
    name: z.string().trim().min(1).max(80),
    bucket: z.enum(["expense", "savings", "income", "transfer"]),
  }).parse({ name, bucket });
  const c = db.insert(s.categories).values(clean).returning({ id: s.categories.id }).get();
  refresh();
  return c.id;
}

/* ------------------------------------------------------------- transfers --- */

export async function setLinkStatus(linkId: number, status: "confirmed" | "rejected") {
  const st = z.enum(["confirmed", "rejected"]).parse(status);
  db.update(s.transferLinks).set({ status: st }).where(eq(s.transferLinks.id, id.parse(linkId))).run();
  refresh();
}

export async function confirmAllProposed() {
  db.update(s.transferLinks)
    .set({ status: "confirmed" })
    .where(eq(s.transferLinks.status, "proposed"))
    .run();
  refresh();
}

/** Manual link, for when the matcher misses. */
export async function linkManually(rawSource: number, rawTarget: number) {
  const sourceTxnId = id.parse(rawSource);
  const targetTxnId = id.parse(rawTarget);
  const src = db.select().from(s.transactions).where(eq(s.transactions.id, sourceTxnId)).get();
  const tgt = db.select().from(s.transactions).where(eq(s.transactions.id, targetTxnId)).get();
  if (!src || !tgt) throw new Error("No such transaction");

  const gap = Math.abs(
    Math.round(
      (new Date(`${src.txnDate}T00:00:00Z`).getTime() - new Date(`${tgt.txnDate}T00:00:00Z`).getTime()) / 86_400_000,
    ),
  );
  db.insert(s.transferLinks)
    .values({
      sourceTxnId, targetTxnId,
      kind: "topup",
      amountCents: Math.abs(src.amountCents),
      dateGapDays: gap,
      confidence: 1,
      method: "manual",
      status: "confirmed",
    })
    .onConflictDoNothing()
    .run();
  refresh();
}

export async function reconcileNow() {
  const { runReconcile } = await import("./reconcile");
  const n = runReconcile();
  refresh();
  return n;
}

/** Live "this pattern would match N transactions" preview for the rule editor. */
export async function previewPattern(rawPattern: string, rawAccountId: number | null): Promise<number> {
  const pattern = z.string().max(200).parse(rawPattern);
  const accountId = id.nullable().parse(rawAccountId);
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

/* ---------------------------------------------------------- AI proposals --- */

/**
 * Accepting a proposal is what turns it into data. Until this runs, a
 * suggestion has changed nothing: the transaction is still uncategorized and
 * still in the review queue.
 */
export async function acceptSuggestion(rawId: number) {
  const suggestionId = id.parse(rawId);
  const sug = db.select().from(s.aiSuggestions).where(eq(s.aiSuggestions.id, suggestionId)).get();
  if (!sug) throw new Error("No such suggestion");

  // Create the proposed category only at the moment it is actually used.
  let categoryId = sug.categoryId;
  if (!categoryId && sug.newCategoryName) {
    const bucket =
      sug.txnType === "income" ? "income"
      : sug.txnType === "savings" ? "savings"
      : sug.txnType === "internal_transfer" ? "transfer"
      : "expense";
    const existing = db
      .select()
      .from(s.categories)
      .where(eq(s.categories.name, sug.newCategoryName))
      .get();
    categoryId = existing
      ? existing.id
      : db.insert(s.categories)
          .values({ name: sug.newCategoryName, bucket })
          .returning({ id: s.categories.id })
          .get().id;
  }

  if (sug.kind === "category" && sug.dedupeHash) {
    const tx = db
      .select()
      .from(s.transactions)
      .where(eq(s.transactions.dedupeHash, sug.dedupeHash))
      .get();
    if (tx) {
      await updateTransaction(tx.id, {
        categoryId,
        txnType: sug.txnType ?? undefined,
        note: sug.reasoning,
      });
    }
  } else if (sug.kind === "rule" && sug.pattern && categoryId) {
    const last = db.select().from(s.rules).orderBy(desc(s.rules.priority)).limit(1).get();
    await createRule(
      {
        pattern: sug.pattern,
        matchType: "substring",
        categoryId,
        txnType: sug.txnType ?? "expense",
        seen: true,
        accountId: null,
        priority: (last?.priority ?? 0) + 10,
        note: sug.reasoning,
      },
      true, // backfill: a rule that only applies going forward leaves history wrong
    );
  }
  // A flag has nothing to apply; accepting it just marks it as handled.

  db.update(s.aiSuggestions)
    .set({ status: "accepted" })
    .where(eq(s.aiSuggestions.id, suggestionId))
    .run();
  refresh();
}

export async function rejectSuggestion(rawId: number) {
  db.update(s.aiSuggestions)
    .set({ status: "rejected" })
    .where(eq(s.aiSuggestions.id, id.parse(rawId)))
    .run();
  refresh();
}

export async function acceptAllSuggestions(kind: "category" | "rule", minConfidence: number) {
  const conf = z.number().min(0).max(1).parse(minConfidence);
  const pending = db
    .select({ id: s.aiSuggestions.id })
    .from(s.aiSuggestions)
    .where(
      and(
        eq(s.aiSuggestions.status, "pending"),
        eq(s.aiSuggestions.kind, kind),
        sql`${s.aiSuggestions.confidence} >= ${conf}`,
      ),
    )
    .all();
  for (const p of pending) await acceptSuggestion(p.id);
}

/**
 * Reviews transactions already in the database that no rule could place.
 *
 * The upload preview only reviews rows arriving with a new statement, so
 * without this the backlog that predates the review layer could never be
 * looked at - every statement is already imported, and re-uploading one is a
 * no-op by design.
 */
export async function reviewBacklog(limit = 200) {
  const max = z.number().int().min(1).max(500).parse(limit);
  const { runReview } = await import("./ai/persist");

  const rows = db
    .select({
      id: s.transactions.id,
      txnDate: s.transactions.txnDate,
      descriptionRaw: s.transactions.descriptionRaw,
      amountCents: s.transactions.amountCents,
      dedupeHash: s.transactions.dedupeHash,
      accountId: s.transactions.accountId,
      accountName: s.accounts.name,
    })
    .from(s.transactions)
    .innerJoin(s.accounts, eq(s.transactions.accountId, s.accounts.id))
    .where(
      and(
        eq(s.transactions.isReviewed, false),
        isNull(s.transactions.categoryId),
        // Anything already proposed on is left alone, so a second run does not
        // re-send the same rows or pile up duplicate suggestions.
        sql`${s.transactions.dedupeHash} not in (
              select dedupe_hash from ai_suggestions
              where dedupe_hash is not null and status = 'pending')`,
      ),
    )
    .orderBy(desc(s.transactions.txnDate))
    .limit(max)
    .all();

  if (!rows.length) {
    refresh();
    return { sent: 0, accounts: 0, errors: [] as string[] };
  }

  // One call per account: the prompt states which account it is looking at.
  const byAccount = new Map<number, typeof rows>();
  for (const r of rows) byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), r]);

  let sent = 0;
  const errors: string[] = [];
  for (const [accountId, group] of byAccount) {
    const dates = group.map((g) => g.txnDate).sort();
    const { outcome } = await runReview(db, {
      sha256: `backlog:${accountId}:${Date.now()}`,
      accountId,
      accountName: group[0].accountName,
      period: { from: dates[0], to: dates[dates.length - 1] },
      candidates: group.map((g) => ({
        txnDate: g.txnDate,
        descriptionRaw: g.descriptionRaw,
        amountCents: g.amountCents,
        dedupeHash: g.dedupeHash,
      })),
      skippedExisting: 0,
    });
    if (outcome.error) errors.push(`${group[0].accountName}: ${outcome.error}`);
    else sent += outcome.sentCount;
  }

  refresh();
  return { sent, accounts: byAccount.size, errors };
}

/* ---------------------------------------------------------- subscriptions */

const subscriptionInput = z.object({
  name: z.string().trim().min(1).max(100),
  pattern: z.string().trim().min(1).max(200),
  accountId: id.nullable(),
  amountCents: z.number().int().positive().max(100_000_000),
  cadence: z.enum(SUBSCRIPTION_CADENCES),
  note: z.string().max(500).nullable().optional(),
});
export type SubscriptionInput = z.infer<typeof subscriptionInput>;

/** Tracks a subscription - from a detected candidate, or entered by hand. */
export async function createSubscription(input: SubscriptionInput) {
  const clean = subscriptionInput.parse(input);
  const r = db.insert(s.subscriptions).values({ ...clean, status: "active" })
    .returning({ id: s.subscriptions.id }).get();
  refresh();
  return r.id;
}

export async function updateSubscription(rawId: number, input: Partial<SubscriptionInput>) {
  const clean = subscriptionInput.partial().parse(input);
  db.update(s.subscriptions).set(clean).where(eq(s.subscriptions.id, id.parse(rawId))).run();
  refresh();
}

/** Cancel (keeps the record, leaves the monthly total) or reactivate. */
export async function setSubscriptionStatus(rawId: number, status: "active" | "cancelled") {
  const st = z.enum(["active", "cancelled"]).parse(status);
  db.update(s.subscriptions)
    .set({ status: st, cancelledAt: st === "cancelled" ? sql`(unixepoch())` : null })
    .where(eq(s.subscriptions.id, id.parse(rawId)))
    .run();
  refresh();
}

/**
 * "Not a subscription." Stored as a dismissed row so the same repeating charge
 * is never proposed again; it never counts toward any total.
 */
export async function dismissCandidate(input: { pattern: string; accountId: number; amountCents: number }) {
  const clean = subscriptionInput.pick({ pattern: true, amountCents: true })
    .extend({ accountId: id }).parse(input);
  db.insert(s.subscriptions)
    .values({ ...clean, name: clean.pattern, cadence: "monthly", status: "dismissed" })
    .run();
  refresh();
}

export async function deleteSubscription(rawId: number) {
  db.delete(s.subscriptions).where(eq(s.subscriptions.id, id.parse(rawId))).run();
  refresh();
}
