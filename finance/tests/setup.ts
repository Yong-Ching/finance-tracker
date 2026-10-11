/**
 * Every test worker gets its own throwaway database.
 *
 * This runs before any test module is imported, which matters: src/db/client.ts
 * resolves its path at module load, so a test that sets FINANCE_DB in beforeAll
 * is already too late - the client will have opened the real database and any
 * write will land on the user's actual financial records.
 */
import { afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), `finance-test-${process.pid}-`));
process.env.FINANCE_DB = path.join(dir, "test.db");

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
