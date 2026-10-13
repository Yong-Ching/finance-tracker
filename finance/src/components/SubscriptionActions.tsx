"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createSubscription, updateSubscription, setSubscriptionStatus, dismissCandidate, deleteSubscription,
} from "@/lib/actions";
import { formatCents, parseCents } from "@/lib/money";
import type { SubscriptionCadence } from "@/db/schema";

const CADENCES: SubscriptionCadence[] = ["weekly", "monthly", "quarterly", "yearly"];

const input =
  "rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-[13px] normal-case tracking-normal text-[var(--text-primary)]";
const label = "flex flex-col gap-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]";
const btn = "rounded px-2 py-1 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] disabled:opacity-40";
const primary = "rounded bg-[var(--text-primary)] px-2.5 py-1 text-[12px] font-medium text-[var(--surface-1)] hover:opacity-85 disabled:opacity-40";

/** "12.50" -> 1250, or null when it is not a positive amount. */
function toCents(raw: string): number | null {
  try {
    const c = parseCents(raw);
    return c > 0 ? c : null;
  } catch {
    return null;
  }
}

function useAction() {
  const [pending, start] = useTransition();
  const router = useRouter();
  const run = (fn: () => Promise<unknown>) => start(async () => { await fn(); router.refresh(); });
  return { pending, run };
}

/* ------------------------------------------------------------ candidates */

export function CandidateActions({
  pattern, accountId, amountCents, cadence, suggestedName,
}: {
  pattern: string; accountId: number; amountCents: number;
  cadence: SubscriptionCadence; suggestedName: string;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState(suggestedName);
  const { pending, run } = useAction();

  if (naming) {
    return (
      <span className="flex items-center justify-end gap-1.5">
        <input
          autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="Name"
          onKeyDown={(e) => e.key === "Escape" && setNaming(false)}
          className={`${input} w-44`}
        />
        <button
          className={primary} disabled={pending || !name.trim()}
          onClick={() => run(() => createSubscription({ name: name.trim(), pattern, accountId, amountCents, cadence }))}
        >
          Track
        </button>
        <button className={btn} onClick={() => setNaming(false)}>Cancel</button>
      </span>
    );
  }
  return (
    <span className="flex items-center justify-end gap-1">
      <button className={primary} onClick={() => setNaming(true)}>Track</button>
      <button
        className={btn} disabled={pending} title="Not a subscription - don't suggest it again"
        onClick={() => run(() => dismissCandidate({ pattern, accountId, amountCents }))}
      >
        Dismiss
      </button>
    </span>
  );
}

/* --------------------------------------------------- tracked subscriptions */

export function SubscriptionRowActions({
  id, status, name, amountCents, cadence, priceNowCents,
}: {
  id: number; status: "active" | "cancelled"; name: string; amountCents: number;
  cadence: SubscriptionCadence; priceNowCents?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name, amount: formatCents(amountCents).replace(/,/g, ""), cadence });
  const { pending, run } = useAction();
  const cents = toCents(draft.amount);

  if (editing) {
    return (
      <span className="flex flex-wrap items-center justify-end gap-1.5">
        <input
          value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          aria-label="Name" className={`${input} w-36`}
        />
        <input
          value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
          aria-label="Amount" inputMode="decimal" className={`${input} tnum w-20 text-right`}
        />
        <select
          value={draft.cadence} aria-label="Every"
          onChange={(e) => setDraft({ ...draft, cadence: e.target.value as SubscriptionCadence })}
          className={input}
        >
          {CADENCES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <button
          className={primary} disabled={pending || !draft.name.trim() || cents === null}
          onClick={() => run(async () => {
            await updateSubscription(id, { name: draft.name.trim(), amountCents: cents!, cadence: draft.cadence });
            setEditing(false);
          })}
        >
          Save
        </button>
        <button className={btn} onClick={() => setEditing(false)}>Cancel</button>
      </span>
    );
  }

  return (
    <span className="flex items-center justify-end gap-1">
      {priceNowCents !== undefined && (
        <button
          className={btn} disabled={pending} title="The latest charge differs from the amount on record"
          onClick={() => run(() => updateSubscription(id, { amountCents: priceNowCents }))}
        >
          Use S${formatCents(priceNowCents)}
        </button>
      )}
      <button className={btn} onClick={() => setEditing(true)}>Edit</button>
      {status === "active" ? (
        <button
          className={btn} disabled={pending} title="Ended - keep the record, leave the monthly total"
          onClick={() => run(() => setSubscriptionStatus(id, "cancelled"))}
        >
          Cancelled
        </button>
      ) : (
        <>
          <button className={btn} disabled={pending} onClick={() => run(() => setSubscriptionStatus(id, "active"))}>
            Reactivate
          </button>
          <button className={btn} disabled={pending} onClick={() => run(() => deleteSubscription(id))}>
            Delete
          </button>
        </>
      )}
    </span>
  );
}

/* ------------------------------------------------------------- by hand */

export function NewSubscriptionForm({ accounts }: { accounts: { id: number; name: string }[] }) {
  const [f, setF] = useState({ name: "", pattern: "", accountId: "" as number | "", amount: "", cadence: "monthly" as SubscriptionCadence });
  const { pending, run } = useAction();
  const cents = toCents(f.amount);
  const ready = f.name.trim() && f.pattern.trim() && cents !== null;

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className={label}>
        Name
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Cloud storage" className={`${input} w-44`} />
      </label>
      <label className={label}>
        Description contains
        <input value={f.pattern} onChange={(e) => setF({ ...f, pattern: e.target.value })} placeholder="as it appears on the statement" className={`${input} w-56`} />
      </label>
      <label className={label}>
        Account
        <select
          value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value ? Number(e.target.value) : "" })}
          className={input}
        >
          <option value="">Any</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </label>
      <label className={label}>
        Amount (S$)
        <input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} inputMode="decimal" placeholder="0.00" className={`${input} tnum w-24 text-right`} />
      </label>
      <label className={label}>
        Every
        <select value={f.cadence} onChange={(e) => setF({ ...f, cadence: e.target.value as SubscriptionCadence })} className={input}>
          {CADENCES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <button
        className={primary} disabled={pending || !ready}
        onClick={() => run(async () => {
          await createSubscription({
            name: f.name.trim(), pattern: f.pattern.trim(),
            accountId: f.accountId === "" ? null : f.accountId, amountCents: cents!, cadence: f.cadence,
          });
          setF({ name: "", pattern: "", accountId: "", amount: "", cadence: "monthly" });
        })}
      >
        Add
      </button>
    </div>
  );
}
