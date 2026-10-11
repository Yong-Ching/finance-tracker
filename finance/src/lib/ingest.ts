import fs from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { extractRows, rowsToText } from "./parsers/pdf";
import { detectParsers, ParseError, type StatementResult } from "./parsers";
import { classify, byPriority } from "./classify";
import { dedupeHash, fileHash } from "./dedupe";
import { runReview, linkReviewToStatement, reviewEnabled } from "./ai/persist";
import type { ReviewOutcome } from "./ai/review";

type Db = BetterSQLite3Database<typeof schema>;

export interface IngestOutcome {
  status: "imported" | "quarantined" | "duplicate" | "unrecognised";
  statementId?: number;
  accountName?: string;
  parser?: string;
  inserted: number;
  skippedExisting: number;
  needsReview: number;
  continuityDelta: number;
  periodFrom?: string | null;
  periodTo?: string | null;
  warnings: string[];
  message?: string;
  /** Present on a preview when the Claude review layer ran. */
  review?: {
    status: ReviewOutcome["status"];
    sentCount: number;
    skippedExisting: number;
    categories: number;
    rules: number;
    flags: number;
    error?: string;
  };
}

const STATEMENT_DIR = path.join(process.cwd(), "data", "statements");

/**
 * Parses one statement PDF and commits it.
 *
 * The whole thing is one database transaction: a statement either lands
 * completely or not at all. A statement whose balances do not reconcile is
 * still stored, but marked `quarantined` and excluded from every total - the
 * numbers are never quietly wrong.
 */
export async function ingestPdf(
  db: Db,
  file: { buffer: Uint8Array; filename: string },
  opts: { accountId?: number; dryRun?: boolean; review?: boolean } = {},
): Promise<IngestOutcome> {
  const empty = { inserted: 0, skippedExisting: 0, needsReview: 0, continuityDelta: 0, warnings: [] };

  const sha256 = fileHash(file.buffer);
  const existing = db
    .select()
    .from(schema.statements)
    .where(eq(schema.statements.sha256, sha256))
    .get();
  if (existing) {
    return {
      ...empty,
      status: "duplicate",
      statementId: existing.id,
      message: `Already imported on ${new Date(existing.importedAt * 1000).toDateString()}.`,
    };
  }

  const rows = await extractRows(file.buffer);
  const detections = detectParsers(rowsToText(rows));
  if (!detections.length) {
    return { ...empty, status: "unrecognised", message: "No parser recognised this document." };
  }

  const { parser, confidence } = detections[0];
  let result: StatementResult;
  try {
    result = parser.parse(rows);
  } catch (err) {
    return {
      ...empty,
      status: "unrecognised",
      parser: parser.name,
      message: err instanceof ParseError ? err.message : String(err),
    };
  }

  // --- account -------------------------------------------------------------
  const account = opts.accountId
    ? db.select().from(schema.accounts).where(eq(schema.accounts.id, opts.accountId)).get()
    : db.select().from(schema.accounts).where(eq(schema.accounts.name, result.accountHint)).get();
  if (!account) {
    return { ...empty, status: "unrecognised", message: `Unknown account: ${result.accountHint}` };
  }

  // --- continuity: the hard gate -------------------------------------------
  const sum = result.transactions.reduce((a, t) => a + t.amountCents, 0);
  const continuityDelta =
    result.openingBalanceCents !== null && result.closingBalanceCents !== null
      ? result.openingBalanceCents + sum - result.closingBalanceCents
      : 0;
  const status: "imported" | "quarantined" = continuityDelta === 0 ? "imported" : "quarantined";

  // --- classify ------------------------------------------------------------
  const rules = byPriority(db.select().from(schema.rules).all());
  const hashes = result.transactions.map((t) =>
    dedupeHash({
      accountId: account.id,
      txnDate: t.txnDate,
      amountCents: t.amountCents,
      descriptionRaw: t.descriptionRaw,
    }),
  );
  const overrides = new Map(
    (hashes.length
      ? db.select().from(schema.overrides).where(inArray(schema.overrides.dedupeHash, hashes)).all()
      : []
    ).map((o) => [o.dedupeHash, o]),
  );
  const already = new Set(
    (hashes.length
      ? db
          .select({ h: schema.transactions.dedupeHash })
          .from(schema.transactions)
          .where(inArray(schema.transactions.dedupeHash, hashes))
          .all()
      : []
    ).map((r) => r.h),
  );

  // Classify up front so both the preview and the commit see the same result.
  const classified = result.transactions.map((t, i) => ({
    txn: t,
    hash: hashes[i],
    already: already.has(hashes[i]),
    c: classify(
      { accountId: account.id, txnDate: t.txnDate, amountCents: t.amountCents, descriptionRaw: t.descriptionRaw },
      rules,
      overrides.get(hashes[i]),
    ),
  }));

  const newRows = classified.filter((r) => !r.already);
  const previewNeedsReview = newRows.filter((r) => !r.c.isReviewed).length;

  if (opts.dryRun) {
    let review: IngestOutcome["review"];

    // The review runs here - before anything is written - and only ever sees
    // rows that are new to the database AND that no local rule could place.
    if (opts.review && reviewEnabled() && status === "imported") {
      const candidates = newRows
        .filter((r) => !r.c.isReviewed)
        .map((r) => ({
          txnDate: r.txn.txnDate,
          descriptionRaw: r.txn.descriptionRaw,
          amountCents: r.txn.amountCents,
          dedupeHash: r.hash,
        }));
      const { outcome } = await runReview(db, {
        sha256,
        accountId: account.id,
        accountName: account.name,
        period: { from: result.periodFrom, to: result.periodTo },
        candidates,
        skippedExisting: classified.length - newRows.length,
      });
      review = {
        status: outcome.status,
        sentCount: outcome.sentCount,
        skippedExisting: classified.length - newRows.length,
        categories: outcome.result?.categories.length ?? 0,
        rules: outcome.result?.rules.length ?? 0,
        flags: outcome.result?.flags.length ?? 0,
        error: outcome.error,
      };
    }

    return {
      ...empty,
      status,
      accountName: account.name,
      parser: `${parser.name}@${parser.version} (${Math.round(confidence * 100)}%)`,
      inserted: newRows.length,
      skippedExisting: classified.length - newRows.length,
      needsReview: previewNeedsReview,
      continuityDelta,
      periodFrom: result.periodFrom,
      periodTo: result.periodTo,
      warnings: result.warnings,
      review,
    };
  }

  // --- insert --------------------------------------------------------------
  let statementId = 0;
  let inserted = 0;
  let skippedExisting = 0;
  let needsReview = 0;

  db.transaction(() => {
    const stored = storeFile(file, account.name, sha256);
    const stmt = db
      .insert(schema.statements)
      .values({
        accountId: account.id,
        filename: file.filename,
        sha256,
        storedPath: stored,
        periodFrom: result.periodFrom,
        periodTo: result.periodTo,
        openingBalanceCents: result.openingBalanceCents,
        closingBalanceCents: result.closingBalanceCents,
        continuityDelta,
        status,
        parserName: parser.name,
        parserVersion: parser.version,
      })
      .returning({ id: schema.statements.id })
      .get();
    statementId = stmt.id;

    for (const { txn: t, hash, already: isDup, c } of classified) {
      if (isDup) { skippedExisting++; continue; }
      db.insert(schema.transactions)
        .values({
          statementId,
          accountId: account.id,
          txnDate: t.txnDate,
          postDate: t.postDate ?? null,
          descriptionRaw: t.descriptionRaw,
          amountCents: t.amountCents,
          balanceAfterCents: t.balanceAfterCents ?? null,
          currencyOriginal: t.currencyOriginal ?? "SGD",
          amountOriginalCents: t.amountOriginalCents ?? null,
          fxRate: t.fxRate ?? null,
          categoryId: c.categoryId,
          txnType: c.txnType,
          seen: c.seen,
          note: c.note,
          isReviewed: c.isReviewed,
          matchedRuleId: c.matchedRuleId,
          dedupeHash: hash,
        })
        .run();
      inserted++;
      if (!c.isReviewed) needsReview++;
    }

    // Attach the proposals produced by this file's preview.
    linkReviewToStatement(db, sha256, statementId);
  });

  return {
    status,
    statementId,
    accountName: account.name,
    parser: `${parser.name}@${parser.version}`,
    inserted,
    skippedExisting,
    needsReview,
    continuityDelta,
    periodFrom: result.periodFrom,
    periodTo: result.periodTo,
    warnings: result.warnings,
    message:
      status === "quarantined"
        ? `Balances do not reconcile (off by ${continuityDelta} cents). Imported but excluded from all totals.`
        : undefined,
  };
}

function storeFile(file: { buffer: Uint8Array; filename: string }, account: string, sha: string): string {
  const dir = path.join(STATEMENT_DIR, account);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(file.filename) || ".pdf";
  const dest = path.join(dir, `${sha.slice(0, 16)}${ext}`);
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, file.buffer);
  return path.relative(process.cwd(), dest);
}
