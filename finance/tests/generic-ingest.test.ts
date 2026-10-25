import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { makePdf, type Text } from "./fixtures/make-pdf";

/**
 * A statement in a layout no bank parser knows, end to end: the generic reader
 * takes it, the user names its account, and only a read that reconciles is
 * written. Synthetic throughout.
 */
const row = (y: number, cells: Array<[string, number]>): Text[] => cells.map(([text, x]) => ({ text, x, y }));
const statement = (closing: string, title = "ACME SAVINGS BANK") => makePdf([[
  ...row(800, [[title, 40]]),
  ...row(760, [["Txn Date", 40], ["Particulars", 120], ["Debit", 350], ["Credit", 430], ["Balance", 510]]),
  ...row(740, [["Opening Balance", 120], ["1,000.00", 505]]),
  ...row(720, [["03 Jan 2000", 40], ["ACME CAFE", 120], ["12.50", 352], ["987.50", 510]]),
  ...row(700, [["05 Jan 2000", 40], ["ACME PAYROLL", 120], ["2,000.00", 425], ["2,987.50", 505]]),
  ...row(680, [["Closing Balance", 120], [closing, 505]]),
]]);

let tmp: string;
let conn: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let ingestPdf: typeof import("@/lib/ingest").ingestPdf;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fin-generic-"));
  // Stored copies go under the data folder, resolved when ingest loads.
  process.env.FINANCE_DATA_DIR = path.join(tmp, "data");
  ({ ingestPdf } = await import("@/lib/ingest"));
  conn = new Database(path.join(tmp, "test.db"));
  conn.pragma("foreign_keys = ON");
  db = drizzle(conn, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  db.insert(schema.accounts).values({ name: "Main", institution: "Main", kind: "bank", currency: "SGD" }).run();
});

afterAll(() => {
  conn.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.FINANCE_DATA_DIR;
});

const file = (closing = "2,987.50") => ({ buffer: statement(closing), filename: "acme.pdf" });

describe("a statement no parser knows", () => {
  it("is read generically and asks whose it is", async () => {
    const out = await ingestPdf(db, file(), { dryRun: true });
    expect(out.status).toBe("needs_account");
    expect(out.importable).toBe(true);
    expect(out.parser).toMatch(/^generic/);
    expect(out.accounts?.map((a) => a.name)).toEqual(["Main"]);
    expect(out.preview?.rows.map((r) => r.amountCents)).toEqual([-1250, 200000]);
  });

  it("is not written without an account", async () => {
    const out = await ingestPdf(db, file());
    expect(out.status).toBe("unrecognised");
    expect(db.select().from(schema.statements).all()).toHaveLength(0);
  });

  it("is not written when its balances do not reconcile", async () => {
    const out = await ingestPdf(db, file("2,900.00"), { newAccount: { name: "ACME", kind: "bank", currency: "SGD" } });
    expect(out.importable).toBe(false);
    expect(db.select().from(schema.accounts).all()).toHaveLength(1);
    expect(db.select().from(schema.statements).all()).toHaveLength(0);
  });

  it("creates the new account with the statement when it reconciles", async () => {
    const preview = await ingestPdf(db, file(), { dryRun: true, newAccount: { name: "ACME", kind: "bank", currency: "MYR" } });
    expect(preview.status).toBe("imported");
    expect(db.select().from(schema.accounts).all()).toHaveLength(1); // a preview creates nothing

    const out = await ingestPdf(db, file(), { newAccount: { name: "ACME", kind: "bank", currency: "MYR" } });
    expect(out.status).toBe("imported");
    expect(out.inserted).toBe(2);
    const acct = db.select().from(schema.accounts).where(eq(schema.accounts.name, "ACME")).get()!;
    expect(acct.currency).toBe("MYR");
    const stmt = db.select().from(schema.statements).get()!;
    expect(stmt.parserName).toBe("generic");
    expect(stmt.accountId).toBe(acct.id);
  });

  it("refuses a second account with the same name", async () => {
    const out = await ingestPdf(db, { buffer: statement("2,987.50", "ACME SAVINGS BANK II"), filename: "b.pdf" }, {
      dryRun: true, newAccount: { name: "ACME", kind: "bank", currency: "SGD" },
    });
    expect(out.status).toBe("needs_account");
    expect(out.message).toMatch(/already exists/);
  });
});
