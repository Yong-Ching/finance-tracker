import Link from "next/link";
import { notFound } from "next/navigation";
import { subscriptionDetail } from "@/lib/queries";
import { formatMoney } from "@/lib/money";
import { Card, Stat, Empty } from "@/components/ui";
import { SubscriptionRowActions } from "@/components/SubscriptionActions";
import { EVERY, Health, StatementLink, th, td, rowCls, headRow } from "@/components/subscription-ui";

export const dynamic = "force-dynamic";

export default async function SubscriptionPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const d = Number.isInteger(id) && id > 0 ? subscriptionDetail(id) : null;
  if (!d) notFound();
  const { sub, history, statements } = d;
  const missed = history.filter((e) => e.kind === "missed").length;

  return (
    <div className="space-y-4">
      <Link href="/subscriptions" className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">
        &larr; Subscriptions
      </Link>

      <div className="flex flex-wrap items-start gap-3">
        <div>
          <h1 className="text-[15px] font-semibold tracking-tight">{sub.name}</h1>
          <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
            Matches &ldquo;{sub.pattern}&rdquo;{sub.accountName ? ` on ${sub.accountName}` : " on any account"},
            {" "}{sub.variableAmount
              ? <>at any amount (about {formatMoney(sub.typicalCents)})</>
              : <>{formatMoney(sub.amountCents)} &plusmn;10%</>}
            {" "}every {EVERY[sub.cadence]} &middot; <Health r={sub} />
          </p>
        </div>
        <div className="ml-auto">
          <SubscriptionRowActions
            id={sub.id}
            status={sub.status === "cancelled" ? "cancelled" : "active"}
            name={sub.name}
            pattern={sub.pattern}
            amountCents={sub.amountCents}
            variableAmount={sub.variableAmount}
            cadence={sub.cadence}
            priceNowCents={sub.status === "active" && sub.health.kind === "price_changed" ? sub.health.nowCents : undefined}
          />
        </div>
      </div>

      <div className="card grid grid-cols-2 divide-x divide-y divide-[var(--border)] sm:grid-cols-4 sm:divide-y-0">
        <Stat label="Paid so far" cents={d.paidCents} hint={sub.charges.length ? `since ${sub.charges[0].txnDate}` : undefined} />
        <Stat label="Average charge" cents={d.averageCents} hint={`${sub.charges.length} charge${sub.charges.length === 1 ? "" : "s"}`} />
        <Stat label="Per month" cents={sub.status === "active" ? sub.monthlyCents : 0} hint={sub.status === "active" ? undefined : "cancelled"} />
        <div className="px-4 py-3">
          <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Next expected</div>
          <div className="tnum mt-1 text-[26px] font-semibold leading-none tracking-tight">
            {sub.status === "active" ? sub.nextDue ?? "-" : "-"}
          </div>
          <div className="mt-1.5 text-[11px] text-[var(--text-muted)]">
            {sub.asOf ? `statements run to ${sub.asOf}` : "no statement yet"}
          </div>
        </div>
      </div>

      <Card
        title="Charge history"
        subtitle={`Every charge matched to this subscription, newest first, with the statement it came from${
          missed ? `. ${missed} cycle${missed === 1 ? "" : "s"} passed with no charge.` : "."
        }`}
        action={
          sub.charges.length ? (
            <Link
              href={`/transactions?subscription=${sub.id}`}
              className="text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline"
              title="Open exactly these charges on the Transactions page, to edit or recategorise them"
            >
              Show in Transactions &rarr;
            </Link>
          ) : undefined
        }
      >
        {history.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-[13px]">
              <thead>
                <tr className={headRow}>
                  <th className={th}>Date</th>
                  <th className={th}>Description</th>
                  <th className={th}>Category</th>
                  <th className={`${th} text-right`}>Amount</th>
                  <th className={th}>Statement</th>
                </tr>
              </thead>
              <tbody>
                {history.map((e) =>
                  e.kind === "missed" ? (
                    <tr key={`missed-${e.due}`} className="border-b border-[var(--border)]">
                      <td className={`${td} tnum text-[var(--status-warning)]`}>{e.due}</td>
                      <td className={`${td} text-[var(--status-warning)]`} colSpan={4}>
                        No charge - one was due around this date
                      </td>
                    </tr>
                  ) : (
                    <tr key={e.charge.id} className={rowCls}>
                      <td className={`${td} tnum whitespace-nowrap`}>{e.charge.txnDate}</td>
                      <td className={`${td} text-[var(--text-secondary)]`}>{e.charge.descriptionRaw}</td>
                      <td className={`${td} text-[var(--text-secondary)]`}>{e.charge.categoryName ?? "-"}</td>
                      <td className={`${td} tnum text-right`}>
                        {formatMoney(Math.abs(e.charge.amountCents))}
                        {!sub.variableAmount && Math.abs(e.charge.amountCents) !== sub.amountCents && (
                          <span
                            className="block text-[11px] text-[var(--text-muted)]"
                            title="Differs from the amount on record, within the 10% tolerance"
                          >
                            {Math.abs(e.charge.amountCents) > sub.amountCents ? "+" : "-"}
                            {formatMoney(Math.abs(Math.abs(e.charge.amountCents) - sub.amountCents))}
                          </span>
                        )}
                      </td>
                      <td className={`${td} whitespace-nowrap`}>
                        <StatementLink st={e.charge.statementId ? statements[e.charge.statementId] : undefined} />
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>
            Nothing matches yet. Check the pattern and amount with Edit, or wait for the next statement.
          </Empty>
        )}
      </Card>
    </div>
  );
}
