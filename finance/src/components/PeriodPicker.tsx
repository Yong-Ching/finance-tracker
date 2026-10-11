"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export function PeriodPicker({ months, value }: { months: string[]; value: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const set = (v: string) => {
    const next = new URLSearchParams(params);
    if (v === "all") next.delete("period");
    else next.set("period", v);
    router.push(`${pathname}?${next}`);
  };

  const label = (m: string) =>
    new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-SG", { month: "short", year: "numeric", timeZone: "UTC" });

  return (
    <select
      value={value}
      onChange={(e) => set(e.target.value)}
      className="rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-[13px]"
      aria-label="Period"
    >
      <option value="all">All time</option>
      <option value="ytd">Year to date</option>
      <option value="quarter">Last 3 months</option>
      <optgroup label="Month">
        {[...months].reverse().map((m) => (
          <option key={m} value={m}>{label(m)}</option>
        ))}
      </optgroup>
    </select>
  );
}
