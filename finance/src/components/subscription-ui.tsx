import type { SubscriptionRow, StatementRef } from "@/lib/queries";
import { formatMoney } from "@/lib/money";

export const EVERY = { weekly: "week", monthly: "month", quarterly: "quarter", yearly: "year" } as const;

// Every column gets breathing room on both sides; numbers sit right-aligned.
export const th = "px-3 py-2 font-medium first:pl-0 last:pr-0";
export const td = "px-3 py-2 first:pl-0 last:pr-0";
export const rowCls = "border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-2)]";
export const headRow = "border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-[var(--text-muted)]";

export function Health({ r }: { r: SubscriptionRow }) {
  const h = r.health;
  if (r.status === "cancelled") return <span className="text-[var(--text-muted)]">Cancelled</span>;
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
  if (h.kind === "price_changed") return <span>Now {formatMoney(h.nowCents)}</span>;
  return <span className="text-[var(--text-muted)]">On track</span>;
}

/** The statement a charge was read from, opening the original PDF. */
export function StatementLink({ st, compact = false }: { st?: StatementRef; compact?: boolean }) {
  if (!st) return <span className="text-[var(--text-muted)]">-</span>;
  const period = st.periodFrom && st.periodTo ? `${st.periodFrom} to ${st.periodTo}` : st.filename;
  const label = compact ? "PDF" : `${st.accountName} statement`;
  if (!st.hasFile) {
    return <span className="text-[var(--text-muted)]" title={`${st.filename} - original file not stored`}>{compact ? "-" : period}</span>;
  }
  return (
    <a
      href={`/api/statements/${st.id}`}
      target="_blank"
      rel="noopener"
      title={`Open ${st.filename} (${period})`}
      className="text-[var(--text-secondary)] underline decoration-[var(--border-strong)] underline-offset-2 hover:text-[var(--text-primary)] hover:decoration-[var(--text-primary)]"
    >
      {label}
      {!compact && <span className="tnum text-[11px] text-[var(--text-muted)]"> · {period}</span>}
    </a>
  );
}
