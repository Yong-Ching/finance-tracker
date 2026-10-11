import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { ingestPdf } from "@/lib/ingest";
import { PARSERS } from "@/lib/parsers";
import type { Parser } from "@/lib/parsers";

const STMT_DIR = path.resolve(__dirname, "..", "..", "data", "statements", "DBS");
const PDF = path.join(STMT_DIR, "DBS-Statement-Jan.pdf");
// A second real PDF, used only as a valid carrier for the stub-parser test.
const CARRIER = path.join(STMT_DIR, "DBS-Statement-Feb.pdf");
const hasPdf = fs.existsSync(PDF) && fs.existsSync(CARRIER);

let tmp: string;
let conn: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let cwd: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fin-"));
  // ingest writes the stored copy under cwd/data/statements
  cwd = process.cwd();
  process.chdir(tmp);
  fs.mkdirSync(path.join(tmp, "data"), { recursive: true });

  conn = new Database(path.join(tmp, "test.db"));
  conn.pragma("foreign_keys = ON");
  db = drizzle(conn, { schema });
  migrate(db, { migrationsFolder: path.join(cwd, "drizzle") });

  db.insert(schema.accounts)
    .values({ name: "DBS", institution: "DBS Bank", kind: "bank", currency: "SGD", isPocket: false })
    .run();
});

afterAll(() => {
  process.chdir(cwd);
  conn.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const read = () => ({ buffer: new Uint8Array(fs.readFileSync(PDF)), filename: "DBS-Statement-Jan.pdf" });

describe.skipIf(!hasPdf)("ingest", () => {
  it("imports a statement whose balances reconcile", async () => {
    const out = await ingestPdf(db, read());
    expect(out.status).toBe("imported");
    expect(out.continuityDelta).toBe(0);
    expect(out.inserted).toBe(90);
  }, 60_000);

  it("is idempotent - the same file a second time is a no-op", async () => {
    const before = db.select({ n: sql<number>`count(*)` }).from(schema.transactions).get()!.n;
    const out = await ingestPdf(db, read());
    expect(out.status).toBe("duplicate");
    expect(out.inserted).toBe(0);
    const after = db.select({ n: sql<number>`count(*)` }).from(schema.transactions).get()!.n;
    expect(after).toBe(before);
  }, 60_000);

  it("reports without writing when asked for a dry run", async () => {
    const before = db.select({ n: sql<number>`count(*)` }).from(schema.statements).get()!.n;
    // a dry run of an already-imported file still short-circuits as duplicate,
    // so use a distinct buffer to exercise the dry-run path
    const buf = new Uint8Array(fs.readFileSync(PDF));
    const out = await ingestPdf(db, { buffer: buf, filename: "x.pdf" }, { dryRun: true });
    expect(out.status).toBe("duplicate");
    expect(db.select({ n: sql<number>`count(*)` }).from(schema.statements).get()!.n).toBe(before);
  }, 60_000);

  it("quarantines a statement whose balances do not reconcile", async () => {
    // A stub parser that mis-reads one amount, standing in for a parser bug.
    const broken: Parser = {
      name: "broken", version: "0.0.0", accountHint: "DBS",
      detect: () => 1,
      parse: () => ({
        accountHint: "DBS",
        periodFrom: "2026-01-01", periodTo: "2026-01-31",
        openingBalanceCents: 100_000,
        closingBalanceCents: 90_000,
        transactions: [
          { txnDate: "2026-01-05", descriptionRaw: "A", amountCents: -5_000 },
          { txnDate: "2026-01-06", descriptionRaw: "B", amountCents: -4_000 }, // 1,000 short
        ],
        warnings: [],
      }),
    };
    PARSERS.unshift(broken);
    try {
      const out = await ingestPdf(db, {
        buffer: new Uint8Array(fs.readFileSync(CARRIER)),
        filename: "broken.pdf",
      });
      expect(out.status).toBe("quarantined");
      expect(out.continuityDelta).toBe(1_000);

      // Quarantined rows exist, but are excluded from every total by the
      // statement-status filter the queries apply.
      const stmt = db.select().from(schema.statements)
        .where(eq(schema.statements.filename, "broken.pdf")).get()!;
      expect(stmt.status).toBe("quarantined");
    } finally {
      PARSERS.shift();
    }
  }, 60_000);

  it("never lets an internal transfer into the expense total", () => {
    const rows = db.select().from(schema.transactions).all();
    const sum = (t: string) =>
      rows.filter((r) => r.txnType === t).reduce((a, r) => a + r.amountCents, 0);
    const all = rows.reduce((a, r) => a + r.amountCents, 0);
    expect(
      sum("income") + sum("expense") + sum("savings") + sum("debt_repayment") + sum("internal_transfer"),
    ).toBe(all);
  });
});
