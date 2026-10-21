import Link from "next/link";
import { formatMoney, formatInColumn } from "@/lib/money";
import { pocketLedgers, listLinks, unmatchedTransfers } from "@/lib/reconcile";
import { LinkButtons, ReconcileBar } from "@/components/LinkActions";
import { Card, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ReconcilePage() {
  const pockets = pocketLedgers();
  const proposed = listLinks("proposed");
  const confirmed = listLinks("confirmed");
  const unmatched = unmatchedTransfers();
  // Per currency: the SGD transfers and the ringgit ones cannot share a total.
  const unmatchedTotals = new Map<string, number>();
  for (const t of unmatched) unmatchedTotals.set(t.currency, (unmatchedTotals.get(t.currency) ?? 0) + Math.abs(t.amountCents));
  const unmatchedTotal = [...unmatchedTotals].map(([c, cents]) => formatMoney(cents, c)).join(" and ") || formatMoney(0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-[15px] font-semibold tracking-tight">Reconcile</h1>
        <p className="text-[12px] text-[var(--text-muted)]">
          Ties money leaving your bank to the itemised spend it became
        </p>
        <div className="ml-auto"><ReconcileBar proposed={proposed.length} /></div>
      </div>

      {/* Pocket ledgers ---------------------------------------------------- */}
      <div className="grid gap-4 sm:grid-cols-2">
        {pockets.map((p) => (
          <Card key={p.accountId} title={p.accountName} subtitle={p.kind.replace("_", " ")}>
            {!p.hasStatements ? (
              <div className="space-y-3">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                    Sent from your bank, unaccounted
                  </div>
                  <div className="tnum mt-1 text-[24px] font-semibold leading-none text-[var(--status-warning)]">
                    {formatMoney(p.unmatchedCents, p.currency)}
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--text-muted)]">
                    across {p.unmatchedCount} transfers
                  </div>
                </div>
                <p className="text-[13px] text-[var(--text-secondary)]">
                  No {p.accountName} statement has been uploaded, so none of this money can be itemised. Upload one
                  and the matcher will pair each transfer with its top-up automatically.
                </p>
              </div>
            ) : (
              <dl className="space-y-1.5 text-[13px]">
                <Line k="Itemised spend on statements" v={formatInColumn(-p.itemisedCents, p.currency)} />
                <Line k="Payments matched to a bank transfer" v={formatInColumn(p.fundedCents, p.currency)} />
                {/*
                  * The balance comes from the statement, never from payments
                  * minus purchases: that subtraction is only correct if every
                  * statement since the account opened is held, which it is not.
                  */}
                <Line
                  k={`${p.kind === "credit_card" ? "Balance owed" : "Wallet balance"}${
                    p.statementDate ? ` at ${p.statementDate}` : ""
                  }`}
                  v={formatInColumn(p.statementBalanceCents ?? 0, p.currency)}
                  strong
                />
                {p.unmatchedCents > 0 && (
                  <Line
                    k="Payments not yet on a statement"
                    v={formatInColumn(p.unmatchedCents, p.currency)}
                    warn
                  />
                )}
              </dl>
            )}
          </Card>
        ))}
      </div>

      {/* Proposals --------------------------------------------------------- */}
      <Card
        title="Proposed matches"
        subtitle="Found by amount and date. Nothing is linked until you confirm it."
      >
        {proposed.length ? (
          <ul className="divide-y divide-[var(--border)]">
            {proposed.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-3 py-2.5 text-[13px]">
                <span className="tnum font-medium">{formatInColumn(l.amountCents, l.currency)}</span>
                <span className="text-[var(--text-secondary)]">
                  {l.sourceDate} {l.sourceAccount} &rarr; {l.targetDate} {l.targetAccount}
                </span>
                <span className="text-[11px] text-[var(--text-muted)]">
                  {l.dateGapDays === 0 ? "same day" : `${l.dateGapDays}d apart`} &middot;{" "}
                  {Math.round(l.confidence * 100)}% confidence
                </span>
                <span className="ml-auto"><LinkButtons id={l.id} /></span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>
            Nothing to confirm. The matcher pairs a bank transfer with a pocket top-up of the same amount within a
            few days.
          </Empty>
        )}
      </Card>

      {/* Unmatched --------------------------------------------------------- */}
      <Card
        title="Unmatched transfers"
        subtitle={`${unmatched.length} transfers totalling ${unmatchedTotal} with no confirmed counterpart`}
      >
        {unmatched.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[13px]">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                  <th className="py-2 font-medium">Date</th>
                  <th className="py-2 font-medium">Description</th>
                  <th className="py-2 font-medium">Pocket</th>
                  <th className="py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {unmatched.map((t) => (
                  <tr key={t.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="tnum whitespace-nowrap py-1.5 text-[var(--text-secondary)]">{t.txnDate}</td>
                    <td className="py-1.5"><span className="line-clamp-1">{t.descriptionRaw}</span></td>
                    <td className="py-1.5">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="hatch h-3 w-3 rounded-[2px]" aria-hidden />
                        {t.pocketName ?? t.categoryName ?? "unknown"}
                      </span>
                    </td>
                    <td className="tnum py-1.5 text-right">{formatInColumn(t.amountCents, t.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Every transfer is accounted for.</Empty>
        )}
      </Card>

      {confirmed.length > 0 && (
        <Card title="Confirmed links" subtitle={`${confirmed.length} pairs`}>
          <ul className="divide-y divide-[var(--border)]">
            {confirmed.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-3 py-2 text-[13px]">
                <span className="tnum font-medium">{formatInColumn(l.amountCents, l.currency)}</span>
                <span className="text-[var(--text-secondary)]">
                  {l.sourceDate} {l.sourceAccount} &rarr; {l.targetDate} {l.targetAccount}
                </span>
                <span className="ml-auto text-[11px] text-[var(--text-muted)]">{l.method}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Line({ k, v, strong, warn }: { k: string; v: string; strong?: boolean; warn?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${strong ? "border-t border-[var(--border)] pt-1.5 font-semibold" : ""}`}>
      <dt className="text-[var(--text-secondary)]">{k}</dt>
      <dd className={`tnum ${warn ? "text-[var(--status-warning)]" : ""}`}>{v}</dd>
    </div>
  );
}
