import { portfolio, holdingSources, type PortfolioSlice } from "@/lib/queries";
import { formatCents, formatMoney } from "@/lib/money";
import { loadFx, loadPortfolioFx } from "@/lib/fx-server";
import { converting, rateLine } from "@/lib/fx";
import { SERIES_COLORS } from "@/lib/palette";
import { CategoryDonut } from "@/components/charts";
import { Card, Empty } from "@/components/ui";
import { Fig } from "@/components/Fig";
import { HoldingRow, NewHoldingForm } from "@/components/HoldingActions";

export const dynamic = "force-dynamic";

/** A donut and its value/share table, as on the dashboard: the table carries the exact figures. */
function Split({ title, rows, currency, totalCents, approx }: {
  title: string; rows: PortfolioSlice[]; currency: string; totalCents: number; approx: boolean;
}) {
  return (
    <Card title={title}>
      <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center sm:gap-8">
        <div className="relative shrink-0">
          <CategoryDonut size={200} data={rows} valueLabel="Value" countLabel="Holdings" />
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[12px] text-[var(--text-muted)]">Total</span>
            <span className="tnum text-[16px] font-semibold leading-tight"><Fig>{approx ? "≈" : ""}{formatMoney(totalCents, currency)}</Fig></span>
          </div>
        </div>
        <table className="w-full text-[14px]">
          <thead>
            <tr className="text-left text-[12px] text-[var(--text-muted)]">
              <th className="pb-1.5 font-medium">{title.replace(/^By /, "").replace(/^./, (c) => c.toUpperCase())}</th>
              <th className="pb-1.5 text-right font-medium">Value</th>
              <th className="pb-1.5 text-right font-medium">Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.name} className="border-t border-[var(--border)]">
                <td className="py-1.5">
                  <span className="flex items-center gap-2">
                    <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: SERIES_COLORS[i] }} />
                    {r.name}
                  </span>
                </td>
                <td className="tnum py-1.5 text-right"><Fig>{formatCents(r.totalCents)}</Fig></td>
                <td className="tnum py-1.5 text-right text-[var(--text-muted)]">{Math.round(r.share * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export default async function InvestmentsPage() {
  const viewFx = await loadFx();
  const fx = await loadPortfolioFx();
  const p = portfolio(fx);
  const sources = holdingSources();
  const currencies = fx.currencies;
  const mixed = new Set(p.holdings.map((h) => h.currency)).size > 1 || p.holdings.some((h) => h.currency !== p.currency);
  const gain = p.costedValueCents - p.costCents;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-[15px] font-semibold tracking-tight">Investments</h1>
        <p className="text-[12px] text-[var(--text-muted)]">
          Entered by hand - no statement feeds these. Update a value when you check the platform.
        </p>
      </div>

      {p.holdings.length > 0 && (
        <div className="card grid grid-cols-1 divide-y divide-[var(--border)] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <div className="px-4 py-3">
            <div className="text-[13px] text-[var(--text-muted)]">Portfolio value</div>
            <div className="tnum mt-1 text-[22px] font-semibold leading-none tracking-tight sm:text-[26px]">
              {p.currency ? (
                <Fig>{mixed ? "≈" : ""}{formatMoney(p.totalCents, p.currency)}</Fig>
              ) : (
                <Fig>{p.perCurrency.map((c) => formatMoney(c.cents, c.currency)).join(" + ")}</Fig>
              )}
            </div>
            <div className="mt-1.5 text-[11px] text-[var(--text-muted)]">
              {p.currency
                ? mixed ? `every holding in ${p.currency} at the latest rate${fx.asOf ? ` (${fx.asOf})` : ""}` : undefined
                : "no exchange rate to hand, so currencies are kept apart"}
            </div>
          </div>
          <div className="px-4 py-3">
            <div className="text-[13px] text-[var(--text-muted)]">Gain on cost</div>
            <div className="tnum mt-1 text-[22px] font-semibold leading-none tracking-tight sm:text-[26px]">
              {p.currency && p.costCents > 0 ? (
                <Fig>{gain >= 0 ? "+" : "-"}{formatMoney(Math.abs(gain), p.currency)}</Fig>
              ) : "-"}
            </div>
            <div className="mt-1.5 text-[11px] text-[var(--text-muted)]">
              {p.currency && p.costCents > 0
                ? `${gain >= 0 ? "+" : ""}${Math.round((gain / p.costCents) * 1000) / 10}% on the holdings with a cost`
                : "add a cost to a holding to see this"}
            </div>
          </div>
          <div className="px-4 py-3">
            <div className="text-[13px] text-[var(--text-muted)]">Holdings</div>
            <div className="tnum mt-1 text-[22px] font-semibold leading-none tracking-tight sm:text-[26px]">{p.holdings.length}</div>
            <div className="mt-1.5 text-[11px] text-[var(--text-muted)]">
              across {new Set(p.holdings.map((h) => h.source)).size} source(s) · oldest value {p.oldestAsOf}
            </div>
          </div>
        </div>
      )}

      {p.currency && p.totalCents > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Split title="By source" rows={p.bySource} currency={p.currency} totalCents={p.totalCents} approx={mixed} />
          <Split title="By asset class" rows={p.byClass} currency={p.currency} totalCents={p.totalCents} approx={mixed} />
        </div>
      )}

      <Card
        title="Holdings"
        subtitle={converting(viewFx) ? `Shown in ${viewFx.mode} (${rateLine(viewFx)})` : "Each in its own currency"}
      >
        {p.holdings.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-[13px]">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                  <th className="px-3 py-2 font-medium first:pl-0">Holding</th>
                  <th className="px-3 py-2 text-right font-medium">Value</th>
                  <th className="px-3 py-2 text-right font-medium">Cost</th>
                  <th className="px-3 py-2 text-right font-medium">Gain</th>
                  <th className="px-3 py-2 font-medium">As of</th>
                  <th className="px-3 py-2 last:pr-0" />
                </tr>
              </thead>
              <tbody>
                {p.holdings.map((h) => (
                  <HoldingRow
                    key={h.id} id={h.id} sources={sources} currencies={currencies} fx={viewFx}
                    holding={{
                      name: h.name, source: h.source, assetClass: h.assetClass, currency: h.currency,
                      valueCents: h.valueCents, costCents: h.costCents, asOf: h.asOf,
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No investments yet. Add one below - a stock, a fund, a gold bar - with where it is held.</Empty>
        )}
      </Card>

      <Card title="Add a holding" subtitle="One row per thing you hold. Several on one platform share its source name.">
        <NewHoldingForm sources={sources} currencies={[...new Set([...currencies, "USD"])]} />
      </Card>
    </div>
  );
}
