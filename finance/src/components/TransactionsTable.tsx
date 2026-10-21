"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/money";
import { converting, moneyInColumn, originalTitle, type Fx } from "@/lib/fx";
import {
  updateTransaction,
  bulkSetCategory,
  bulkSetCategoryForFilter,
  acceptSuggestion,
  rejectSuggestion,
} from "@/lib/actions";
import type { TxnRow } from "@/lib/queries";
import { RemarkEditor } from "@/components/RemarkEditor";
import type { TxnType } from "@/db/schema";

const TYPES: TxnType[] = ["expense", "income", "savings", "debt_repayment", "internal_transfer"];
const TYPE_LABEL: Record<string, string> = {
  expense: "Expense",
  income: "Income",
  savings: "Savings",
  debt_repayment: "Debt repayment",
  internal_transfer: "Internal transfer",
};

interface Category { id: number; name: string; bucket: string }

export interface RowSuggestion {
  id: number;
  label: string;
  confidence: number;
  reasoning: string | null;
}

export interface RowFlag {
  id: number;
  flagType: string;
  reasoning: string | null;
}

/** Clicking these must edit, never toggle the row's selection. */
const INTERACTIVE = "select, button, a, input, textarea, label, option";

export function TransactionsTable({
  rows, categories, suggestions = {}, flags = {}, total = rows.length, filters, fx,
}: {
  rows: TxnRow[];
  /** The currency view: amounts are converted for show, never changed. */
  fx?: Fx;
  categories: Category[];
  suggestions?: Record<number, RowSuggestion>;
  flags?: Record<number, RowFlag[]>;
  /** Rows matching the current filters, across all pages. */
  total?: number;
  /** The active filters, so a selection can extend beyond this page. */
  filters?: Record<string, unknown>;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  /** True when the action should apply to every matching row, not just this page. */
  const [allMatching, setAllMatching] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const lastIndex = useRef<number | null>(null);
  const headerBox = useRef<HTMLInputElement>(null);

  const pageIds = rows.map((r) => r.id);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someOnPageSelected = pageIds.some((id) => selected.has(id));
  const effectiveCount = allMatching ? total : selected.size;

  // Indeterminate is a DOM property; React cannot set it as an attribute.
  useEffect(() => {
    if (headerBox.current) {
      headerBox.current.indeterminate = someOnPageSelected && !allOnPageSelected;
    }
  }, [someOnPageSelected, allOnPageSelected]);

  /** Changing the selection by hand always narrows it back to real rows. */
  const dropAllMatching = () => setAllMatching(false);

  const setRange = (from: number, to: number, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      for (let i = lo; i <= hi; i++) on ? next.add(rows[i].id) : next.delete(rows[i].id);
      return next;
    });

  /** Shift extends from the last row touched, the way a file list behaves. */
  const toggle = (index: number, shiftKey: boolean) => {
    dropAllMatching();
    const id = rows[index].id;
    if (shiftKey && lastIndex.current !== null) {
      setRange(lastIndex.current, index, !selected.has(id));
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    }
    lastIndex.current = index;
  };

  const toggleAllOnPage = () => {
    dropAllMatching();
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) for (const id of pageIds) next.delete(id);
      else for (const id of pageIds) next.add(id);
      return next;
    });
    lastIndex.current = null;
  };

  const clear = () => {
    setSelected(new Set());
    setAllMatching(false);
    lastIndex.current = null;
  };

  const patch = (id: number, p: Parameters<typeof updateTransaction>[1]) =>
    start(async () => {
      await updateTransaction(id, p);
      router.refresh();
    });

  const BULK_CONFIRM_THRESHOLD = 25;

  const bulk = (categoryId: number) => {
    // One click that recategorises hundreds of rows deserves a second look.
    if (effectiveCount > BULK_CONFIRM_THRESHOLD) {
      const name = categories.find((c) => c.id === categoryId)?.name ?? "this category";
      const ok = window.confirm(
        `Set ${effectiveCount} transactions to "${name}"?\n\n` +
          `This replaces whatever category they have now. You can change them back afterwards.`,
      );
      if (!ok) return;
    }
    start(async () => {
      if (allMatching && filters) await bulkSetCategoryForFilter(filters, categoryId);
      else await bulkSetCategory([...selected], categoryId);
      clear();
      router.refresh();
    });
  };

  const morePages = total > rows.length;

  return (
    <>
      {effectiveCount > 0 && (
        <div className="sticky top-[45px] z-30 mb-2 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-2 text-[13px]">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-medium">
              {effectiveCount} selected
              {allMatching && " (all matching these filters)"}
            </span>
            <label className="flex items-center gap-2">
              Set category
              <select
                value=""
                disabled={pending}
                onChange={(e) => e.target.value && bulk(Number(e.target.value))}
                className="rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1"
              >
                <option value="" disabled>Choose...</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            {pending && <span className="text-[var(--text-muted)]">Applying...</span>}
            <button onClick={clear} className="ml-auto text-[var(--text-secondary)] hover:underline">
              Clear
            </button>
          </div>

          {/* Selecting a whole page is rarely the whole job when the queue spans pages. */}
          {allOnPageSelected && morePages && (
            <div className="mt-1.5 border-t border-[var(--border)] pt-1.5 text-[12px] text-[var(--text-secondary)]">
              {allMatching ? (
                <>
                  All <strong className="font-semibold">{total}</strong> matching transactions are selected.{" "}
                  <button onClick={() => setAllMatching(false)} className="underline">
                    Select only this page
                  </button>
                </>
              ) : (
                <>
                  All {rows.length} on this page are selected.{" "}
                  <button onClick={() => setAllMatching(true)} className="underline">
                    Select all {total} matching these filters
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[900px] text-[13px]">
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              <th className="w-10 py-2 pl-3 pr-1">
                <input
                  ref={headerBox}
                  type="checkbox"
                  checked={allOnPageSelected}
                  onChange={toggleAllOnPage}
                  className="cursor-pointer"
                  aria-label={allOnPageSelected ? "Deselect all on this page" : "Select all on this page"}
                  title={allOnPageSelected ? "Deselect all on this page" : "Select all on this page"}
                />
              </th>
              <th className="px-2 py-2 font-medium">Date</th>
              <th className="px-2 py-2 font-medium">Account</th>
              <th className="px-2 py-2 font-medium">Description</th>
              <th className="px-2 py-2 text-right font-medium">Amount{converting(fx) ? ` (${fx.mode})` : ""}</th>
              <th className="px-2 py-2 font-medium">Category</th>
              <th className="px-2 py-2 font-medium">Type</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const isSelected = allMatching || selected.has(r.id);
              return (
                <tr
                  key={r.id}
                  // The whole row is a hit target; the editors inside it are not.
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
                    toggle(i, e.shiftKey);
                  }}
                  className={`group cursor-pointer border-b border-[var(--border)] last:border-0 select-none ${
                    isSelected
                      ? "bg-[color-mix(in_srgb,var(--text-primary)_9%,transparent)]"
                      : !r.isReviewed
                        ? "bg-[color-mix(in_srgb,var(--status-warning)_7%,transparent)] hover:bg-[var(--surface-2)]"
                        : "hover:bg-[var(--surface-2)]"
                  }`}
                >
                  {/* Padding here is the real hit area - the box itself is small. */}
                  <td className="py-1.5 pl-3 pr-1">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => {}}
                      onClick={(e) => { e.stopPropagation(); toggle(i, e.shiftKey); }}
                      className="cursor-pointer"
                      aria-label={`Select transaction on ${r.txnDate} for ${formatCents(r.amountCents)}`}
                    />
                  </td>
                  <td className="tnum whitespace-nowrap px-2 py-1.5 text-[var(--text-secondary)]">{r.txnDate}</td>
                  <td className="px-2 py-1.5 text-[var(--text-secondary)]">{r.accountName}</td>
                  <td className="max-w-[420px] px-2 py-1.5">
                    <span className="line-clamp-2" title={r.descriptionRaw}>{r.descriptionRaw}</span>
                    {/* Keyed on the note so a saved remark resets the editor's draft. */}
                    <RemarkEditor key={r.note ?? ""} id={r.id} note={r.note} />
                    {flags[r.id]?.map((f) => (
                      <span
                        key={f.id}
                        title={f.reasoning ?? undefined}
                        className="mt-1 mr-1 inline-block rounded border border-[var(--status-warning)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--status-warning)]"
                      >
                        {f.flagType}
                      </span>
                    ))}
                  </td>
                  <td
                    className={`tnum whitespace-nowrap px-2 py-1.5 text-right ${r.amountCents < 0 ? "" : "font-medium"}`}
                    title={originalTitle(r.amountCents, r.currency, fx)}
                  >
                    {moneyInColumn(r.amountCents, r.currency, fx)}
                  </td>
                  <td className="px-2 py-1.5">
                    {!r.categoryId && suggestions[r.id] && (
                      <div className="mb-1 flex items-center gap-1.5">
                        <span
                          title={suggestions[r.id].reasoning ?? undefined}
                          className="truncate text-[11px] text-[var(--text-secondary)]"
                        >
                          Claude: {suggestions[r.id].label}{" "}
                          <span className="tnum text-[var(--text-muted)]">
                            {Math.round(suggestions[r.id].confidence * 100)}%
                          </span>
                        </span>
                        <button
                          disabled={pending}
                          onClick={() =>
                            start(async () => { await acceptSuggestion(suggestions[r.id].id); router.refresh(); })
                          }
                          className="shrink-0 rounded border border-[var(--border-strong)] px-1.5 py-0.5 text-[11px] hover:bg-[var(--surface-2)] disabled:opacity-50"
                        >
                          Use
                        </button>
                        <button
                          disabled={pending}
                          onClick={() =>
                            start(async () => { await rejectSuggestion(suggestions[r.id].id); router.refresh(); })
                          }
                          className="shrink-0 rounded px-1 py-0.5 text-[11px] text-[var(--text-muted)] hover:bg-[var(--surface-2)] disabled:opacity-50"
                          aria-label="Dismiss suggestion"
                        >
                          &times;
                        </button>
                      </div>
                    )}
                    <select
                      value={r.categoryId ?? ""}
                      disabled={pending}
                      onChange={(e) => patch(r.id, { categoryId: e.target.value ? Number(e.target.value) : null })}
                      className={`w-full max-w-[190px] rounded border bg-transparent px-1.5 py-0.5 ${
                        r.categoryId
                          ? "border-transparent hover:border-[var(--border)]"
                          : "border-[var(--status-warning)] text-[var(--status-warning)]"
                      }`}
                    >
                      <option value="">Uncategorized</option>
                      {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-1.5">
                    <select
                      value={r.txnType}
                      disabled={pending}
                      onChange={(e) => patch(r.id, { txnType: e.target.value as TxnType })}
                      className="w-full max-w-[160px] rounded border border-transparent bg-transparent px-1.5 py-0.5 hover:border-[var(--border)]"
                    >
                      {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-[12px] text-[var(--text-muted)]">
        Click a row to select it. Shift-click to select a range. The header checkbox takes the whole page.
      </p>
    </>
  );
}
