import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";

export const runtime = "nodejs";

/**
 * The original PDF of an imported statement, so a charge can be traced to the
 * bill it was read from. Served inline for the browser's PDF viewer.
 *
 * The path comes from the database, never the request, and must resolve inside
 * data/statements - this route can serve a statement and nothing else.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return new Response("Bad statement id", { status: 400 });

  const st = db
    .select({ storedPath: s.statements.storedPath, filename: s.statements.filename })
    .from(s.statements)
    .where(eq(s.statements.id, id))
    .get();
  if (!st?.storedPath) return new Response("No stored file for this statement", { status: 404 });

  const root = path.resolve(process.cwd(), "data", "statements");
  const file = path.resolve(process.cwd(), st.storedPath);
  if (!file.startsWith(root + path.sep)) return new Response("Not a statement file", { status: 403 });
  if (!fs.existsSync(file)) return new Response("Statement file is missing", { status: 404 });

  const name = st.filename.replace(/[^\w.-]+/g, "_");
  return new Response(new Uint8Array(fs.readFileSync(file)), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${name}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
