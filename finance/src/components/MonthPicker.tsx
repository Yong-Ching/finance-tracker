"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** Picks one month into a query parameter, leaving the rest of the URL alone. */
export function MonthPicker({ months, value, param = "month", label = "Month" }: {
  months: string[]; value: string; param?: string; label?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const set = (v: string) => {
    const next = new URLSearchParams(params);
    next.set(param, v);
    router.push(`${pathname}?${next}`, { scroll: false });
  };

  const name = (m: string) =>
    new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-SG", { month: "short", year: "numeric", timeZone: "UTC" });

  return (
    <select
      value={value}
      onChange={(e) => set(e.target.value)}
      className="rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-[13px]"
      aria-label={label}
    >
      {[...months].reverse().map((m) => (
        <option key={m} value={m}>{name(m)}</option>
      ))}
    </select>
  );
}
