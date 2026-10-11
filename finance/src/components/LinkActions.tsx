"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { setLinkStatus, confirmAllProposed, reconcileNow } from "@/lib/actions";

export function LinkButtons({ id }: { id: number }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const act = (status: "confirmed" | "rejected") =>
    start(async () => { await setLinkStatus(id, status); router.refresh(); });

  return (
    <span className="flex gap-2">
      <button
        disabled={pending} onClick={() => act("confirmed")}
        className="rounded border border-[var(--border-strong)] px-2 py-0.5 text-[12px] hover:bg-[var(--surface-2)] disabled:opacity-50"
      >
        Confirm
      </button>
      <button
        disabled={pending} onClick={() => act("rejected")}
        className="rounded px-2 py-0.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-50"
      >
        Reject
      </button>
    </span>
  );
}

export function ReconcileBar({ proposed }: { proposed: number }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <div className="flex gap-2">
      <button
        disabled={pending}
        onClick={() => start(async () => { await reconcileNow(); router.refresh(); })}
        className="rounded border border-[var(--border-strong)] px-3 py-1 text-[13px] hover:bg-[var(--surface-2)] disabled:opacity-50"
      >
        {pending ? "Matching..." : "Run matcher"}
      </button>
      {proposed > 0 && (
        <button
          disabled={pending}
          onClick={() => start(async () => { await confirmAllProposed(); router.refresh(); })}
          className="rounded bg-[var(--text-primary)] px-3 py-1 text-[13px] font-medium text-[var(--surface-1)] disabled:opacity-50"
        >
          Confirm all {proposed}
        </button>
      )}
    </div>
  );
}
