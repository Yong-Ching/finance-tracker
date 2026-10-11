/**
 * Seeds accounts, categories and classification rules.
 *
 * Two modes, picked by whether ../data/labels.json exists:
 *
 * Fresh install (no labels.json): accounts, a starter set of categories and the
 * built-in transfer rules. Safe to re-run - it only adds what is missing and
 * never deletes. Payee rules are then added from the Transactions page.
 *
 * Legacy migration (labels.json present): rules are carried over verbatim from
 * the old Python tool, REPLACING all rules and overrides, with two deliberate
 * exceptions (see docs in import-legacy.ts):
 *   - the food_keywords and small_personal_max heuristics are NOT imported;
 *     they guess a category, which the brief forbids.
 *   - the YouTrip / Citibank payee rules become internal_transfer, not spending.
 */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { openDb, schema } from "../src/db/raw";
import { fromFloat } from "../src/lib/money";
import type { Bucket, TxnType } from "../src/db/schema";

const LEGACY = path.resolve(process.cwd(), "..", "data", "labels.json");

type LegacyKind = "income" | "spending" | "savings" | "internal";

/** Legacy 'kind' -> the new transaction type. */
const KIND_TO_TYPE: Record<LegacyKind, TxnType> = {
  income: "income",
  spending: "expense",
  savings: "savings",
  internal: "internal_transfer",
};

const TYPE_TO_BUCKET: Record<TxnType, Bucket> = {
  income: "income",
  expense: "expense",
  savings: "savings",
  debt_repayment: "expense",
  internal_transfer: "transfer",
};

/**
 * Categories that are pockets, not purchases. In the legacy data these were
 * kind=spending with seen=false, which counted them as spending AND left their
 * contents unitemised - the double-count this project exists to fix.
 */
const POCKET_CATEGORIES = new Set(["YouTrip top-up", "Citibank credit card"]);

const ACCOUNTS = [
  { name: "DBS", institution: "DBS Bank", kind: "bank" as const, isPocket: false, sortOrder: 1 },
  { name: "CPF", institution: "CPF Board", kind: "retirement" as const, isPocket: false, sortOrder: 2 },
  { name: "YouTrip", institution: "YouTrip", kind: "prepaid" as const, isPocket: true, sortOrder: 3 },
  { name: "Citibank", institution: "Citibank", kind: "credit_card" as const, isPocket: true, sortOrder: 4 },
];

/** Categories for a fresh install; personal ones are added from the app. */
const STARTER_CATEGORIES: Array<[string, Bucket]> = [
  ["Salary", "income"],
  ["Bank interest", "income"],
  ["Rent", "expense"],
  ["Food & groceries", "expense"],
  ["Transport", "expense"],
  ["Mobile", "expense"],
  ["Online shopping", "expense"],
  ["Personal care", "expense"],
  ["Income tax (IRAS)", "expense"],
  ["Investments", "savings"],
  ["YouTrip top-up", "transfer"],
  ["Citibank credit card", "transfer"],
];

/** Categories present in the legacy data that no rule creates. */
const EXTRA_CATEGORIES: Array<[string, Bucket]> = [
  ["Money in: other", "income"],
  ["Unidentified", "expense"],
  ["Electronics", "expense"],
  ["Merchandise", "expense"],
  ["Travel", "expense"],
  ["Uncategorized", "expense"],
  ["Insurance", "expense"],
  ["Entertainment", "expense"],
  ["Subscriptions", "expense"],
];

function main() {
  const { db, conn } = openDb();
  const labels = fs.existsSync(LEGACY) ? JSON.parse(fs.readFileSync(LEGACY, "utf8")) : null;
  console.log(labels ? `legacy migration from ${LEGACY}` : "fresh install (no legacy labels.json)");

  // --- accounts -----------------------------------------------------------
  for (const a of ACCOUNTS) {
    db.insert(schema.accounts).values({ ...a, currency: "SGD" }).onConflictDoNothing().run();
  }
  const accountByName = new Map(
    db.select().from(schema.accounts).all().map((a) => [a.name, a.id] as const),
  );

  // --- categories ---------------------------------------------------------
  const wanted = new Map<string, Bucket>();
  const remember = (cat: string, kind: LegacyKind) => {
    const bucket = POCKET_CATEGORIES.has(cat) ? "transfer" : TYPE_TO_BUCKET[KIND_TO_TYPE[kind]];
    wanted.set(cat, bucket);
  };
  if (labels) {
    for (const r of labels.rules) remember(r.cat, r.kind);
    for (const o of Object.values<any>(labels.one_offs)) remember(o.cat, o.kind);
    remember(labels.rent.cat, labels.rent.kind);
  } else {
    for (const [name, bucket] of STARTER_CATEGORIES) wanted.set(name, bucket);
  }
  for (const [name, bucket] of EXTRA_CATEGORIES) if (!wanted.has(name)) wanted.set(name, bucket);

  for (const [name, bucket] of wanted) {
    db.insert(schema.categories).values({ name, bucket }).onConflictDoNothing().run();
  }
  // A pocket category names the account it funds, so reconciliation knows
  // which statement holds the other side of the transfer.
  const POCKET_ACCOUNT: Record<string, string> = {
    "YouTrip top-up": "YouTrip",
    "Citibank credit card": "Citibank",
  };
  for (const [catName, accName] of Object.entries(POCKET_ACCOUNT)) {
    const accId = accountByName.get(accName);
    if (accId) {
      db.update(schema.categories)
        .set({ pocketAccountId: accId })
        .where(eq(schema.categories.name, catName))
        .run();
    }
  }

  const catByName = new Map(
    db.select().from(schema.categories).all().map((c) => [c.name, c.id] as const),
  );

  // --- rules --------------------------------------------------------------
  // A migration replaces every rule. A fresh install seeds the built-in rules
  // only into an empty table, so re-running never duplicates them or touches
  // rules added in the app.
  const seedRules = labels ? true : db.select().from(schema.rules).all().length === 0;
  if (labels) db.delete(schema.rules).run();
  let priority = 10;

  if (labels) {
    // Rent first: it is matched by amount + day-of-month because the payee name
    // changed in July, so it must beat any payee-name rule.
    db.insert(schema.rules)
      .values({
        pattern: `amount=${labels.rent.amount} day<=${labels.rent.day_max}`,
        matchType: "amountAndDay",
        categoryId: catByName.get(labels.rent.cat)!,
        txnType: KIND_TO_TYPE[labels.rent.kind as LegacyKind],
        amountCents: -Math.abs(fromFloat(labels.rent.amount)),
        dayMax: labels.rent.day_max,
        priority: priority++,
        accountId: accountByName.get("DBS")!,
        note: "Rent: payee name changed in July, so match on amount and timing.",
      })
      .run();

    for (const r of labels.rules) {
      const isPocket = POCKET_CATEGORIES.has(r.cat);
      db.insert(schema.rules)
        .values({
          pattern: r.match,
          matchType: "substring",
          categoryId: catByName.get(r.cat)!,
          // A pocket top-up is a transfer between the user's own accounts, never
          // spending in itself. Its contents arrive with the pocket's statement.
          txnType: isPocket ? "internal_transfer" : KIND_TO_TYPE[r.kind as LegacyKind],
          seen: r.seen ?? true,
          priority: priority++,
          note: r._note ?? null,
        })
        .run();
    }
  }

  // A payment arriving on the card is the other half of a DBS transfer, not
  // income. Scoped to the Citibank account so it cannot catch anything else.
  const citiId = accountByName.get("Citibank");
  if (seedRules && citiId) {
    // Its own category, with no pocketAccountId: this is the arriving half of a
    // transfer, never the departing half that funds a pocket. Shared by the
    // card bill payment and the wallet top-up.
    db.insert(schema.categories)
      .values({ name: "Transfer received", bucket: "transfer" })
      .onConflictDoNothing()
      .run();
    const received = db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.name, "Transfer received"))
      .get()!;
    db.insert(schema.rules)
      .values({
        pattern: "MONEYSEND",
        matchType: "substring",
        accountId: citiId,
        categoryId: received.id,
        txnType: "internal_transfer",
        seen: true,
        priority: 5,
        note: "Card bill payment received - the other half of a DBS transfer.",
      })
      .run();
  }

  // A YouTrip top-up is the arriving half of a DBS transfer, not income.
  const ytId = accountByName.get("YouTrip");
  const received2 = db
    .select()
    .from(schema.categories)
    .where(eq(schema.categories.name, "Transfer received"))
    .get();
  if (seedRules && ytId && received2) {
    db.insert(schema.rules)
      .values({
        pattern: "Top up",
        matchType: "substring",
        accountId: ytId,
        categoryId: received2.id,
        txnType: "internal_transfer",
        seen: true,
        priority: 5,
        note: "Wallet top-up received - the other half of a DBS transfer.",
      })
      .run();
  }

  // Insurance. Only one payee appears in the data so far; add others as they
  // show up rather than seeding rules that never match.
  const insuranceId = catByName.get("Insurance");
  if (seedRules && insuranceId) {
    db.insert(schema.rules)
      .values({
        pattern: "INCOME INSURANCE",
        matchType: "substring",
        categoryId: insuranceId,
        txnType: "expense",
        seen: true,
        priority: 6,
      })
      .run();
  }

  // Entertainment. Only one unambiguous payee appears so far; streaming and
  // cinema rules can be added when they show up rather than seeded blind.
  const entertainmentId = catByName.get("Entertainment");
  if (seedRules && entertainmentId) {
    db.insert(schema.rules)
      .values({
        pattern: "TICKETMASTER",
        matchType: "substring",
        categoryId: entertainmentId,
        txnType: "expense",
        seen: true,
        priority: 7,
      })
      .run();
  }

  // Recurring digital services. Kept apart from Online shopping so a small
  // automatic charge does not vanish among one-off purchases.
  const subsId = catByName.get("Subscriptions");
  if (seedRules && subsId) {
    db.insert(schema.rules)
      .values({
        pattern: "APPLE.COM/BILL",
        matchType: "substring",
        categoryId: subsId,
        txnType: "expense",
        seen: true,
        priority: 8,
        note: "iCloud storage; bills from Cork and attracts a conversion fee.",
      })
      .run();
  }

  // --- one-offs become overrides (migration only) ------------------------
  const oneOffs = labels
    ? Object.entries<any>(labels.one_offs).map(([key, v]) => {
        const [date, amount] = key.split("|");
        return { date, amount: Number(amount), ...v };
      })
    : [];
  if (labels) db.delete(schema.overrides).run();

  const counts = {
    accounts: accountByName.size,
    categories: catByName.size,
    rules: db.select().from(schema.rules).all().length,
    oneOffs: oneOffs.length,
  };
  // one-offs are resolved to dedupe hashes by import-legacy, which knows the
  // full description text; write them to a staging file it can read.
  if (labels) {
    fs.writeFileSync(
      path.join(process.cwd(), "data", "legacy-one-offs.json"),
      JSON.stringify(oneOffs, null, 2),
    );
  }

  conn.close();
  console.log("seeded:", counts);
}

main();
