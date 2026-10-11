import Link from "next/link";
import { formatMoney, formatCents } from "@/lib/money";
import { resolvePeriod, previousPeriod } from "@/lib/period";
import {
  availableMonths, totals, byMonth, expenseByCategory,
  balanceSeries, accountCards, attention,
} from "@/lib/queries";
import { MonthlyBuckets, BalanceLine, CategoryBars } from "@/components/charts";
import { PeriodPicker } from "@/components/PeriodPicker";
import { Card, Stat, Empty, Pill } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { period: periodParam } = await searchParams;
  const months = availableMonths();

  if (!months.length) {
    return (
      <Card title="No statements yet">
        <Empty>Upload a PDF statement to get started.</Empty>
      </Card>
    );
  }

  const period = resolvePeriod(periodParam, months);
  const prev = previousPeriod(period);
  const t = totals(period);
  const p = totals({ ...prev, label: "", key: "prev" });
  // "vs prior" is nonsense when the preceding window is empty (e.g. All time).
  const d = (now: number, before: number) => (p.count > 0 ? now - before : null);
  const monthly = byMonth();
  const cats = expenseByCategory(period);
  const balances = balanceSeries(period);
  const accounts = accountCards(period);
  const flags = attention();

  const catTotal = cats.reduce((a, c) => a + c.totalCents, 0);

  /**
   * Every figure on this page is a link to the transactions behind it, with the
   * period carried through as a date range so the drill-in shows exactly the
   * rows that produced the number.
   */
  const drill = (params: Record<string, string | undefined>) => {
    const q = new URLSearchParams({ from: period.from, to: period.to });
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    return `/transactions?${q}`;
  };

  const sliceHref = (c: (typeof cats)[number]) =>
    c.categoryId !== null
      ? drill({ category: String(c.categoryId) })
      : c.memberIds?.length
        ? drill({ category: c.memberIds.join(",") })
        : drill({ category: "none" });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-[15px] font-semibold tracking-tight">{period.label}</h1>
        <span className="text-[12px] text-[var(--text-muted)]">
          {t.count} transactions &middot; click any figure to see what is behind it
        </span>
        <div className="ml-auto">
          <PeriodPicker months={months} value={period.key} />
        </div>
      </div>

      {/* 1. headline band -------------------------------------------------- */}
      <div className="card grid grid-cols-2 divide-x divide-y divide-[var(--border)] sm:grid-cols-4 sm:divide-y-0">
        <Stat label="Money in" cents={t.incomeCents} delta={d(t.incomeCents, p.incomeCents)}
          href={drill({ type: "income" })} />
        <Stat label="Expenses" cents={t.expenseCents} delta={d(t.expenseCents, p.expenseCents)}
          href={drill({ type: "expense" })} />
        <Stat label="Savings" cents={t.savingsCents} delta={d(t.savingsCents, p.savingsCents)}
          href={drill({ type: "savings" })} />
        <Stat
          label="Net"
          cents={t.netCents}
          hint={t.savingsRate !== null ? `${Math.round(t.savingsRate * 100)}% savings rate` : undefined}
          href={drill({})}
        />
      </div>

      {/* 2. unaccounted ----------------------------------------------------- */}
      {t.unaccountedCents > 0 && (
        <section className="card flex flex-wrap items-center gap-x-5 gap-y-2 p-4">
          <div className="hatch h-9 w-1.5 rounded-sm" aria-hidden />
          <div>
            <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Unaccounted</div>
            <div className="tnum text-[22px] font-semibold leading-tight">{formatMoney(t.unaccountedCents)}</div>
          </div>
          <p className="max-w-xl flex-1 text-[13px] text-[var(--text-secondary)]">
            Money moved into a pocket - YouTrip or the Citibank card - whose itemised statement has not been
            uploaded. It is <strong className="font-semibold">not</strong> counted in Expenses above, because what it
            was spent on is unknown.
          </p>
          <Pill href="/reconcile" tone="warning">Reconcile</Pill>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 3. cash over time ------------------------------------------------ */}
        <Card title="Cash over time" subtitle="DBS running balance. Other accounts have their own scale, so they are not pooled here.">
          {balances.length > 1 ? <BalanceLine data={balances} /> : <Empty>Not enough data in this period.</Empty>}
        </Card>

        {/* 4. buckets over time --------------------------------------------- */}
        <Card title="Buckets by month" subtitle="Internal transfers are excluded by construction">
          <MonthlyBuckets data={monthly} />
        </Card>
      </div>

      {/* 5. where the money went -------------------------------------------- */}
      <Card
        title="Where the money went"
        subtitle={`Top ${Math.min(5, cats.length)} expense categories plus the remainder`}
      >
        {cats.length ? (
          <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
            <CategoryBars data={cats.map((c) => ({ ...c, href: sliceHref(c) }))} />
            <table className="w-full self-start text-[13px]">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                  <th className="pb-1.5 font-medium">Category</th>
                  <th className="pb-1.5 text-right font-medium">Total</th>
                  <th className="pb-1.5 text-right font-medium">Share</th>
                  <th className="pb-1.5 text-right font-medium">n</th>
                </tr>
              </thead>
              <tbody>
                {cats.map((c) => (
                  <tr key={c.name} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-2)]">
                    <td className="py-1.5">
                      <Link href={sliceHref(c)} className="block hover:underline" title="Show these transactions">
                        {c.name}
                      </Link>
                    </td>
                    <td className="tnum py-1.5 text-right">
                      <Link href={sliceHref(c)} className="block">{formatCents(c.totalCents)}</Link>
                    </td>
                    <td className="tnum py-1.5 text-right text-[var(--text-secondary)]">
                      {Math.round(c.share * 100)}%
                    </td>
                    <td className="tnum py-1.5 text-right text-[var(--text-muted)]">{c.count}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="pt-2">Total</td>
                  <td className="tnum pt-2 text-right">{formatCents(catTotal)}</td>
                  <td colSpan={2} />
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No expenses in this period.</Empty>
        )}
      </Card>

      {/* 6. per-account strip ------------------------------------------------ */}
      <Card title="Accounts" action={<Pill href="/accounts">All accounts</Pill>}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {accounts.map((a) => (
            <Link
              key={a.id}
              href={drill({ account: String(a.id) })}
              className="block rounded-lg border border-[var(--border)] p-3 hover:bg-[var(--surface-2)]"
              title={`Show ${a.name} transactions`}
            >
              <div className="flex items-baseline gap-2">
                <span className="text-[13px] font-medium">{a.name}</span>
                {a.isPocket && (
                  <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                    pocket
                  </span>
                )}
              </div>
              <div className="tnum mt-1.5 text-[18px] font-semibold leading-none">
                {a.balanceCents !== null ? formatMoney(a.balanceCents) : <span className="text-[var(--text-muted)]">no data</span>}
              </div>
              <div className="mt-1.5 text-[11px] text-[var(--text-muted)]">
                {a.lastStatement
                  ? `latest statement ${a.lastStatement}`
                  : "no statement uploaded"}
              </div>
            </Link>
          ))}
        </div>
      </Card>

      {/* 7. needs attention -------------------------------------------------- */}
      <Card title="Needs attention">
        <div className="flex flex-wrap gap-2">
          {flags.needsReview > 0 && (
            <Pill href="/transactions?review=1" tone="warning">
              {flags.needsReview} transactions need a category
            </Pill>
          )}
          {flags.unmatchedTransfers > 0 && (
            <Pill href="/reconcile" tone="warning">
              {flags.unmatchedTransfers} unmatched transfers
            </Pill>
          )}
          {flags.proposedLinks > 0 && (
            <Pill href="/reconcile">{flags.proposedLinks} proposed links to confirm</Pill>
          )}
          {flags.quarantined > 0 && (
            <Pill href="/accounts" tone="warning">
              {flags.quarantined} quarantined statements
            </Pill>
          )}
          {flags.needsReview === 0 && flags.unmatchedTransfers === 0 &&
            flags.proposedLinks === 0 && flags.quarantined === 0 && (
              <p className="text-[13px] text-[var(--text-muted)]">Nothing outstanding.</p>
            )}
        </div>
      </Card>
    </div>
  );
}
