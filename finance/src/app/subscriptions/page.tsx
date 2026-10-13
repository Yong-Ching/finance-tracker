import Link from "next/link";
import { subscriptionOverview, allAccounts, type SubscriptionRow } from "@/lib/queries";
import { suggestName } from "@/lib/subscriptions";
import { formatMoney } from "@/lib/money";
import { Card, Stat, Empty } from "@/components/ui";
import { CandidateActions, NewSubscriptionForm, SubscriptionRowActions } from "@/components/SubscriptionActions";

export const dynamic = "force-dynamic";

const EVERY = { weekly: "week", monthly: "month", quarterly: "quarter", yearly: "year" } as const;

// Every column gets breathing room on both sides; numbers sit right-aligned.
const th = "px-3 py-2 font-medium first:pl-0 last:pr-0";
const row = "border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-2)]";

/** The transactions behind a subscription, on the Transactions page. */
const chargesHref = (pattern: string, accountId: number | null) =>
  `/transactions?q=${encodeURIComponent(pattern)}${accountId ? `&account=${accountId}` : ""}`;

function Count({ label, n, hint, warn }: { label: string; n: number; hint?: string; warn?: boolean }) {
  return (
    <div className="px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
      <div className={`tnum mt-1 text-[26px] font-semibold leading-none tracking-tight ${warn ? "text-[var(--status-warning)]" : ""}`}>
        {n}
      </div>
      {hint && <div className="mt-1.5 text-[11px] text-[var(--text-muted)]">{hint}</div>}
    </div>
  );
}

function Health({ r }: { r: SubscriptionRow }) {
  const h = r.health;
  if (h.kind === "no_charges") {
    return <span className="text-[var(--status-warning)]">No matching charges yet</span>;
  }
  if (h.kind === "overdue") {
    return (
      <span className="text-[var(--status-warning)]" title={`Statements run to ${r.asOf}`}>
        Not charged since {r.lastCharge!.txnDate} - cancelled?
      </span>
    );
  }
  if (h.kind === "price_changed") {
    return <span>Now {formatMoney(h.nowCents)}</span>;
  }
  return <span className="text-[var(--text-muted)]">On track</span>;
}

function SubscriptionTable({ rows, muted = false }: { rows: SubscriptionRow[]; muted?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-[13px]">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
            <th className={th}>Subscription</th>
            <th className={`${th} text-right`}>Charge</th>
            <th className={`${th} text-right`}>Per month</th>
            <th className={th}>Last charged</th>
            <th className={th}>Next expected</th>
            <th className={th}>Status</th>
            <th className="px-3 py-2 last:pr-0" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={`${row} ${muted ? "opacity-55" : ""}`}>
              <td className="px-3 first:pl-0 last:pr-0 py-2">
                <div className="font-medium">{r.name}</div>
                <Link
                  href={chargesHref(r.pattern, r.accountId)}
                  className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:underline"
                  title="Show the charges"
                >
                  {r.pattern}
                  {r.accountName && ` · ${r.accountName}`}
                  {` · ${r.charges.length} charge${r.charges.length === 1 ? "" : "s"}`}
                </Link>
              </td>
              <td className="px-3 first:pl-0 last:pr-0 tnum py-2 text-right">
                {formatMoney(r.amountCents)}
                <span className="text-[var(--text-muted)]"> / {EVERY[r.cadence]}</span>
              </td>
              <td className="px-3 first:pl-0 last:pr-0 tnum py-2 text-right font-medium">{formatMoney(r.monthlyCents)}</td>
              <td className="px-3 first:pl-0 last:pr-0 tnum py-2 text-[var(--text-secondary)]">
                {r.lastCharge ? (
                  <>
                    {r.lastCharge.txnDate}
                    {Math.abs(r.lastCharge.amountCents) !== r.amountCents && (
                      <span className="text-[var(--text-muted)]"> · {formatMoney(Math.abs(r.lastCharge.amountCents))}</span>
                    )}
                  </>
                ) : "-"}
              </td>
              <td className="px-3 first:pl-0 last:pr-0 tnum py-2 text-[var(--text-secondary)]">{muted ? "-" : r.nextDue ?? "-"}</td>
              <td className="px-3 first:pl-0 last:pr-0 py-2">{muted ? <span className="text-[var(--text-muted)]">Cancelled</span> : <Health r={r} />}</td>
              <td className="px-3 first:pl-0 last:pr-0 py-2">
                <SubscriptionRowActions
                  id={r.id}
                  status={r.status === "cancelled" ? "cancelled" : "active"}
                  name={r.name}
                  amountCents={r.amountCents}
                  cadence={r.cadence}
                  priceNowCents={!muted && r.health.kind === "price_changed" ? r.health.nowCents : undefined}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function SubscriptionsPage() {
  const o = subscriptionOverview();
  const accounts = allAccounts();
  const asOf = [...new Set(o.active.map((r) => r.asOf).filter(Boolean))].sort().at(-1);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-[15px] font-semibold tracking-tight">Subscriptions</h1>
        <p className="text-[12px] text-[var(--text-muted)]">
          Recurring charges you have chosen to track. Each is judged against its account&apos;s latest
          statement, not today&apos;s date.
        </p>
      </div>

      <div className="card grid grid-cols-2 divide-x divide-y divide-[var(--border)] sm:grid-cols-4 sm:divide-y-0">
        <Stat label="Per month" cents={o.monthlyTotalCents} hint="yearly plans spread over 12" />
        <Stat label="Per year" cents={o.monthlyTotalCents * 12} />
        <Count label="Active" n={o.active.length} hint={asOf ? `statements to ${asOf}` : undefined} />
        <Count
          label="Needs a look" n={o.needsAttention} warn={o.needsAttention > 0}
          hint={o.needsAttention ? "missed a charge, or never matched" : "all charging as expected"}
        />
      </div>

      <Card title="Active" subtitle={o.active.length ? "Largest monthly cost first" : undefined}>
        {o.active.length ? (
          <SubscriptionTable rows={o.active} />
        ) : (
          <Empty>Nothing tracked yet. Track one from the suggestions below, or add it by hand.</Empty>
        )}
      </Card>

      <Card
        title={`Suggested${o.candidates.length ? ` (${o.candidates.length})` : ""}`}
        subtitle="Charges that repeat at a steady amount and interval. Nothing is tracked until you say so; dismissed ones are not suggested again."
      >
        {o.candidates.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-[13px]">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                  <th className={th}>Merchant</th>
                  <th className={`${th} text-right`}>Charge</th>
                  <th className={th}>Seen</th>
                  <th className={th}>Last</th>
                  <th className={th}>Category</th>
                  <th className="px-3 py-2 last:pr-0" />
                </tr>
              </thead>
              <tbody>
                {o.candidates.map((c) => (
                  <tr key={`${c.accountId}|${c.pattern}|${c.amountCents}`} className={row}>
                    <td className="px-3 first:pl-0 last:pr-0 py-2">
                      <Link
                        href={chargesHref(c.pattern, c.accountId)}
                        className="font-medium hover:underline" title="Show the charges"
                      >
                        {c.pattern}
                      </Link>
                      <span className="text-[11px] text-[var(--text-muted)]"> · {c.accountName}</span>
                    </td>
                    <td className="px-3 first:pl-0 last:pr-0 tnum py-2 text-right">
                      {formatMoney(c.amountCents)}
                      <span className="text-[var(--text-muted)]"> / {EVERY[c.cadence]}</span>
                    </td>
                    <td className="px-3 first:pl-0 last:pr-0 tnum py-2 text-[var(--text-secondary)]">
                      {c.count} times since {c.firstDate}
                    </td>
                    <td className="px-3 first:pl-0 last:pr-0 tnum py-2 text-[var(--text-secondary)]">{c.lastDate}</td>
                    <td className="px-3 first:pl-0 last:pr-0 py-2 text-[var(--text-secondary)]">{c.categoryName ?? "-"}</td>
                    <td className="px-3 first:pl-0 last:pr-0 py-2">
                      <CandidateActions
                        pattern={c.pattern} accountId={c.accountId} amountCents={c.amountCents}
                        cadence={c.cadence} suggestedName={suggestName(c.pattern)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No new repeating charges found.</Empty>
        )}
      </Card>

      <Card
        title="Add by hand"
        subtitle="For a yearly plan, or anything the suggestions miss. It matches charges by the text below, within 10% of the amount."
      >
        <NewSubscriptionForm accounts={accounts.map((a) => ({ id: a.id, name: a.name }))} />
      </Card>

      {o.cancelled.length > 0 && (
        <Card title={`Cancelled (${o.cancelled.length})`} subtitle="Kept for the record; not in the totals.">
          <SubscriptionTable rows={o.cancelled} muted />
        </Card>
      )}
    </div>
  );
}
