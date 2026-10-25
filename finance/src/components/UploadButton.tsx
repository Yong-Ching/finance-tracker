"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents, formatMoney } from "@/lib/money";
import { Fig } from "@/components/Fig";

interface PreviewRow {
  txnDate: string;
  descriptionRaw: string;
  amountCents: number;
  balanceAfterCents: number | null;
  currencyOriginal: string | null;
  amountOriginalCents: number | null;
  category: string | null;
  txnType: string;
  already: boolean;
}

interface NewAccount { name: string; kind: string; currency: string }
/** Where a generically read statement goes: an existing account, or a new one. */
type Target = { accountId: number } | { newAccount: NewAccount };

interface Outcome {
  status: string;
  importable?: boolean;
  accounts?: Array<{ id: number; name: string; currency: string; kind: string }>;
  accountName?: string;
  parser?: string;
  inserted: number;
  skippedExisting: number;
  needsReview: number;
  continuityDelta: number;
  periodFrom?: string | null;
  periodTo?: string | null;
  warnings: string[];
  message?: string;
  error?: string;
  preview?: {
    currency: string;
    openingBalanceCents: number | null;
    closingBalanceCents: number | null;
    rows: PreviewRow[];
  };
  review?: {
    status: string;
    sentCount: number;
    skippedExisting: number;
    categories: number;
    rules: number;
    flags: number;
    error?: string;
  };
}

export function UploadButton() {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Outcome | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [done, setDone] = useState<Outcome | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const router = useRouter();

  async function send(f: File, dryRun: boolean, to: Target | null = target): Promise<Outcome> {
    const body = new FormData();
    body.append("file", f);
    body.append("dryRun", String(dryRun));
    if (to && "accountId" in to) body.append("accountId", String(to.accountId));
    if (to && "newAccount" in to) body.append("newAccount", JSON.stringify(to.newAccount));
    const res = await fetch("/api/upload", { method: "POST", body });
    return res.json();
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    setDone(null);
    setFile(f);
    setTarget(null);
    // Parse, check against what is already stored, and run the review - all
    // before anything is written. Nothing is committed until the user confirms.
    setPreview(await send(f, true, null));
    setBusy(false);
    e.target.value = "";
  }

  async function confirm() {
    if (!file) return;
    setBusy(true);
    const out = await send(file, false);
    setBusy(false);
    setPreview(null);
    setDone(out);
    router.refresh();
  }

  /** Re-reads the statement against the chosen account: its duplicates and rules. */
  async function choose(to: Target) {
    if (!file) return;
    setBusy(true);
    setTarget(to);
    setPreview(await send(file, true, to));
    setBusy(false);
  }

  const close = () => { setPreview(null); setFile(null); setDone(null); setTarget(null); };
  const canImport = !!preview && !preview.error && preview.importable !== false &&
    !["duplicate", "unrecognised", "needs_account"].includes(preview.status);

  return (
    <>
      <button
        onClick={() => input.current?.click()}
        disabled={busy}
        className="rounded border border-[var(--border-strong)] px-3 py-1 text-[13px] font-medium hover:bg-[var(--surface-2)] disabled:opacity-50"
      >
        {busy ? "Reading..." : "Upload statement"}
      </button>
      <input ref={input} type="file" accept="application/pdf" hidden onChange={onPick} />

      {(preview || done) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={close}>
          <div
            className={`card flex max-h-[90vh] w-full flex-col p-5 ${preview?.preview?.rows.length ? "max-w-5xl" : "max-w-lg"}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="min-h-0 overflow-y-auto pr-3">
              <Report o={(preview ?? done)!} filename={file?.name} />
              {preview?.accounts && preview.importable !== false && (
                <AccountPicker accounts={preview.accounts} target={target} busy={busy} onChoose={choose} />
              )}
              {preview?.preview && preview.preview.rows.length > 0 && <Rows p={preview.preview} />}
            </div>
            <div className="mt-5 flex shrink-0 items-center justify-end gap-2">
              {preview?.preview && (
                <span className="mr-auto text-[12px] text-[var(--text-muted)]">Nothing is saved until you import.</span>
              )}
              <button onClick={close} className="rounded px-3 py-1.5 text-[13px] hover:bg-[var(--surface-2)]">
                {done ? "Close" : "Cancel"}
              </button>
              {canImport && preview && (
                <button
                  onClick={confirm}
                  disabled={busy}
                  className="rounded bg-[var(--text-primary)] px-3 py-1.5 text-[13px] font-medium text-[var(--surface-1)] disabled:opacity-50"
                >
                  {busy ? "Importing..." : `Looks right, import ${preview.inserted} transactions`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Report({ o, filename }: { o: Outcome; filename?: string }) {
  if (o.error) {
    return (
      <>
        <h2 className="text-[15px] font-semibold">Could not read that file</h2>
        <p className="mt-2 text-[13px] text-[var(--text-secondary)]">{o.error}</p>
      </>
    );
  }

  const bad = o.status === "quarantined";
  return (
    <>
      <h2 className="text-[15px] font-semibold">
        {o.status === "duplicate"
          ? "Already imported"
          : o.status === "needs_account"
            ? "Statement read, but whose is it?"
            : o.importable === false
              ? "Could not check this statement"
          : o.status === "unrecognised"
            ? "Unrecognised statement"
            : bad
              ? "Balances do not reconcile"
              : "Statement read"}
      </h2>
      {filename && <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">{filename}</p>}

      {o.message && <p className="mt-3 text-[13px] text-[var(--text-secondary)]">{o.message}</p>}

      {o.status !== "duplicate" && o.status !== "unrecognised" && (
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
          <Row k="Account" v={o.accountName ?? "-"} />
          <Row k="Parser" v={o.parser ?? "-"} />
          <Row k="Period" v={o.periodFrom && o.periodTo ? `${o.periodFrom} to ${o.periodTo}` : "-"} />
          <Row k="Transactions" v={String(o.inserted)} />
          <Row
            k="Continuity"
            v={o.continuityDelta === 0 ? "balances reconcile" : `off by ${o.continuityDelta} cents`}
            bad={o.continuityDelta !== 0}
          />
          {o.needsReview > 0 && <Row k="Need a category" v={String(o.needsReview)} />}
        </dl>
      )}

      {o.review && (
        <div className="mt-4 rounded border border-[var(--border)] p-3">
          <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Claude review</div>
          {o.review.status === "disabled" ? (
            <p className="mt-1 text-[13px] text-[var(--text-secondary)]">
              Off — no API key configured. Parsing and rules are unaffected.
            </p>
          ) : o.review.error ? (
            <p className="mt-1 text-[13px] text-[var(--status-critical)]">{o.review.error}</p>
          ) : (
            <>
              <p className="mt-1 text-[13px] text-[var(--text-secondary)]">
                Sent <strong className="font-semibold">{o.review.sentCount}</strong> transactions —
                the ones no rule could place.{" "}
                {o.review.skippedExisting > 0 && (
                  <>
                    <strong className="font-semibold">{o.review.skippedExisting}</strong> already in the
                    database were not sent.
                  </>
                )}
              </p>
              <p className="mt-1 text-[13px]">
                {o.review.categories} category suggestions, {o.review.rules} rule proposals,{" "}
                {o.review.flags} flags — all pending your approval on the Review page.
              </p>
            </>
          )}
        </div>
      )}

      {o.warnings?.length > 0 && (
        <ul className="mt-3 space-y-1 text-[12px] text-[var(--text-muted)]">
          {o.warnings.slice(0, 5).map((w, i) => <li key={i}>! {w}</li>)}
        </ul>
      )}
    </>
  );
}

/**
 * Every row the statement produced, as it would be stored: the check before
 * anything is written. Rows already in the ledger are shown but will be skipped.
 */
function Rows({ p }: { p: NonNullable<Outcome["preview"]> }) {
  const sum = p.rows.reduce((a, r) => a + r.amountCents, 0);
  const cur = p.currency;
  return (
    <div className="mt-5">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px] text-[var(--text-muted)]">
        <span className="text-[13px] font-semibold text-[var(--text-primary)]">What will be added</span>
        <span>Check the dates, amounts and directions against the PDF. Money out is negative.</span>
      </div>
      <table className="w-full text-[13px]">
        <thead className="sticky top-0 bg-[var(--surface-1)]">
          <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
            <th className="py-1.5 pr-3 font-medium">Date</th>
            <th className="py-1.5 pr-3 font-medium">Description</th>
            <th className="py-1.5 pr-3 font-medium">Category</th>
            <th className="py-1.5 pr-3 text-right font-medium">Amount</th>
            <th className="py-1.5 text-right font-medium">Balance</th>
          </tr>
        </thead>
        <tbody>
          {p.openingBalanceCents !== null && (
            <tr className="border-t border-[var(--border)] text-[var(--text-muted)]">
              <td className="py-1 pr-3" />
              <td className="py-1 pr-3" colSpan={3}>Opening balance</td>
              <td className="tnum py-1 text-right"><Fig>{formatCents(p.openingBalanceCents)}</Fig></td>
            </tr>
          )}
          {p.rows.map((r, i) => (
            <tr key={i} className={`border-t border-[var(--border)] align-top ${r.already ? "text-[var(--text-muted)]" : ""}`}>
              <td className="tnum whitespace-nowrap py-1 pr-3">{r.txnDate}</td>
              <td className="py-1 pr-3">
                <span className="break-words">{r.descriptionRaw || <em className="text-[var(--text-muted)]">no description</em>}</span>
                {r.already && <span className="ml-2 text-[11px]">already imported, skipped</span>}
              </td>
              <td className="py-1 pr-3">
                {r.category ?? <span className="text-[var(--text-muted)]">needs a category</span>}
              </td>
              <td className="tnum whitespace-nowrap py-1 pr-3 text-right">
                <Fig>{formatCents(r.amountCents)}</Fig>
                {r.currencyOriginal && r.amountOriginalCents !== null && (
                  <div className="text-[11px] text-[var(--text-muted)]">
                    <Fig>{r.currencyOriginal} {formatCents(r.amountOriginalCents)}</Fig>
                  </div>
                )}
              </td>
              <td className="tnum whitespace-nowrap py-1 text-right text-[var(--text-secondary)]">
                {r.balanceAfterCents !== null ? <Fig>{formatCents(r.balanceAfterCents)}</Fig> : ""}
              </td>
            </tr>
          ))}
          <tr className="border-t-2 border-[var(--border-strong)] font-semibold">
            <td className="py-1.5 pr-3" />
            <td className="py-1.5 pr-3" colSpan={2}>{p.rows.length} rows, net</td>
            <td className="tnum whitespace-nowrap py-1.5 pr-3 text-right"><Fig>{formatMoney(sum, cur)}</Fig></td>
            <td className="tnum whitespace-nowrap py-1.5 text-right">
              {p.closingBalanceCents !== null && <Fig>{formatCents(p.closingBalanceCents)}</Fig>}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const KINDS: Array<[string, string]> = [["bank", "Bank account"], ["credit_card", "Credit card"], ["prepaid", "Prepaid card or e-wallet"]];

/**
 * The generic reader cannot tell whose statement it is, so the user says: one of
 * their accounts, or a new one, created only when the import commits.
 */
function AccountPicker({ accounts, target, busy, onChoose }: {
  accounts: NonNullable<Outcome["accounts"]>;
  target: Target | null;
  busy: boolean;
  onChoose: (t: Target) => void;
}) {
  const [pick, setPick] = useState<string>(
    target && "accountId" in target ? String(target.accountId) : target ? "new" : "",
  );
  const [draft, setDraft] = useState<NewAccount>(
    target && "newAccount" in target ? target.newAccount : { name: "", kind: "bank", currency: "SGD" },
  );
  const field = "rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-[13px]";
  return (
    <div className="mt-4 rounded border border-[var(--border-strong)] p-3">
      <div className="text-[13px] font-semibold">Which account is this?</div>
      <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
        No bank-specific parser knows this statement, so it was read from its table layout. Check every row below.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          className={field} value={pick} aria-label="Account" disabled={busy}
          onChange={(e) => {
            setPick(e.target.value);
            if (e.target.value && e.target.value !== "new") onChoose({ accountId: Number(e.target.value) });
          }}
        >
          <option value="" disabled>Choose an account</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
          <option value="new">New account...</option>
        </select>
        {pick === "new" && (
          <>
            <input
              className={`${field} w-40`} placeholder="Name, e.g. ACME Bank" aria-label="New account name"
              value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <select className={field} aria-label="Account type" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
              {KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
            <input
              className={`${field} w-16 uppercase`} maxLength={3} aria-label="Currency" title="Three-letter currency code"
              value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })}
            />
            <button
              disabled={busy || !draft.name.trim() || !/^[A-Z]{3}$/.test(draft.currency)}
              onClick={() => onChoose({ newAccount: { ...draft, name: draft.name.trim() } })}
              className="rounded border border-[var(--border-strong)] px-2.5 py-1 text-[13px] hover:bg-[var(--surface-2)] disabled:opacity-50"
            >
              Use this account
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const Row = ({ k, v, bad }: { k: string; v: string; bad?: boolean }) => (
  <div>
    <dt className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{k}</dt>
    <dd className={`tnum ${bad ? "font-semibold text-[var(--status-critical)]" : ""}`}>{v}</dd>
  </div>
);
