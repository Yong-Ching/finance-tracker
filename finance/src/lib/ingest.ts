import fs from "node:fs";
import path from "node:path";
import { desc, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { extractRows, rowsToText } from "./parsers/pdf";
import { detectParsers, ParseError, type StatementResult } from "./parsers";
import { parseGeneric } from "./parsers/generic";
import { classify, byPriority } from "./classify";
import { dedupeHash, fileHash } from "./dedupe";
import { runReview, linkReviewToStatement, reviewEnabled } from "./ai/persist";
import { DATA_DIR, FILES_ROOT } from "./paths";
import type { ReviewOutcome } from "./ai/review";

type Db = BetterSQLite3Database<typeof schema>;

/** A new account to create with the statement, for one no account matches yet. */
export interface NewAccount {
  name: string;
  kind: schema.AccountKind;
  currency: string;
}

/** The generic reader, used when no bank-specific parser understands a statement. */
const GENERIC = { name: "generic", version: "0.1.0" };

export interface IngestOutcome {
  /** `needs_account`: read by the generic reader, which cannot tell whose statement it is. */
  status: "imported" | "quarantined" | "duplicate" | "unrecognised" | "needs_account";
  /**
   * False when the statement must not be imported as it stands: a generic read
   * is only trusted when its balances were found and reconcile.
   */
  importable?: boolean;
  /** The accounts to choose from when the status is `needs_account`. */
  accounts?: Array<{ id: number; name: string; currency: string; kind: string }>;
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
  /** On a preview: every row as it would be stored, for the user to check first. */
  preview?: {
    currency: string;
    openingBalanceCents: number | null;
    closingBalanceCents: number | null;
    rows: PreviewRow[];
  };
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

export interface PreviewRow {
  txnDate: string;
  descriptionRaw: string;
  amountCents: number;
  balanceAfterCents: number | null;
  /** Its original currency, when the statement printed a foreign amount. */
  currencyOriginal: string | null;
  amountOriginalCents: number | null;
  category: string | null;
  txnType: string;
  /** Already in the ledger (from an earlier statement): it will be skipped. */
  already: boolean;
}

const STATEMENT_DIR = path.join(DATA_DIR, "statements");

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
  opts: { accountId?: number; newAccount?: NewAccount; dryRun?: boolean; review?: boolean } = {},
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

  // A bank-specific parser first; the generic reader when none understands it.
  let parser: { name: string; version: string } = GENERIC;
  let confidence = 0;
  let result: StatementResult | null = null;
  let failure = "No parser recognised this document.";
  if (detections.length) {
    const top = detections[0];
    parser = top.parser;
    confidence = top.confidence;
    try {
      result = top.parser.parse(rows);
    } catch (err) {
      failure = err instanceof ParseError ? err.message : String(err);
    }
  }
  if (!result) {
    const tried = parser.name;
    try {
      result = parseGeneric(await extractRows(file.buffer, { upright: true }));
      parser = GENERIC;
      confidence = 0;
      if (detections.length) result.warnings.unshift(`the ${tried} parser could not read it (${failure}); read generically`);
    } catch (err) {
      return {
        ...empty,
        status: "unrecognised",
        parser: detections.length ? tried : undefined,
        message: `${failure} The generic reader could not read it either: ${err instanceof ParseError ? err.message : String(err)}`,
      };
    }
  }
  const generic = parser === GENERIC;

  // --- continuity: the hard gate -------------------------------------------
  const sum = result.transactions.reduce((a, t) => a + t.amountCents, 0);
  const balanced = result.openingBalanceCents !== null && result.closingBalanceCents !== null;
  const continuityDelta = balanced ? result.openingBalanceCents! + sum - result.closingBalanceCents! : 0;
  const status: "imported" | "quarantined" = continuityDelta === 0 ? "imported" : "quarantined";
  // A bank parser's misread is quarantined; a generic one is not imported at all.
  const importable = !generic || (balanced && continuityDelta === 0);
  const notImportable = !balanced
    ? "The generic reader found no opening or closing balance, so the rows cannot be checked. Not imported."
    : `The generic reader's rows do not reconcile (off by ${continuityDelta} cents), so they are probably misread. Not imported.`;

  // --- account -------------------------------------------------------------
  const accountList = () => db.select().from(schema.accounts).orderBy(schema.accounts.sortOrder).all()
    .map((a) => ({ id: a.id, name: a.name, currency: a.currency, kind: a.kind }));
  let account: schema.Account | undefined;
  if (opts.newAccount) {
    const n = opts.newAccount;
    const name = n.name.trim();
    if (!name) return { ...empty, status: "needs_account", accounts: accountList(), message: "Give the new account a name." };
    if (!schema.ACCOUNT_KINDS.includes(n.kind) || !/^[A-Z]{3}$/.test(n.currency)) {
      return { ...empty, status: "needs_account", accounts: accountList(), message: "Choose the account's type and a three-letter currency." };
    }
    if (db.select().from(schema.accounts).where(eq(schema.accounts.name, name)).get()) {
      return { ...empty, status: "needs_account", accounts: accountList(), message: `An account called ${name} already exists; choose it instead.` };
    }
    // Not stored until the import commits; id 0 matches no existing row or rule.
    account = {
      id: 0, name, institution: name, kind: n.kind, currency: n.currency,
      isPocket: n.kind === "credit_card" || n.kind === "prepaid", active: true, sortOrder: 0,
    };
  } else if (opts.accountId) {
    account = db.select().from(schema.accounts).where(eq(schema.accounts.id, opts.accountId)).get();
  } else if (!generic) {
    account = db.select().from(schema.accounts).where(eq(schema.accounts.name, result.accountHint)).get();
    if (!account) return { ...empty, status: "unrecognised", message: `Unknown account: ${result.accountHint}` };
  }
  const forAccount = account ?? {
    id: 0, name: "", institution: "", kind: "bank" as const, currency: "", isPocket: false, active: true, sortOrder: 0,
  };

  // --- classify ------------------------------------------------------------
  const rules = byPriority(db.select().from(schema.rules).all());
  const hashes = result.transactions.map((t) =>
    dedupeHash({
      accountId: forAccount.id,
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
      { accountId: forAccount.id, txnDate: t.txnDate, amountCents: t.amountCents, descriptionRaw: t.descriptionRaw },
      rules,
      overrides.get(hashes[i]),
    ),
  }));

  const newRows = classified.filter((r) => !r.already);
  const previewNeedsReview = newRows.filter((r) => !r.c.isReviewed).length;

  // Never written: a generic read with nowhere to go, or one that does not check out.
  if (!opts.dryRun && (!account || !importable)) {
    return {
      ...empty, status: "unrecognised", importable: false, parser: `${parser.name}@${parser.version}`,
      message: !account ? "Choose the account this statement belongs to first." : notImportable,
    };
  }

  if (opts.dryRun || !account) {
    let review: IngestOutcome["review"];

    // The review runs here - before anything is written - and only ever sees
    // rows that are new to the database AND that no local rule could place.
    // A new account (id 0) is not stored yet, so it has no review to attach.
    if (opts.dryRun && account && account.id !== 0 && importable && opts.review && reviewEnabled() && status === "imported") {
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

    const names = new Map(db.select({ id: schema.categories.id, name: schema.categories.name }).from(schema.categories).all()
      .map((c) => [c.id, c.name]));
    const preview: IngestOutcome["preview"] = {
      currency: forAccount.currency,
      openingBalanceCents: result.openingBalanceCents,
      closingBalanceCents: result.closingBalanceCents,
      rows: classified.map(({ txn: t, already: isDup, c }) => ({
        txnDate: t.txnDate,
        descriptionRaw: t.descriptionRaw,
        amountCents: t.amountCents,
        balanceAfterCents: t.balanceAfterCents ?? null,
        currencyOriginal: t.currencyOriginal && t.currencyOriginal !== forAccount.currency ? t.currencyOriginal : null,
        amountOriginalCents: t.amountOriginalCents ?? null,
        category: c.categoryId !== null ? names.get(c.categoryId) ?? null : null,
        txnType: c.txnType,
        already: isDup,
      })),
    };

    return {
      ...empty,
      status: account ? status : "needs_account",
      importable,
      accounts: account && !generic ? undefined : accountList(),
      message: !importable ? notImportable : !account ? "Read by the generic reader. Choose the account it belongs to." : undefined,
      accountName: account?.name,
      parser: generic ? `${parser.name}@${parser.version} (no bank-specific parser)` : `${parser.name}@${parser.version} (${Math.round(confidence * 100)}%)`,
      inserted: newRows.length,
      skippedExisting: classified.length - newRows.length,
      needsReview: previewNeedsReview,
      continuityDelta,
      periodFrom: result.periodFrom,
      periodTo: result.periodTo,
      warnings: result.warnings,
      review,
      preview,
    };
  }

  // --- insert --------------------------------------------------------------
  let target: schema.Account = account;
  let statementId = 0;
  let inserted = 0;
  let skippedExisting = 0;
  let needsReview = 0;

  db.transaction(() => {
    if (target.id === 0) {
      const last = db.select({ n: schema.accounts.sortOrder }).from(schema.accounts).orderBy(desc(schema.accounts.sortOrder)).get();
      const { name, institution, kind, currency, isPocket } = target;
      target = db.insert(schema.accounts)
        .values({ name, institution, kind, currency, isPocket, sortOrder: (last?.n ?? 0) + 1 })
        .returning().get();
    }
    const stored = storeFile(file, target.name, sha256);
    const stmt = db
      .insert(schema.statements)
      .values({
        accountId: target.id,
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
          accountId: target.id,
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
    accountName: target.name,
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
  return path.relative(FILES_ROOT, dest);
}
