/**
 * Connection for scripts and tests that run outside Next (no "server-only").
 * The app itself must import from ./client.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import path from "node:path";
import * as schema from "./schema";
import { DATA_DIR } from "../lib/paths";

export function openDb(dbPath?: string) {
  const file = dbPath ?? process.env.FINANCE_DB ?? path.join(DATA_DIR, "sqlite.db");
  const conn = new Database(file);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  return { conn, db: drizzle(conn, { schema }) };
}

export { schema };
