import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { dedupeHash } from "@/lib/dedupe";

let tmp: string;
let dbFile: string;
let conn: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let actions: typeof import("@/lib/actions");
let ids: number[] = [];

beforeAll(async () => {
  // tests/setup.ts has already pointed FINANCE_DB at a throwaway file, before
  // any module resolved it. Use that same file - do not reassign it here.
  dbFile = process.env.FINANCE_DB!;
  tmp = path.dirname(dbFile);

  conn = new Database(dbFile);
  db = drizzle(conn, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });

  const acc = db.insert(schema.accounts)
    .values({ name: "DBS", institution: "DBS", kind: "bank", currency: "SGD", isPocket: false })
    .returning({ id: schema.accounts.id }).get();
  const cat = db.insert(schema.categories)
    .values({ name: "Food & groceries", bucket: "expense" })
    .returning({ id: schema.categories.id }).get();

  for (let i = 0; i < 5; i++) {
    const row = {
      accountId: acc.id,
      txnDate: `2026-07-0${i + 1}`,
      amountCents: -(i + 1) * 100,
      descriptionRaw: `HAWKER STALL ${i}`,
    };
    const r = db.insert(schema.transactions)
      .values({ ...row, txnType: "expense", dedupeHash: dedupeHash(row), isReviewed: false })
      .returning({ id: schema.transactions.id }).get();
    ids.push(r.id);
  }
  (globalThis as Record<string, unknown>).__testCategoryId = cat.id;

  actions = await import("@/lib/actions");
});

afterAll(() => {
  conn.close();
});

describe("bulk category edits", () => {
  const catId = () => (globalThis as Record<string, unknown>).__testCategoryId as number;

  it("applies to every selected id and marks them reviewed", async () => {
    const n = await actions.bulkSetCategory(ids.slice(0, 3), catId());
    expect(n).toBe(3);

    const rows = db.select().from(schema.transactions).all();
    const changed = rows.filter((r) => r.categoryId === catId());
    expect(changed).toHaveLength(3);
    expect(changed.every((r) => r.isReviewed)).toBe(true);
    // untouched rows stay in the review queue
    expect(rows.filter((r) => !r.isReviewed)).toHaveLength(2);
  });

  it("records an override per row, so the edit survives a re-import", () => {
    const overrides = db.select().from(schema.overrides).all();
    expect(overrides).toHaveLength(3);
    expect(overrides.every((o) => o.categoryId === catId())).toBe(true);

    const hashes = new Set(
      db.select().from(schema.transactions).all()
        .filter((t) => t.categoryId === catId())
        .map((t) => t.dedupeHash),
    );
    expect(new Set(overrides.map((o) => o.dedupeHash))).toEqual(hashes);
  });

  it("applies to everything matching a filter, not just one page", async () => {
    const n = await actions.bulkSetCategoryForFilter({ reviewOnly: true }, catId());
    expect(n).toBe(2); // the two still unreviewed
    expect(db.select().from(schema.transactions).all().every((r) => r.isReviewed)).toBe(true);
  });

  it("is a no-op on an empty selection", async () => {
    expect(await actions.bulkSetCategory([], catId())).toBe(0);
  });

  it("rejects a malformed filter rather than updating everything", async () => {
    await expect(actions.bulkSetCategoryForFilter({ txnType: "nonsense" }, catId())).rejects.toThrow();
  });
});
