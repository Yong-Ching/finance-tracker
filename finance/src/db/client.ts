import "server-only";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import path from "node:path";
import * as schema from "./schema";

const DB_PATH = process.env.FINANCE_DB ?? path.join(process.cwd(), "data", "sqlite.db");

// A test that reaches the real database can silently rewrite real financial
// records - this has happened. Fail loudly instead.
if ((process.env.VITEST || process.env.NODE_ENV === "test") && !process.env.FINANCE_DB) {
  throw new Error(
    "Refusing to open the real database from a test run. " +
      "Set FINANCE_DB to a temporary file (tests/setup.ts does this for every worker).",
  );
}

// Next dev recompiles modules on every edit; without this the process would
// accumulate open SQLite handles until it runs out of file descriptors.
const globalForDb = globalThis as unknown as { __financeDb?: Database.Database };

function open(): Database.Database {
  const conn = new Database(DB_PATH);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  return conn;
}

export const sqlite = globalForDb.__financeDb ?? open();
if (process.env.NODE_ENV !== "production") globalForDb.__financeDb = sqlite;

export const db = drizzle(sqlite, { schema });
export { schema };
