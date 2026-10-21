"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { quickSearch } from "@/lib/actions";
import { formatMoney } from "@/lib/money";
import { Fig } from "@/components/Fig";

type Result = Awaited<ReturnType<typeof quickSearch>>;

/**
 * Search this period by merchant or amount, with the first matches inline.
 * Without script it is still a GET form into the Transactions page.
 */
export function QuickFind({
  from, to, initial, examples,
}: {
  from: string; to: string; initial: string; examples: string[];
}) {
  const [term, setTerm] = useState(initial);
  const [result, setResult] = useState<Result | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    const t = setTimeout(() => start(async () => setResult(await quickSearch(term, from, to))), 180);
    return () => clearTimeout(t);
  }, [term, from, to]);

  return (
    <div className="text-[14px]">
      <form
        action="/transactions"
        onSubmit={(e) => { if (result?.href) { e.preventDefault(); window.location.href = result.href; } }}
      >
        <input type="hidden" name="from" value={from} />
        <input type="hidden" name="to" value={to} />
        <input
          name="q"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          aria-label="Search this period's transactions by merchant or amount"
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded bg-[var(--surface-2)] px-2.5 py-1.5 text-[var(--text-primary)] [caret-color:var(--brand-dot)]"
        />
      </form>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {examples.map((x) => (
          <button
            key={x}
            type="button"
            onClick={() => setTerm(x)}
            className="rounded px-1.5 py-0.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
          >
            {x}
          </button>
        ))}
      </div>

      <div className={`mt-2 transition-opacity ${pending ? "opacity-60" : ""}`} aria-live="polite">
        {result && result.kind !== "empty" && (
          result.total === 0 ? (
            <p className="text-[var(--text-secondary)]">Nothing in this period matches.</p>
          ) : (
            <>
              <ul className="space-y-0.5">
                {result.rows.map((r) => (
                  <li key={r.id} className="flex items-baseline gap-2">
                    <span className="tnum shrink-0 text-[12px] text-[var(--text-muted)]">{r.txnDate.slice(5)}</span>
                    <span className="min-w-0 flex-1 truncate">{r.descriptionRaw}</span>
                    <span className="tnum shrink-0"><Fig>{formatMoney(r.amountCents, r.currency)}</Fig></span>
                  </li>
                ))}
              </ul>
              <Link href={result.href} className="mt-1.5 inline-block text-[13px] text-[var(--text-secondary)] hover:underline">
                {result.total} match{result.total === 1 ? "" : "es"},{" "}
                {result.sums.map((s, i) => (
                  <span key={s.currency}>
                    {i > 0 && " · "}<Fig>{formatMoney(Math.abs(s.cents), s.currency)}</Fig> {s.cents < 0 ? "out" : "in"}
                  </span>
                ))}{" "}
                &rarr;
              </Link>
            </>
          )
        )}
      </div>
    </div>
  );
}
