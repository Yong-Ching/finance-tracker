export interface Period {
  from: string; // ISO yyyy-mm-dd inclusive
  to: string;   // inclusive
  label: string;
  key: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const MONTH_LABEL = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-SG", { month: "long", year: "numeric", timeZone: "UTC" });

/** Last day of the month `ym` ("2026-07"). */
export function endOfMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return iso(new Date(Date.UTC(y, m, 0)));
}

/**
 * Resolves the ?period= query parameter against the months that actually have
 * data, so the dashboard never opens on an empty range.
 */
export function resolvePeriod(param: string | undefined, months: string[]): Period {
  const latest = months[months.length - 1];
  const earliest = months[0];
  if (!latest) {
    const today = iso(new Date());
    return { from: today, to: today, label: "No data", key: "all" };
  }

  const all: Period = {
    from: `${earliest}-01`,
    to: endOfMonth(latest),
    label: `${MONTH_LABEL(earliest)} - ${MONTH_LABEL(latest)}`,
    key: "all",
  };

  if (!param || param === "all") return all;

  if (param === "ytd") {
    const year = latest.slice(0, 4);
    return { from: `${year}-01-01`, to: endOfMonth(latest), label: `${year} to date`, key: "ytd" };
  }

  if (param === "quarter") {
    const idx = Math.max(0, months.length - 3);
    return {
      from: `${months[idx]}-01`,
      to: endOfMonth(latest),
      label: `${MONTH_LABEL(months[idx])} - ${MONTH_LABEL(latest)}`,
      key: "quarter",
    };
  }

  if (/^\d{4}-\d{2}$/.test(param)) {
    return { from: `${param}-01`, to: endOfMonth(param), label: MONTH_LABEL(param), key: param };
  }

  return all;
}

/** The equivalent window immediately before `p`, for period-on-period deltas. */
export function previousPeriod(p: Period): { from: string; to: string } {
  const from = new Date(`${p.from}T00:00:00Z`);
  const to = new Date(`${p.to}T00:00:00Z`);
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  const prevTo = new Date(from.getTime() - 86_400_000);
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86_400_000);
  return { from: iso(prevFrom), to: iso(prevTo) };
}
