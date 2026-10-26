"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createHolding, updateHolding, deleteHolding, type HoldingInput } from "@/lib/actions";
import { formatCents, parseCents } from "@/lib/money";
import { ASSET_CLASSES, type AssetClass } from "@/db/schema";
import { money, originalTitle, type Fx } from "@/lib/fx";
import { Fig } from "@/components/Fig";

const input =
  "rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-[13px] normal-case tracking-normal text-[var(--text-primary)]";
const label = "flex flex-col gap-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]";
const btn = "rounded px-2 py-1 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] disabled:opacity-40";
const primary = "rounded bg-[var(--text-primary)] px-2.5 py-1 text-[12px] font-medium text-[var(--surface-1)] hover:opacity-85 disabled:opacity-40";

const today = () => new Date().toLocaleDateString("en-CA");

/** "12.50" -> 1250; "" -> null; anything unreadable or negative -> undefined. */
function toCents(raw: string): number | null | undefined {
  if (!raw.trim()) return null;
  try {
    const c = parseCents(raw);
    return c >= 0 ? c : undefined;
  } catch {
    return undefined;
  }
}

const plain = (c: number | null) => (c == null ? "" : formatCents(c).replace(/,/g, ""));

function useAction() {
  const [pending, start] = useTransition();
  const router = useRouter();
  const run = (fn: () => Promise<unknown>) => start(async () => { await fn(); router.refresh(); });
  return { pending, run };
}

interface Draft {
  name: string; source: string; assetClass: AssetClass; currency: string;
  value: string; cost: string; asOf: string;
}

const draftOf = (h?: Partial<HoldingInput>): Draft => ({
  name: h?.name ?? "", source: h?.source ?? "", assetClass: h?.assetClass ?? "stocks",
  currency: h?.currency ?? "SGD", value: plain(h?.valueCents ?? null), cost: plain(h?.costCents ?? null),
  asOf: h?.asOf ?? today(),
});

/** The draft as an action input, or null while something required is missing or unreadable. */
function parsed(d: Draft): HoldingInput | null {
  const value = toCents(d.value);
  const cost = toCents(d.cost);
  if (!d.name.trim() || !d.source.trim() || value == null || cost === undefined) return null;
  if (!/^[A-Za-z]{3}$/.test(d.currency.trim()) || !d.asOf) return null;
  return {
    name: d.name.trim(), source: d.source.trim(), assetClass: d.assetClass,
    currency: d.currency.trim().toUpperCase(), valueCents: value, costCents: cost, asOf: d.asOf,
  };
}

function Fields({ d, set, sources, currencies }: {
  d: Draft; set: (d: Draft) => void; sources: string[]; currencies: string[];
}) {
  return (
    <>
      <label className={label}>
        Source
        <input
          value={d.source} onChange={(e) => set({ ...d, source: e.target.value })}
          list="holding-sources" placeholder="e.g. Gold" className={`${input} w-36`}
        />
        <datalist id="holding-sources">{sources.map((s) => <option key={s} value={s} />)}</datalist>
      </label>
      <label className={label}>
        Holding
        <input value={d.name} onChange={(e) => set({ ...d, name: e.target.value })} placeholder="ticker, fund or item" className={`${input} w-40`} />
      </label>
      <label className={label}>
        Class
        <select value={d.assetClass} onChange={(e) => set({ ...d, assetClass: e.target.value as AssetClass })} className={input}>
          {ASSET_CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <label className={label}>
        Currency
        <input
          value={d.currency} onChange={(e) => set({ ...d, currency: e.target.value.toUpperCase() })}
          list="holding-currencies" maxLength={3} className={`${input} w-16 uppercase`}
        />
        <datalist id="holding-currencies">{currencies.map((c) => <option key={c} value={c} />)}</datalist>
      </label>
      <label className={label}>
        Value now
        <input value={d.value} onChange={(e) => set({ ...d, value: e.target.value })} inputMode="decimal" placeholder="0.00" className={`${input} tnum w-28 text-right`} />
      </label>
      <label className={label} title="What you paid in total; leave blank if you don't track it">
        Cost (optional)
        <input value={d.cost} onChange={(e) => set({ ...d, cost: e.target.value })} inputMode="decimal" placeholder="0.00" className={`${input} tnum w-28 text-right`} />
      </label>
      <label className={label}>
        Value as of
        <input type="date" value={d.asOf} onChange={(e) => set({ ...d, asOf: e.target.value })} className={`${input} tnum`} />
      </label>
    </>
  );
}

export function NewHoldingForm({ sources, currencies }: { sources: string[]; currencies: string[] }) {
  const [d, setD] = useState(draftOf());
  const { pending, run } = useAction();
  const ready = parsed(d);
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Fields d={d} set={setD} sources={sources} currencies={currencies} />
      <button
        className={primary} disabled={pending || !ready}
        onClick={() => run(async () => {
          await createHolding(ready!);
          // Keep the source and currency: holdings are usually added one platform at a time.
          setD({ ...draftOf(), source: d.source, currency: d.currency });
        })}
      >
        Add
      </button>
    </div>
  );
}

const td = "px-3 py-2 first:pl-0 last:pr-0";

/** One holding in the table; Edit opens the same fields as the add form, full width. */
export function HoldingRow({ id, holding, sources, currencies, fx }: {
  id: number; holding: HoldingInput; sources: string[]; currencies: string[]; fx: Fx;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [d, setD] = useState(draftOf(holding));
  const { pending, run } = useAction();
  const ready = parsed(d);
  const h = holding;
  const gain = h.costCents != null ? h.valueCents - h.costCents : null;

  if (editing) {
    return (
      <tr className="border-b border-[var(--border)] last:border-0">
        <td colSpan={6} className="py-3">
          <div className="flex flex-wrap items-end gap-3">
            <Fields d={d} set={setD} sources={sources} currencies={currencies} />
            <button
              className={primary} disabled={pending || !ready}
              onClick={() => run(async () => { await updateHolding(id, ready!); setEditing(false); })}
            >
              Save
            </button>
            <button className={btn} onClick={() => { setD(draftOf(holding)); setEditing(false); }}>Cancel</button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-[var(--border)] last:border-0">
      <td className={td}>
        <span className="font-medium">{h.name}</span>
        <span className="block text-[11px] text-[var(--text-muted)]">{h.source} · {h.assetClass}</span>
      </td>
      <td className={`${td} tnum text-right`} title={originalTitle(h.valueCents, h.currency, fx)}>
        <Fig>{money(h.valueCents, h.currency, fx)}</Fig>
      </td>
      <td className={`${td} tnum text-right text-[var(--text-secondary)]`}>
        {h.costCents == null ? "-" : <Fig>{money(h.costCents, h.currency, fx)}</Fig>}
      </td>
      <td className={`${td} tnum text-right text-[var(--text-secondary)]`}>
        {gain == null ? "-" : (
          <>
            <Fig>{gain >= 0 ? "+" : "-"}{money(Math.abs(gain), h.currency, fx)}</Fig>
            {h.costCents ? <span className="text-[var(--text-muted)]"> · {gain >= 0 ? "+" : ""}{Math.round((gain / h.costCents) * 1000) / 10}%</span> : null}
          </>
        )}
      </td>
      <td className={`${td} tnum text-[var(--text-secondary)]`}>{h.asOf}</td>
      <td className={td}>
        <span className="flex items-center justify-end gap-1">
          <button className={btn} onClick={() => { setD({ ...draftOf(holding), asOf: today() }); setEditing(true); }} title="Update its value">
            Edit
          </button>
          {confirming ? (
            <>
              <button className={btn} disabled={pending} onClick={() => run(() => deleteHolding(id))}>Delete it</button>
              <button className={btn} onClick={() => setConfirming(false)}>Keep</button>
            </>
          ) : (
            <button className={btn} onClick={() => setConfirming(true)}>Delete</button>
          )}
        </span>
      </td>
    </tr>
  );
}
