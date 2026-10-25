import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/db/client";
import { ingestPdf, type NewAccount } from "@/lib/ingest";
import { runReconcile } from "@/lib/reconcile";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  const accountId = form.get("accountId");
  // A new account for a statement no account matches: {"name","kind","currency"}.
  const newAccountField = form.get("newAccount");
  let newAccount: NewAccount | undefined;
  if (typeof newAccountField === "string" && newAccountField) {
    try {
      newAccount = JSON.parse(newAccountField);
    } catch {
      return NextResponse.json({ error: "newAccount is not valid JSON." }, { status: 400 });
    }
  }
  const dryRun = form.get("dryRun") === "true";
  const review = form.get("review") !== "false";

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file supplied." }, { status: 400 });
  }
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json({ error: "Only PDF statements are supported." }, { status: 400 });
  }

  try {
    const outcome = await ingestPdf(
      db,
      { buffer: new Uint8Array(await file.arrayBuffer()), filename: file.name },
      { accountId: accountId ? Number(accountId) : undefined, newAccount, dryRun, review },
    );
    if (!dryRun && outcome.status === "imported") {
      // A new statement may be the other side of a transfer already on file.
      runReconcile();
    }
    if (!dryRun && (outcome.status === "imported" || outcome.status === "quarantined")) {
      for (const p of ["/", "/transactions", "/reconcile", "/accounts"]) revalidatePath(p);
    }
    return NextResponse.json(outcome);
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
