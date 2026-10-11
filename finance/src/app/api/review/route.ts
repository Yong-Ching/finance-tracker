import { NextResponse } from "next/server";
import { reviewBacklog } from "@/lib/actions";

export const runtime = "nodejs";
export const maxDuration = 600;

/** Reviews the backlog of uncategorized transactions. Local only. */
export async function POST(req: Request) {
  const { limit } = (await req.json().catch(() => ({}))) as { limit?: number };
  try {
    return NextResponse.json(await reviewBacklog(limit ?? 200));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
