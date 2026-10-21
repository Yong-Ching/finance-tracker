"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateTransaction } from "@/lib/actions";

const MAX = 500;

/**
 * A free-text remark on one transaction: who a transfer was for, what a vague
 * merchant sold. Saved as the transaction's note, which an override carries
 * through a statement re-import. Search matches it too.
 *
 * Enter or leaving the field saves; Escape cancels; saving it empty removes it.
 */
export function RemarkEditor({ id, note }: { id: number; note: string | null }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note ?? "");
  const [pending, start] = useTransition();
  const router = useRouter();
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  const save = () => {
    setEditing(false);
    const next = draft.trim();
    if (next === (note ?? "")) return;
    start(async () => {
      await updateTransaction(id, { note: next || null });
      router.refresh();
    });
  };

  if (editing) {
    return (
      <textarea
        ref={input}
        value={draft}
        maxLength={MAX}
        rows={Math.min(4, Math.max(1, Math.ceil(draft.length / 60)))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
          if (e.key === "Escape") { setDraft(note ?? ""); setEditing(false); }
        }}
        aria-label="Remark"
        placeholder="Add a remark"
        className="mt-1 block w-full select-text resize-none rounded bg-[var(--surface-2)] px-1.5 py-1 text-[12px] text-[var(--text-primary)] [caret-color:var(--brand-dot)]"
      />
    );
  }

  return note ? (
    <button
      type="button"
      onClick={() => { setDraft(note); setEditing(true); }}
      title="Edit remark"
      className={`mt-0.5 block text-left text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:underline ${pending ? "opacity-60" : ""}`}
    >
      {note}
    </button>
  ) : (
    // Out of the way until the row is hovered or the button is reached by keyboard.
    <button
      type="button"
      onClick={() => { setDraft(""); setEditing(true); }}
      className="mt-0.5 block text-[11px] text-[var(--text-muted)] opacity-0 hover:text-[var(--text-primary)] focus:opacity-100 group-hover:opacity-100"
    >
      + remark
    </button>
  );
}
