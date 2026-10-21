import Link from "next/link";
import { formatMoney, formatCents } from "@/lib/money";
import { resolvePeriod, previousPeriod } from "@/lib/period";
import {
  availableMonths, totals, byMonth, expenseByCategory, balanceSeries, accountCards, attention,
  subscriptionOverview, topMerchants,
} from "@/lib/queries";
import { BalanceLine } from "@/components/charts";
import { PeriodPicker } from "@/components/PeriodPicker";
import { QuickFind } from "@/components/DashboardLive";
import { FiguresToggle } from "@/components/FiguresToggle";
import { Card, Stat, Empty } from "@/components/ui";
import { Fig } from "@/components/Fig";

export const dynamic = "force-dynamic";

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (ym: string) => `${MONTH[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;

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
  const cats = expenseByCategory(period, undefined, 8);
  const catTotal = cats.reduce((a, c) => a + c.totalCents, 0);
  const balances = balanceSeries(period);
  const accounts = accountCards(period);
  const flags = attention();
  const subs = subscriptionOverview();
  const merchants = topMerchants(period, 3);

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

  const inPeriod = (m: string) => m >= period.from.slice(0, 7) && m <= period.to.slice(0, 7);
  const looseEnds = [
    flags.needsReview > 0 && { n: flags.needsReview, text: "need a category", href: "/transactions?review=1" },
    flags.unmatchedTransfers > 0 && { n: flags.unmatchedTransfers, text: "unmatched transfers", href: "/reconcile" },
    flags.proposedLinks > 0 && { n: flags.proposedLinks, text: "links to confirm", href: "/reconcile" },
    flags.quarantined > 0 && { n: flags.quarantined, text: "quarantined statements", href: "/accounts" },
  ].filter(Boolean) as { n: number; text: string; href: string }[];

  return (
    <div className="hideable space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-[15px] font-semibold">{period.label}</h1>
        <span className="text-[13px] text-[var(--text-muted)]">
          {t.count} transactions &middot; every figure opens what is behind it
        </span>
        <div className="ml-auto flex items-center gap-2">
          <FiguresToggle />
          <PeriodPicker months={months} value={period.key} />
        </div>
      </div>

      {/* Totals, plus the money no statement accounts for yet */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <div className="card"><Stat label="Money in" cents={t.incomeCents} delta={d(t.incomeCents, p.incomeCents)} href={drill({ type: "income" })} /></div>
        <div className="card"><Stat label="Expenses" cents={t.expenseCents} delta={d(t.expenseCents, p.expenseCents)} href={drill({ type: "expense" })} /></div>
        <div className="card"><Stat label="Savings" cents={t.savingsCents} delta={d(t.savingsCents, p.savingsCents)} href={drill({ type: "savings" })} /></div>
        <div className="card">
          <Stat
            label="Net" cents={t.netCents} href={drill({})}
            hint={t.savingsRate !== null ? `${Math.round(t.savingsRate * 100)}% savings rate` : undefined}
          />
        </div>
        <Link
          href="/reconcile"
          className="card col-span-2 flex gap-3 px-4 py-3 transition-colors hover:bg-[var(--surface-2)] lg:col-span-1"
          title="Money moved into YouTrip or the Citibank card with no itemised statement yet. Not counted in Expenses."
        >
          <div className="hatch w-1.5 shrink-0 rounded-sm" aria-hidden />
          <div>
            <div className="text-[13px] text-[var(--text-muted)]">Unaccounted</div>
            <div className="tnum mt-1 text-[24px] font-semibold leading-none tracking-tight"><Fig>{formatMoney(t.unaccountedCents)}</Fig></div>
            <div className="mt-1.5 text-[12px] text-[var(--text-muted)]">in pockets, not in Expenses</div>
          </div>
        </Link>
      </div>

      <div className="grid gap-3 lg:grid-cols-12">
        {/* Balance */}
        <Card className="lg:col-span-8" title="Cash in DBS" subtitle="Running balance; click a day to see it">
          {balances.length > 1 ? <BalanceLine data={balances} height={236} /> : <Empty>Not enough data in this period.</Empty>}
        </Card>

        {/* Where it went: a receipt whose rows add up to Expenses */}
        <section
          className="bg-[var(--surface-1)] px-4 pb-8 pt-4 lg:col-span-4"
          style={{ clipPath: zigzag(24, 7), borderRadius: "10px 10px 0 0" }}
        >
          <div className="flex items-baseline justify-between">
            <h2 className="text-[14px] font-semibold">Where it went</h2>
            <span className="text-[12px] text-[var(--text-muted)]">{cats.reduce((a, c) => a + c.count, 0)} txns</span>
          </div>
          {cats.length ? (
            <>
              <ul className="mt-3 space-y-1 text-[14px]">
                {cats.map((c) => (
                  <li key={c.name}>
                    <Link href={sliceHref(c)} className="group flex items-baseline gap-2" title="Show these transactions">
                      <span className="shrink-0 group-hover:underline">{c.name}</span>
                      <span aria-hidden className="min-w-3 flex-1 overflow-hidden whitespace-nowrap text-[var(--text-muted)]">
                        {". ".repeat(60)}
                      </span>
                      <span className="tnum shrink-0"><Fig>{formatCents(c.totalCents)}</Fig></span>
                      <span className="tnum w-9 shrink-0 text-right text-[12px] text-[var(--text-muted)]">{Math.round(c.share * 100)}%</span>
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex items-baseline justify-between bg-[var(--text-primary)] px-2.5 py-1.5 text-[14px] font-semibold text-[var(--surface-1)]">
                <span>Total</span>
                <span className="tnum"><Fig>{formatCents(catTotal)}</Fig></span>
              </div>
            </>
          ) : (
            <Empty>No expenses in this period.</Empty>
          )}
        </section>
      </div>

      <div className="grid gap-3 lg:grid-cols-12">
        {/* Month by month */}
        <Card className="lg:col-span-8" title="Month by month" subtitle="Click a month to open it">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[460px] text-[14px]">
              <thead>
                <tr className="text-left text-[12px] text-[var(--text-muted)]">
                  <th className="pb-1.5 pl-2 font-medium">Month</th>
                  <th className="pb-1.5 text-right font-medium">In</th>
                  <th className="pb-1.5 text-right font-medium">Spent</th>
                  <th className="pb-1.5 text-right font-medium">Saved</th>
                  <th className="pb-1.5 pr-2 text-right font-medium">Kept</th>
                </tr>
              </thead>
              <tbody>
                {[...monthly].reverse().map((m) => {
                  const net = m.incomeCents - m.expenseCents;
                  const href = `/transactions?${new URLSearchParams({ from: `${m.month}-01`, to: `${m.month}-31` })}`;
                  return (
                    <tr key={m.month} className={`odd:bg-[var(--surface-0)] ${inPeriod(m.month) ? "" : "text-[var(--text-muted)]"}`}>
                      <td className="py-1 pl-2"><Link href={href} className="hover:underline">{monthName(m.month)}</Link></td>
                      <td className="tnum py-1 text-right"><Fig>{formatCents(m.incomeCents)}</Fig></td>
                      <td className="tnum py-1 text-right"><Fig>{formatCents(m.expenseCents)}</Fig></td>
                      <td className="tnum py-1 text-right"><Fig>{formatCents(m.savingsCents)}</Fig></td>
                      <td className={`tnum py-1 pr-2 text-right ${net < 0 ? "text-[var(--status-critical)]" : ""}`}>
                        <Fig>{net < 0 ? "-" : ""}{formatCents(Math.abs(net))}</Fig>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="grid min-w-0 content-start gap-3 lg:col-span-4">
          <Card className="min-w-0" title="Quick find" subtitle="A merchant, or an amount like ~12.50">
            <QuickFind
              from={period.from}
              to={period.to}
              initial={merchants[0] ?? ""}
              examples={[...merchants.slice(1), ">500"]}
            />
          </Card>

          <Card
            title="Subscriptions"
            subtitle={subs.active.length ? <><Fig>{formatMoney(subs.monthlyTotalCents)}</Fig> a month</> : undefined}
            action={<Link href="/subscriptions" className="text-[12px] text-[var(--text-secondary)] hover:underline">All</Link>}
          >
            {subs.active.length ? (
              <ul className="space-y-1 text-[14px]">
                {subs.active.slice(0, 6).map((s) => (
                  <li key={s.id}>
                    <Link href={`/subscriptions/${s.id}`} className="flex items-baseline gap-2 hover:underline">
                      <span className="min-w-0 flex-1 truncate">{s.name}</span>
                      {(s.health.kind === "overdue" || s.health.kind === "no_charges") && (
                        <span className="text-[12px] text-[var(--status-warning)]">check</span>
                      )}
                      <span className="tnum text-[var(--text-secondary)]"><Fig>{formatMoney(s.monthlyCents, s.currency)}</Fig></span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[14px] text-[var(--text-secondary)]">
                Nothing tracked. <Link href="/subscriptions" className="underline">See what repeats.</Link>
              </p>
            )}
          </Card>

          <Card title="Loose ends">
            {looseEnds.length ? (
              <ul className="space-y-1 text-[14px]">
                {looseEnds.map((l) => (
                  <li key={l.href + l.text}>
                    <Link href={l.href} className="flex items-baseline gap-2 hover:underline">
                      <span className="tnum w-8 font-semibold text-[var(--status-warning)]">{l.n}</span>
                      <span>{l.text}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[14px] text-[var(--text-secondary)]">Nothing outstanding.</p>
            )}
          </Card>
        </div>
      </div>

      {/* Accounts */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {accounts.map((a) => (
          <Link
            key={a.id}
            href={drill({ account: String(a.id) })}
            className="card block px-4 py-3 transition-colors hover:bg-[var(--surface-2)]"
            title={`Show ${a.name} transactions`}
          >
            <div className="text-[13px] text-[var(--text-secondary)]">
              {a.name}{a.isPocket && " (pocket)"}
            </div>
            <div className="tnum mt-1 text-[20px] font-semibold leading-none">
              {a.balanceCents !== null ? <Fig>{formatMoney(a.balanceCents, a.currency)}</Fig> : <span className="text-[var(--text-muted)]">no data</span>}
            </div>
            <div className="mt-1.5 text-[12px] text-[var(--text-muted)]">
              {a.lastStatement ? `to ${a.lastStatement}` : "no statement uploaded"}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

/** A torn bottom edge for the receipt, as a clip-path polygon. */
function zigzag(teeth: number, depthPx: number): string {
  const pts = ["0 0", "100% 0"];
  for (let i = teeth; i >= 0; i--) {
    pts.push(`${(i / teeth) * 100}% calc(100% - ${i % 2 ? 0 : depthPx}px)`);
  }
  return `polygon(${pts.join(", ")})`;
}
