// No "server-only" guard here: this module is reached from ingest.ts, which
// the CLI import scripts use. It is server code by nature - it reads the API
// key - and is only ever imported from server components, actions and scripts.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as s from "@/db/schema";
import { reviewStatement, reviewEnabled, type ReviewOutcome } from "./review";

type Db = BetterSQLite3Database<typeof s>;

export interface Candidate {
  txnDate: string;
  descriptionRaw: string;
  amountCents: number;
  dedupeHash: string;
}

/**
 * Runs the review and stores its proposals.
 *
 * Two gates stand in front of the API call, in this order:
 *   1. anything already in the database is dropped - re-uploading a statement
 *      never re-sends its contents;
 *   2. anything a local rule or a manual override already settles is dropped -
 *      the model only ever sees what the deterministic pipeline could not place.
 * Whatever survives is redacted before it leaves the machine.
 */
export async function runReview(
  db: Db,
  args: {
    sha256: string;
    accountId: number;
    accountName: string;
    period: { from: string | null; to: string | null };
    candidates: Candidate[];
    skippedExisting: number;
  },
): Promise<{ outcome: ReviewOutcome; reviewId?: number }> {
  const outcome = await reviewStatement({
    candidates: args.candidates,
    accountName: args.accountName,
    period: args.period,
    categories: db
      .select({ name: s.categories.name, bucket: s.categories.bucket })
      .from(s.categories)
      .where(eq(s.categories.archived, false))
      .all(),
    existingPatterns: db
      .select({ p: s.rules.pattern })
      .from(s.rules)
      .where(eq(s.rules.active, true))
      .all()
      .map((r) => r.p),
  });

  if (outcome.status === "disabled") return { outcome };

  // Nothing was sent, so no request was made and there is nothing to record.
  // Logging these would fill the run history with empty rows on every preview
  // of a statement already held.
  if (outcome.sentCount === 0 && !outcome.error) return { outcome };

  const catByName = new Map(
    db.select().from(s.categories).all().map((c) => [c.name.toLowerCase(), c.id] as const),
  );

  let reviewId = 0;
  db.transaction(() => {
    // A previous preview of the same file leaves an unlinked review behind.
    const stale = db
      .select({ id: s.aiReviews.id })
      .from(s.aiReviews)
      .where(and(eq(s.aiReviews.sha256, args.sha256), isNull(s.aiReviews.statementId)))
      .all();
    if (stale.length) {
      db.delete(s.aiReviews).where(inArray(s.aiReviews.id, stale.map((r) => r.id))).run();
    }

    reviewId = db
      .insert(s.aiReviews)
      .values({
        sha256: args.sha256,
        statementId: null,
        model: outcome.model,
        sentCount: outcome.sentCount,
        skippedExistingCount: args.skippedExisting,
        inputTokens: outcome.inputTokens ?? null,
        outputTokens: outcome.outputTokens ?? null,
        error: outcome.error ?? null,
      })
      .returning({ id: s.aiReviews.id })
      .get().id;

    const r = outcome.result;
    if (!r) return;

    for (const c of r.categories) {
      const hash = args.candidates[c.ref]?.dedupeHash;
      if (!hash) continue;
      const existing = catByName.get(c.categoryName.trim().toLowerCase());
      db.insert(s.aiSuggestions)
        .values({
          reviewId, kind: "category", dedupeHash: hash,
          categoryId: existing ?? null,
          newCategoryName: existing ? null : c.categoryName.trim(),
          txnType: c.txnType,
          confidence: c.confidence,
          reasoning: c.reasoning,
        })
        .run();
    }

    for (const rule of r.rules) {
      const existing = catByName.get(rule.categoryName.trim().toLowerCase());
      db.insert(s.aiSuggestions)
        .values({
          reviewId, kind: "rule", dedupeHash: null,
          categoryId: existing ?? null,
          newCategoryName: existing ? null : rule.categoryName.trim(),
          txnType: rule.txnType,
          pattern: rule.pattern.trim(),
          confidence: rule.confidence,
          reasoning: rule.reasoning,
        })
        .run();
    }

    for (const f of r.flags) {
      const hash = args.candidates[f.ref]?.dedupeHash;
      if (!hash) continue;
      db.insert(s.aiSuggestions)
        .values({
          reviewId, kind: "flag", dedupeHash: hash,
          flagType: f.flagType,
          confidence: f.confidence,
          reasoning: f.reasoning,
        })
        .run();
    }
  });

  return { outcome, reviewId };
}

/** Called once the statement is committed, to attach its preview's review. */
export function linkReviewToStatement(db: Db, sha256: string, statementId: number) {
  db.update(s.aiReviews)
    .set({ statementId })
    .where(and(eq(s.aiReviews.sha256, sha256), isNull(s.aiReviews.statementId)))
    .run();
}

export { reviewEnabled };
