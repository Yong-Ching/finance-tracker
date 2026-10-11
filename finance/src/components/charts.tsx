"use client";

import { useRouter } from "next/navigation";
import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { formatCents } from "@/lib/money";

const AXIS = { fill: "var(--text-muted)", fontSize: 11 };
const GRID = "var(--grid)";

const shortMonth = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-SG", { month: "short", timeZone: "UTC" });

const k = (cents: number) => {
  const v = Math.abs(cents) / 100;
  if (v >= 1000) return `${Math.round(v / 100) / 10}k`;
  return String(Math.round(v));
};

function TooltipBox({ title, rows }: { title: string; rows: Array<{ label: string; value: string; color?: string }> }) {
  return (
    <div className="card px-3 py-2 text-[12px] shadow-lg">
      <div className="mb-1 font-medium">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2">
          {r.color && <span className="h-2 w-2 rounded-[2px]" style={{ background: r.color }} />}
          <span className="text-[var(--text-secondary)]">{r.label}</span>
          <span className="tnum ml-auto pl-4 font-medium">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------- monthly, 3 series --- */

export interface MonthDatum {
  month: string;
  incomeCents: number;
  expenseCents: number;
  savingsCents: number;
}

const SERIES = [
  { key: "incomeCents", label: "Money in", color: "var(--series-1)" },
  { key: "expenseCents", label: "Expenses", color: "var(--series-2)" },
  { key: "savingsCents", label: "Savings", color: "var(--series-3)" },
] as const;

/** Last day of a "YYYY-MM", so a month bar drills into exactly that month. */
const endOfMonth = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
};

const TYPE_OF: Record<string, string> = {
  incomeCents: "income",
  expenseCents: "expense",
  savingsCents: "savings",
};

export function MonthlyBuckets({ data }: { data: MonthDatum[] }) {
  const router = useRouter();

  const go = (month: string, key: string) =>
    router.push(
      `/transactions?from=${month}-01&to=${endOfMonth(month)}&type=${TYPE_OF[key]}`,
    );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4">
        {SERIES.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
            <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -4 }} barGap={2} barCategoryGap="22%">
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="month" tickFormatter={shortMonth} tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} />
          <YAxis tickFormatter={k} tick={AXIS} tickLine={false} axisLine={false} width={56} />
          <Tooltip
            cursor={{ fill: "var(--surface-2)" }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <TooltipBox
                  title={new Date(`${label}-01T00:00:00Z`).toLocaleDateString("en-SG", {
                    month: "long", year: "numeric", timeZone: "UTC",
                  })}
                  rows={SERIES.map((s) => ({
                    label: s.label,
                    color: s.color,
                    value: formatCents((payload[0].payload as MonthDatum)[s.key]),
                  }))}
                />
              ) : null
            }
          />
          {SERIES.map((s) => (
            <Bar
              key={s.key} dataKey={s.key} fill={s.color} radius={[4, 4, 0, 0]}
              isAnimationActive={false} cursor="pointer"
              onClick={(entry: unknown) => {
                const month = (entry as { payload?: MonthDatum })?.payload?.month;
                if (month) go(month, s.key);
              }}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ------------------------------------------------------- balance, 1 line --- */

export function BalanceLine({ data }: { data: Array<{ date: string; balanceCents: number }> }) {
  const router = useRouter();
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart
        data={data}
        margin={{ top: 6, right: 8, bottom: 0, left: -4 }}
        onClick={(e: unknown) => {
          const d = (e as { activeLabel?: string })?.activeLabel;
          if (d) router.push(`/transactions?from=${d}&to=${d}`);
        }}
        style={{ cursor: "pointer" }}
      >
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis
          dataKey="date" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={40}
          tickFormatter={(d: string) =>
            new Date(`${d}T00:00:00Z`).toLocaleDateString("en-SG", { day: "numeric", month: "short", timeZone: "UTC" })}
        />
        <YAxis tickFormatter={k} tick={AXIS} tickLine={false} axisLine={false} width={56} domain={["dataMin - 20000", "dataMax + 20000"]} />
        <Tooltip
          cursor={{ stroke: "var(--border-strong)", strokeWidth: 1 }}
          content={({ active, payload, label }) =>
            active && payload?.length ? (
              <TooltipBox
                title={new Date(`${label}T00:00:00Z`).toLocaleDateString("en-SG", {
                  day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
                })}
                rows={[{ label: "Balance", value: formatCents(Number(payload[0].value)), color: "var(--series-1)" }]}
              />
            ) : null
          }
        />
        <Line
          type="monotone" dataKey="balanceCents" stroke="var(--series-1)" strokeWidth={2}
          dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface-1)" }} isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

/* --------------------------------------------- categories, one series ------ */

export interface Slice {
  name: string; totalCents: number; count: number; share: number;
  /** Where clicking this bar drills to. */
  href?: string;
}

/**
 * One series, so one colour for every bar - a value-ramp here would double-encode
 * length as hue. Bars beat a donut for comparing close values.
 */
export function CategoryBars({ data }: { data: Slice[] }) {
  const router = useRouter();
  const height = Math.max(140, data.length * 34);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 64, bottom: 0, left: 0 }}>
        <XAxis type="number" hide />
        <YAxis
          type="category" dataKey="name" tick={{ ...AXIS, fill: "var(--text-secondary)" }}
          tickLine={false} axisLine={false} width={150}
        />
        <Tooltip
          cursor={{ fill: "var(--surface-2)" }}
          content={({ active, payload }) =>
            active && payload?.length ? (
              <TooltipBox
                title={(payload[0].payload as Slice).name}
                rows={[
                  { label: "Total", value: formatCents((payload[0].payload as Slice).totalCents) },
                  { label: "Share", value: `${Math.round((payload[0].payload as Slice).share * 100)}%` },
                  { label: "Transactions", value: String((payload[0].payload as Slice).count) },
                ]}
              />
            ) : null
          }
        />
        <Bar
          dataKey="totalCents" fill="var(--series-1)" radius={[0, 4, 4, 0]} barSize={16}
          isAnimationActive={false}
          // The table beside this carries the same links for keyboard users.
          cursor={data.some((d) => d.href) ? "pointer" : undefined}
          onClick={(entry: unknown) => {
            const href = (entry as { payload?: Slice })?.payload?.href;
            if (href) router.push(href);
          }}
        >
          <LabelList
            dataKey="totalCents" position="right"
            className="tnum"
            style={{ fill: "var(--text-secondary)", fontSize: 11 }}
            formatter={(v: unknown) => formatCents(Number(v))}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
