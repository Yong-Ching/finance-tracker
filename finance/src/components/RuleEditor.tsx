"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createRule, deleteRule, updateRule, applyRule, previewPattern } from "@/lib/actions";
import type { TxnType } from "@/db/schema";

interface Category { id: number; name: string }
interface Account { id: number; name: string }

const TYPES: TxnType[] = ["expense", "income", "savings", "debt_repayment", "internal_transfer"];

export function NewRuleForm({
  categories, accounts, nextPriority,
}: {
  categories: Category[]; accounts: Account[]; nextPriority: number;
}) {
  const [pattern, setPattern] = useState("");
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [txnType, setTxnType] = useState<TxnType>("expense");
  const [accountId, setAccountId] = useState<number | "">("");
  const [matches, setMatches] = useState<number | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  // Show what the pattern would catch before it is saved.
  useEffect(() => {
    if (!pattern.trim()) { setMatches(null); return; }
    const t = setTimeout(async () => {
      setMatches(await previewPattern(pattern, accountId === "" ? null : accountId));
    }, 250);
    return () => clearTimeout(t);
  }, [pattern, accountId]);

  const submit = (backfill: boolean) =>
    start(async () => {
      if (!pattern.trim() || categoryId === "") return;
      await createRule(
        {
          pattern: pattern.trim(),
          matchType: "substring",
          categoryId: Number(categoryId),
          txnType,
          seen: true,
          accountId: accountId === "" ? null : Number(accountId),
          priority: nextPriority,
        },
        backfill,
      );
      setPattern(""); setCategoryId(""); setMatches(null);
      router.refresh();
    });

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
        Description contains
        <input
          value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="e.g. NTUC FP"
          className="w-52 rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-[13px] normal-case tracking-normal text-[var(--text-primary)]"
        />
      </label>
      <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
        Category
        <select
          value={categoryId} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : "")}
          className="rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-[13px] normal-case tracking-normal text-[var(--text-primary)]"
        >
          <option value="">Choose...</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
        Type
        <select
          value={txnType} onChange={(e) => setTxnType(e.target.value as TxnType)}
          className="rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-[13px] normal-case tracking-normal text-[var(--text-primary)]"
        >
          {TYPES.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
        Account
        <select
          value={accountId} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : "")}
          className="rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-[13px] normal-case tracking-normal text-[var(--text-primary)]"
        >
          <option value="">Any</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </label>

      {matches !== null && (
        <span className="pb-1.5 text-[12px] text-[var(--text-secondary)]">
          matches <span className="tnum font-medium">{matches}</span> existing
        </span>
      )}

      <button
        disabled={pending || !pattern.trim() || categoryId === ""}
        onClick={() => submit(true)}
        className="rounded bg-[var(--text-primary)] px-3 py-1.5 text-[13px] font-medium text-[var(--surface-1)] disabled:opacity-40"
      >
        Add and backfill
      </button>
      <button
        disabled={pending || !pattern.trim() || categoryId === ""}
        onClick={() => submit(false)}
        className="rounded border border-[var(--border-strong)] px-3 py-1.5 text-[13px] disabled:opacity-40"
      >
        Add only
      </button>
    </div>
  );
}

export function RuleRowActions({ id, active }: { id: number; active: boolean }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const run = (fn: () => Promise<unknown>) =>
    start(async () => { await fn(); router.refresh(); });

  return (
    <span className="flex justify-end gap-2 text-[12px]">
      <button
        disabled={pending} onClick={() => run(() => applyRule(id))}
        className="rounded border border-[var(--border)] px-2 py-0.5 hover:bg-[var(--surface-2)] disabled:opacity-50"
        title="Apply this rule to existing transactions"
      >
        Backfill
      </button>
      <button
        disabled={pending} onClick={() => run(() => updateRule(id, { active: !active }))}
        className="rounded px-2 py-0.5 text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-50"
      >
        {active ? "Disable" : "Enable"}
      </button>
      <button
        disabled={pending} onClick={() => run(() => deleteRule(id))}
        className="rounded px-2 py-0.5 text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-50"
      >
        Delete
      </button>
    </span>
  );
}
