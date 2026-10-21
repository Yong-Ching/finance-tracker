"use client";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { ORIGINAL, rateLine, type Fx } from "@/lib/fx";

/**
 * Original currencies, or everything in one currency at the latest rate. The
 * choice is a cookie so the server renders totals in it; nothing stored changes.
 */
export function CurrencyPicker({ fx }: { fx: Fx }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (fx.currencies.length < 2) return null;

  const choose = (v: string) => {
    document.cookie = `currency=${encodeURIComponent(v)}; path=/; max-age=31536000; samesite=lax`;
    start(() => router.refresh());
  };
  const rates = rateLine(fx);
  const title = fx.unavailable
    ? `No ${fx.unavailable} rate could be fetched, so figures are in their original currency`
    : fx.mode === ORIGINAL
      ? "Each account in its own currency; combined totals are SGD accounts only"
      : `Everything converted at the latest rate (${rates}${fx.asOf ? `, ${fx.asOf}` : ""}) - rough figures`;

  return (
    <select
      value={fx.unavailable ?? fx.mode}
      onChange={(e) => choose(e.target.value)}
      disabled={pending}
      aria-label="Currency"
      title={title}
      className={`rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-[12px] disabled:opacity-60 ${
        fx.unavailable ? "text-[var(--status-warning)]" : "text-[var(--text-secondary)]"
      }`}
    >
      <option value={ORIGINAL}>Original currency</option>
      {fx.currencies.map((c) => <option key={c} value={c}>All in {c}</option>)}
    </select>
  );
}
