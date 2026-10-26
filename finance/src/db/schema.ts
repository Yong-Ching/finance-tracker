import { sql, relations } from "drizzle-orm";
import {
  sqliteTable,
  integer,
  text,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/* ------------------------------------------------------------------ enums */
// SQLite has no enum type; these unions are enforced in Zod at the boundary
// and documented here so the schema reads as the contract.

export const ACCOUNT_KINDS = ["bank", "credit_card", "prepaid", "retirement", "brokerage"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/**
 * The three top-level dashboard buckets, plus "transfer" - which is NOT a
 * dashboard bucket but the exclusion class: money moving between the user's own
 * accounts. Keeping it in the same field means a transfer can never be silently
 * summed into spending.
 */
export const BUCKETS = ["expense", "savings", "income", "transfer"] as const;
export type Bucket = (typeof BUCKETS)[number];

/** The buckets the dashboard actually reports. */
export const REPORTING_BUCKETS = ["income", "expense", "savings"] as const;

export const TXN_TYPES = [
  "expense",
  "income",
  "savings",
  "debt_repayment",
  "internal_transfer",
] as const;
export type TxnType = (typeof TXN_TYPES)[number];

export const MATCH_TYPES = ["substring", "regex", "amountAndDay"] as const;
export type MatchType = (typeof MATCH_TYPES)[number];

export const STATEMENT_STATUSES = ["imported", "quarantined"] as const;
export type StatementStatus = (typeof STATEMENT_STATUSES)[number];

export const LINK_KINDS = ["topup", "bill_payment"] as const;
export const LINK_METHODS = ["auto", "manual"] as const;
export const LINK_STATUSES = ["proposed", "confirmed", "rejected"] as const;

const now = sql`(unixepoch())`;

/* --------------------------------------------------------------- accounts */

export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  institution: text("institution").notNull(),
  kind: text("kind").$type<AccountKind>().notNull(),
  currency: text("currency").notNull().default("SGD"),
  /**
   * A pocket is funded by transfer from another account and its contents are
   * invisible until its own statement is uploaded (YouTrip, Citibank).
   */
  isPocket: integer("is_pocket", { mode: "boolean" }).notNull().default(false),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

/* ------------------------------------------------------------- categories */

export const categories = sqliteTable(
  "categories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull().unique(),
    bucket: text("bucket").$type<Bucket>().notNull(),
    parentId: integer("parent_id"),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    /**
     * For a category that represents money moving into a pocket (a YouTrip
     * top-up, a Citibank bill payment), the account that money lands in.
     * This is what lets reconciliation know where to look for the other side.
     */
    pocketAccountId: integer("pocket_account_id"),
  },
  (t) => [index("categories_bucket_idx").on(t.bucket)],
);

/* ------------------------------------------------------------- statements */

export const statements = sqliteTable(
  "statements",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    filename: text("filename").notNull(),
    /** Content hash of the PDF. Re-uploading the same file is a no-op. */
    sha256: text("sha256").notNull(),
    storedPath: text("stored_path"),
    periodFrom: text("period_from"), // ISO yyyy-mm-dd
    periodTo: text("period_to"),
    openingBalanceCents: integer("opening_balance_cents"),
    closingBalanceCents: integer("closing_balance_cents"),
    /**
     * opening + sum(amounts) - closing, in cents. Must be 0 for the statement
     * to count. Anything else quarantines the statement.
     */
    continuityDelta: integer("continuity_delta").notNull().default(0),
    status: text("status").$type<StatementStatus>().notNull().default("imported"),
    parserName: text("parser_name").notNull(),
    parserVersion: text("parser_version").notNull(),
    importedAt: integer("imported_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("statements_sha256_idx").on(t.sha256),
    index("statements_account_idx").on(t.accountId),
  ],
);

/* ----------------------------------------------------------- transactions */

export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    statementId: integer("statement_id").references(() => statements.id, {
      onDelete: "cascade",
    }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),

    txnDate: text("txn_date").notNull(), // ISO yyyy-mm-dd, sorts lexically
    postDate: text("post_date"),

    descriptionRaw: text("description_raw").notNull(),
    descriptionClean: text("description_clean"),

    /** Signed, negative = money out. The ONLY field totals are computed from. */
    amountCents: integer("amount_cents").notNull(),

    /** Multi-currency (YouTrip). SGD rows are 'SGD' / null / 1.0. */
    currencyOriginal: text("currency_original").notNull().default("SGD"),
    amountOriginalCents: integer("amount_original_cents"),
    fxRate: real("fx_rate"),

    balanceAfterCents: integer("balance_after_cents"),

    /** null = uncategorized; never a guessed default. */
    categoryId: integer("category_id").references(() => categories.id),
    txnType: text("txn_type").$type<TxnType>().notNull(),
    /**
     * false = the money moved into a pocket we cannot itemise yet. Such a row
     * is never presented as accounted-for spending.
     */
    seen: integer("seen", { mode: "boolean" }).notNull().default(true),

    note: text("note"),
    tags: text("tags", { mode: "json" }).$type<string[]>(),
    isRecurring: integer("is_recurring", { mode: "boolean" }).notNull().default(false),
    isReviewed: integer("is_reviewed", { mode: "boolean" }).notNull().default(false),

    matchedRuleId: integer("matched_rule_id"),

    /**
     * sha256(accountId|txnDate|amountCents|descriptionRaw). Manual overrides key
     * off this so an edit survives deleting and re-importing the statement.
     */
    dedupeHash: text("dedupe_hash").notNull(),

    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [
    index("txn_date_idx").on(t.txnDate),
    index("txn_account_idx").on(t.accountId),
    index("txn_category_idx").on(t.categoryId),
    index("txn_type_idx").on(t.txnType),
    index("txn_review_idx").on(t.isReviewed),
    index("txn_dedupe_idx").on(t.dedupeHash),
  ],
);

/* ------------------------------------------------------------------ rules */

export const rules = sqliteTable(
  "rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    pattern: text("pattern").notNull(),
    matchType: text("match_type").$type<MatchType>().notNull().default("substring"),
    /** null = applies to any account. */
    accountId: integer("account_id").references(() => accounts.id),
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id),
    txnType: text("txn_type").$type<TxnType>().notNull(),
    seen: integer("seen", { mode: "boolean" }).notNull().default(true),
    /** Lower runs first; first match wins. */
    priority: integer("priority").notNull().default(100),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    /** For matchType 'amountAndDay' (rent, whose payee name changes). */
    amountCents: integer("amount_cents"),
    dayMax: integer("day_max"),
    note: text("note"),
    hitCount: integer("hit_count").notNull().default(0),
    lastMatchedAt: integer("last_matched_at"),
  },
  (t) => [index("rules_priority_idx").on(t.priority)],
);

/* -------------------------------------------------------------- overrides */

/** A manual decision on one specific transaction. Beats every rule. */
export const overrides = sqliteTable(
  "overrides",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    dedupeHash: text("dedupe_hash").notNull(),
    categoryId: integer("category_id").references(() => categories.id),
    txnType: text("txn_type").$type<TxnType>(),
    seen: integer("seen", { mode: "boolean" }),
    note: text("note"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("overrides_hash_idx").on(t.dedupeHash)],
);

/* ---------------------------------------------------------- transferLinks */

/**
 * Links a DBS outflow to the pocket credit it became, so the same money is
 * neither counted twice (transfer + itemised spend) nor lost.
 */
export const transferLinks = sqliteTable(
  "transfer_links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceTxnId: integer("source_txn_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    targetTxnId: integer("target_txn_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    kind: text("kind").$type<(typeof LINK_KINDS)[number]>().notNull(),
    amountCents: integer("amount_cents").notNull(),
    dateGapDays: integer("date_gap_days").notNull(),
    confidence: real("confidence").notNull(),
    method: text("method").$type<(typeof LINK_METHODS)[number]>().notNull(),
    status: text("status")
      .$type<(typeof LINK_STATUSES)[number]>()
      .notNull()
      .default("proposed"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("links_pair_idx").on(t.sourceTxnId, t.targetTxnId),
    index("links_status_idx").on(t.status),
  ],
);

/* -------------------------------------------------------------- relations */

export const accountsRelations = relations(accounts, ({ many }) => ({
  transactions: many(transactions),
  statements: many(statements),
}));

export const statementsRelations = relations(statements, ({ one, many }) => ({
  account: one(accounts, { fields: [statements.accountId], references: [accounts.id] }),
  transactions: many(transactions),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  account: one(accounts, { fields: [transactions.accountId], references: [accounts.id] }),
  category: one(categories, { fields: [transactions.categoryId], references: [categories.id] }),
  statement: one(statements, { fields: [transactions.statementId], references: [statements.id] }),
}));

export const categoriesRelations = relations(categories, ({ many }) => ({
  transactions: many(transactions),
}));

export type Account = typeof accounts.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Statement = typeof statements.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type Rule = typeof rules.$inferSelect;
export type TransferLink = typeof transferLinks.$inferSelect;

/* ------------------------------------------------------------ AI review --- */

export const SUGGESTION_KINDS = ["category", "rule", "flag"] as const;
export const FLAG_TYPES = ["parse", "duplicate", "transfer"] as const;
export const SUGGESTION_STATUSES = ["pending", "accepted", "rejected"] as const;

/** One run of the Claude review layer. */
export const aiReviews = sqliteTable("ai_reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  statementId: integer("statement_id").references(() => statements.id, { onDelete: "cascade" }),
  /**
   * Content hash of the reviewed PDF. The review runs during the upload preview,
   * before anything is committed, so this is how its suggestions are linked to
   * the statement once the user confirms.
   */
  sha256: text("sha256").notNull(),
  model: text("model").notNull(),
  /** How many transactions were sent - the rest were already in the database. */
  sentCount: integer("sent_count").notNull(),
  skippedExistingCount: integer("skipped_existing_count").notNull().default(0),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  error: text("error"),
  createdAt: integer("created_at").notNull().default(now),
});

/**
 * A proposal, never a decision. Nothing here changes a transaction until the
 * user accepts it, which keeps the "never guess a category" rule intact.
 */
export const aiSuggestions = sqliteTable(
  "ai_suggestions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    reviewId: integer("review_id")
      .notNull()
      .references(() => aiReviews.id, { onDelete: "cascade" }),
    kind: text("kind").$type<(typeof SUGGESTION_KINDS)[number]>().notNull(),

    /** Which transaction this concerns; null for a rule proposal. */
    dedupeHash: text("dedupe_hash"),

    categoryId: integer("category_id").references(() => categories.id),
    newCategoryName: text("new_category_name"),
    txnType: text("txn_type").$type<TxnType>(),

    /** For kind = 'rule'. */
    pattern: text("pattern"),

    /** For kind = 'flag'. */
    flagType: text("flag_type").$type<(typeof FLAG_TYPES)[number]>(),

    confidence: real("confidence").notNull().default(0),
    reasoning: text("reasoning"),
    status: text("status")
      .$type<(typeof SUGGESTION_STATUSES)[number]>()
      .notNull()
      .default("pending"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [
    index("sugg_hash_idx").on(t.dedupeHash),
    index("sugg_status_idx").on(t.status),
    index("sugg_kind_idx").on(t.kind),
  ],
);

export type AiReview = typeof aiReviews.$inferSelect;
export type AiSuggestion = typeof aiSuggestions.$inferSelect;

/* ---------------------------------------------------------- subscriptions */

export const SUBSCRIPTION_CADENCES = ["weekly", "monthly", "quarterly", "yearly"] as const;
export type SubscriptionCadence = (typeof SUBSCRIPTION_CADENCES)[number];

/**
 * active    - tracked, and counted in the monthly total
 * cancelled - tracked once, ended by the user; kept for the record
 * dismissed - a detected candidate the user said is not a subscription, kept
 *             only so it is not suggested again
 */
export const SUBSCRIPTION_STATUSES = ["active", "cancelled", "dismissed"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * A recurring charge the user chose to track. Nothing becomes a subscription
 * by detection alone: candidates are proposed, and only the user's confirmation
 * creates an active row - the same "never guess" rule as categories.
 *
 * Charges are not stored here. They are matched at read time: an outflow whose
 * normalised description contains `pattern`, on `accountId` if set, within a
 * tolerance of `amountCents`. Several subscriptions can share a merchant (one
 * APPLE.COM/BILL line, several plans), which is why the amount is part of the key.
 * A bill that differs every cycle (electricity, a phone plan with usage) sets
 * `variableAmount`: it matches any amount, and `amountCents` is only the
 * estimate used until charges are seen.
 */
export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    pattern: text("pattern").notNull(),
    /** null = any account. */
    accountId: integer("account_id").references(() => accounts.id),
    /** The expected charge, positive. */
    amountCents: integer("amount_cents").notNull(),
    variableAmount: integer("variable_amount", { mode: "boolean" }).notNull().default(false),
    cadence: text("cadence").$type<SubscriptionCadence>().notNull().default("monthly"),
    status: text("status").$type<SubscriptionStatus>().notNull().default("active"),
    note: text("note"),
    createdAt: integer("created_at").notNull().default(now),
    cancelledAt: integer("cancelled_at"),
  },
  (t) => [index("subscriptions_status_idx").on(t.status)],
);

export type Subscription = typeof subscriptions.$inferSelect;

/* ------------------------------------------------------------ fx rates */

/**
 * The latest exchange rate per currency, for showing the whole app in one
 * currency. Display only: every amount is stored, and summed when the view is
 * "original", in its account's own currency, and no rate is ever written into
 * a transaction. One row per currency, as units of it per 1 SGD.
 */
export const fxRates = sqliteTable("fx_rates", {
  currency: text("currency").primaryKey(),
  perBase: real("per_base").notNull(),
  /** The date the rate was published, not when it was fetched. */
  asOf: text("as_of").notNull(),
  fetchedAt: integer("fetched_at").notNull().default(now),
});

/* -------------------------------------------------------------- holdings */

export const ASSET_CLASSES = ["stocks", "bonds", "funds", "gold", "crypto", "cash", "other"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

/**
 * An investment, entered by hand: no statement feeds these. `source` is where
 * it is held (a broker, a bank, a vault) and is free text, so a new platform
 * needs no code. `valueCents` is what it is worth as of `asOf`, in its own
 * currency, and is overwritten when the user updates it.
 */
export const holdings = sqliteTable(
  "holdings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    source: text("source").notNull(),
    assetClass: text("asset_class").$type<AssetClass>().notNull().default("other"),
    currency: text("currency").notNull().default("SGD"),
    /** Current market value, positive. */
    valueCents: integer("value_cents").notNull(),
    /** What was paid in, if known; null = not tracked. */
    costCents: integer("cost_cents"),
    asOf: text("as_of").notNull(), // ISO yyyy-mm-dd
    note: text("note"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [index("holdings_source_idx").on(t.source)],
);

export type Holding = typeof holdings.$inferSelect;
