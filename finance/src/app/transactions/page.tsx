import Link from "next/link";
import { formatCents } from "@/lib/money";
import { listTransactions, allCategories, allAccounts, suggestionsByTxnId, flagsByTxnId } from "@/lib/queries";
import { TransactionsTable } from "@/components/TransactionsTable";
import { Card, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";

const PER_PAGE = 100;

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1));
  const filters = {
    q: sp.q || undefined,
    accountId: sp.account ? Number(sp.account) : undefined,
    // "none", a single id, or a comma-separated list from a dashboard drill-in.
    categoryId: parseCategory(sp.category),
    txnType: sp.type || undefined,
    from: sp.from || undefined,
    to: sp.to || undefined,
    reviewOnly: sp.review === "1",
    page,
    perPage: PER_PAGE,
  };

  const { rows, total, sumCents } = listTransactions(filters);
  const categories = allCategories();
  const accounts = allAccounts();

  // Claude's proposals ride alongside the rows; they change nothing until used.
  const suggestions = Object.fromEntries(
    [...suggestionsByTxnId()].map(([txnId, s]) => [
      txnId,
      {
        id: s.id,
        label: s.categoryName ?? s.newCategoryName ?? "?",
        confidence: s.confidence,
        reasoning: s.reasoning,
      },
    ]),
  );
  const flags = Object.fromEntries(
    [...flagsByTxnId()].map(([txnId, list]) => [
      txnId,
      list.map((f) => ({ id: f.id, flagType: f.flagType ?? "flag", reasoning: f.reasoning })),
    ]),
  );
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));

  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...patch })) if (v) p.set(k, v);
    return `/transactions?${p}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-[15px] font-semibold tracking-tight">Transactions</h1>
        <span className="text-[12px] text-[var(--text-muted)]">
          {total} matching &middot; <span className="tnum">{formatCents(sumCents)}</span> net
        </span>
      </div>

      {/* Filters live in one row above the table. */}
      <form className="card flex flex-wrap items-end gap-3 p-3" action="/transactions">
        <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
          Search
          <input
            name="q" defaultValue={sp.q ?? ""} placeholder="Description contains..."
            className="w-56 rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-[13px] normal-case tracking-normal text-[var(--text-primary)]"
          />
        </label>
        <Select name="account" label="Account" value={sp.account} options={accounts.map((a) => [String(a.id), a.name] as [string, string])} />
        <Select
          name="category" label="Category"
          value={sp.category?.includes(",") ? "" : sp.category}
          options={[["none", "Uncategorized"] as [string, string], ...categories.map((c) => [String(c.id), c.name] as [string, string])]}
          extra={
            sp.category?.includes(",")
              ? `${sp.category.split(",").length} categories`
              : undefined
          }
        />
        <Select
          name="type" label="Type" value={sp.type}
          options={[
            ["expense", "Expense"], ["income", "Income"], ["savings", "Savings"],
            ["debt_repayment", "Debt repayment"], ["internal_transfer", "Internal transfer"],
          ]}
        />
        <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
          From
          <input type="date" name="from" defaultValue={sp.from ?? ""} className="rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-[13px] text-[var(--text-primary)]" />
        </label>
        <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
          To
          <input type="date" name="to" defaultValue={sp.to ?? ""} className="rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-[13px] text-[var(--text-primary)]" />
        </label>
        <label className="flex items-center gap-2 pb-1 text-[13px]">
          <input type="checkbox" name="review" value="1" defaultChecked={sp.review === "1"} />
          Needs review
        </label>
        <button className="rounded bg-[var(--text-primary)] px-3 py-1.5 text-[13px] font-medium text-[var(--surface-1)]">
          Apply
        </button>
        <Link href="/transactions" className="pb-1.5 text-[13px] text-[var(--text-secondary)] hover:underline">
          Reset
        </Link>
      </form>

      {rows.length ? (
        <TransactionsTable
          rows={rows}
          categories={categories}
          suggestions={suggestions}
          flags={flags}
          total={total}
          filters={{
            q: filters.q,
            accountId: filters.accountId,
            categoryId: filters.categoryId,
            txnType: filters.txnType,
            from: filters.from,
            to: filters.to,
            reviewOnly: filters.reviewOnly,
          }}
        />
      ) : (
        <Card><Empty>No transactions match these filters.</Empty></Card>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between text-[13px]">
          <span className="text-[var(--text-muted)]">Page {page} of {pages}</span>
          <div className="flex gap-2">
            {page > 1 && <Link className="rounded border border-[var(--border)] px-3 py-1 hover:bg-[var(--surface-2)]" href={qs({ page: String(page - 1) })}>Previous</Link>}
            {page < pages && <Link className="rounded border border-[var(--border)] px-3 py-1 hover:bg-[var(--surface-2)]" href={qs({ page: String(page + 1) })}>Next</Link>}
          </div>
        </div>
      )}
    </div>
  );
}

/** "none" | "12" | "12,15,19" -> the shape listTransactions expects. */
function parseCategory(raw: string | undefined) {
  if (!raw) return undefined;
  if (raw === "none") return "none" as const;
  const ids = raw.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return undefined;
  return ids.length === 1 ? ids[0] : ids;
}

function Select({
  name, label, value, options, extra,
}: {
  name: string; label: string; value?: string; options: [string, string][]; extra?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
      {label}
      <select
        name={name} defaultValue={value ?? ""}
        className="rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-[13px] normal-case tracking-normal text-[var(--text-primary)]"
      >
        <option value="">{extra ?? "All"}</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}
