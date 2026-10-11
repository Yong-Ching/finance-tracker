import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { runReconcile } from "@/lib/reconcile";

export const runtime = "nodejs";

/** Matches transfers out of DBS to the pocket credits they became. */
export async function POST() {
  try {
    const proposed = runReconcile();
    for (const p of ["/", "/reconcile", "/transactions"]) revalidatePath(p);
    return NextResponse.json({ proposed });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
