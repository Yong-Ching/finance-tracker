"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acceptSuggestion, rejectSuggestion, acceptAllSuggestions, reviewBacklog } from "@/lib/actions";

export function SuggestionButtons({ id, acceptLabel = "Accept" }: { id: number; acceptLabel?: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const run = (fn: () => Promise<unknown>) => start(async () => { await fn(); router.refresh(); });

  return (
    <span className="flex shrink-0 gap-2">
      <button
        disabled={pending} onClick={() => run(() => acceptSuggestion(id))}
        className="rounded border border-[var(--border-strong)] px-2 py-0.5 text-[12px] hover:bg-[var(--surface-2)] disabled:opacity-50"
      >
        {acceptLabel}
      </button>
      <button
        disabled={pending} onClick={() => run(() => rejectSuggestion(id))}
        className="rounded px-2 py-0.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-50"
      >
        Dismiss
      </button>
    </span>
  );
}

export function AcceptAll({ kind, count }: { kind: "category" | "rule"; count: number }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  if (!count) return null;
  return (
    <button
      disabled={pending}
      onClick={() => start(async () => { await acceptAllSuggestions(kind, 0.8); router.refresh(); })}
      className="rounded border border-[var(--border-strong)] px-2.5 py-1 text-[12px] hover:bg-[var(--surface-2)] disabled:opacity-50"
      title="Applies only those the model was at least 80% confident about"
    >
      {pending ? "Applying..." : `Accept ${count} high-confidence`}
    </button>
  );
}

export function RunBacklogReview({ pendingCount }: { pendingCount: number }) {
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  if (!pendingCount) return null;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        disabled={busy}
        onClick={() =>
          start(async () => {
            setMsg(null);
            const r = await reviewBacklog(200);
            setMsg(
              r.errors.length
                ? r.errors.join("; ")
                : r.sent === 0
                  ? "Nothing left to review."
                  : `Reviewed ${r.sent} transactions.`,
            );
            router.refresh();
          })
        }
        className="rounded bg-[var(--text-primary)] px-3 py-1.5 text-[13px] font-medium text-[var(--surface-1)] disabled:opacity-50"
      >
        {busy ? "Reviewing… this takes a minute" : `Review ${pendingCount} uncategorized`}
      </button>
      {msg && <span className="text-[12px] text-[var(--text-secondary)]">{msg}</span>}
    </div>
  );
}
