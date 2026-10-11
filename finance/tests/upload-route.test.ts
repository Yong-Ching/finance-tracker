import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Exercises the upload endpoint in the running app.
 *
 * The unit tests call the parser directly, which cannot catch a bundling
 * problem: pdfjs-dist resolves its worker from a sibling file at runtime, and
 * once Next bundled it into a server chunk every upload failed with "Setting up
 * fake worker failed" while every unit test still passed. Only a request
 * through the real server catches that class of failure.
 *
 * Skips when the app is not running, so `npm test` stays standalone.
 */
const BASE = process.env.FINANCE_URL ?? "http://127.0.0.1:3000";
const SRC = path.resolve(__dirname, "..", "..", "data", "statements", "DBS", "DBS-Statement-Jan.pdf");

// Resolved before the suite is defined, so an unreachable app SKIPS the tests
// rather than passing them. A guard that quietly returns is indistinguishable
// from a real pass, which is how a broken upload path stayed green once already.
const up = await fetch(BASE, { signal: AbortSignal.timeout(3000) })
  .then((r) => r.ok)
  .catch(() => false);

if (!up) console.warn(`[upload-route] app not reachable at ${BASE} - suite skipped`);

// A trailing comment changes the file hash without changing the document, so
// the request reaches the parser instead of short-circuiting as a duplicate.
let probe = "";
if (up && fs.existsSync(SRC)) {
  probe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "upl-")), "probe.pdf");
  fs.writeFileSync(probe, Buffer.concat([fs.readFileSync(SRC), Buffer.from("\n% upload path test\n")]));
}

describe.skipIf(!up || !fs.existsSync(SRC))("upload route", () => {
  it("parses a real PDF through the server, worker and all", async () => {
    const form = new FormData();
    form.append("file", new Blob([fs.readFileSync(probe)], { type: "application/pdf" }), "probe.pdf");
    form.append("dryRun", "true");
    form.append("review", "false"); // no billed call from the test suite

    const res = await fetch(`${BASE}/api/upload`, { method: "POST", body: form });
    const body = await res.json();

    expect(body.error, `upload failed: ${body.error}`).toBeUndefined();
    expect(body.parser).toMatch(/^dbs@/);
    expect(body.accountName).toBe("DBS");
    expect(body.continuityDelta).toBe(0);
    expect(body.periodFrom).toBe("2026-01-05");
    // Every row is already held, so the database gate leaves nothing to import.
    expect(body.skippedExisting).toBe(90);
    expect(body.inserted).toBe(0);
  }, 120_000);

  it("rejects a non-PDF without reaching the parser", async () => {
    const form = new FormData();
    form.append("file", new Blob(["not a pdf"], { type: "text/plain" }), "notes.txt");
    form.append("dryRun", "true");
    const res = await fetch(`${BASE}/api/upload`, { method: "POST", body: form });
    expect(res.status).toBe(400);
  }, 30_000);
});
