import Link from "next/link";
import { formatMoney } from "@/lib/money";

export function Card({
  title, subtitle, action, children, className = "",
}: {
  title?: string; subtitle?: string; action?: React.ReactNode;
  children: React.ReactNode; className?: string;
}) {
  return (
    <section className={`card p-4 ${className}`}>
      {(title || action) && (
        <header className="mb-3 flex items-baseline gap-3">
          <div>
            {title && <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">{subtitle}</p>}
          </div>
          {action && <div className="ml-auto">{action}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label, cents, hint, delta, tone = "neutral", href,
}: {
  label: string; cents: number; hint?: string;
  delta?: number | null; tone?: "neutral" | "warning";
  /** When given, the whole tile drills into the transactions behind it. */
  href?: string;
}) {
  const body = (
    <div className="px-4 py-3">
      <div className="text-[13px] text-[var(--text-muted)]">{label}</div>
      <div
        className={`tnum mt-1 text-[22px] font-semibold leading-none tracking-tight sm:text-[26px] ${
          tone === "warning" ? "text-[var(--status-warning)]" : ""
        }`}
      >
        {formatMoney(cents)}
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
        {delta !== undefined && delta !== null && (
          <span className="tnum">
            {delta >= 0 ? "+" : "-"}{formatMoney(Math.abs(delta))} vs prior
          </span>
        )}
        {hint && <span>{hint}</span>}
      </div>
    </div>
  );

  if (!href) return body;
  return (
    <Link
      href={href}
      className="block transition-colors hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)]"
      title="Show these transactions"
    >
      {body}
    </Link>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-[13px] text-[var(--text-muted)]">{children}</p>;
}

export function Pill({ href, children, tone = "neutral" }: {
  href: string; children: React.ReactNode; tone?: "neutral" | "warning";
}) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] hover:bg-[var(--surface-2)] ${
        tone === "warning"
          ? "border-[var(--status-warning)] text-[var(--status-warning)]"
          : "border-[var(--border)] text-[var(--text-secondary)]"
      }`}
    >
      {children}
    </Link>
  );
}
