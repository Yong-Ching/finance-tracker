"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Outcome {
  status: string;
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
  const router = useRouter();

  async function send(f: File, dryRun: boolean): Promise<Outcome> {
    const body = new FormData();
    body.append("file", f);
    body.append("dryRun", String(dryRun));
    const res = await fetch("/api/upload", { method: "POST", body });
    return res.json();
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    setDone(null);
    setFile(f);
    // Parse, check against what is already stored, and run the review - all
    // before anything is written. Nothing is committed until the user confirms.
    setPreview(await send(f, true));
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

  const close = () => { setPreview(null); setFile(null); setDone(null); };

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
            className="card w-full max-w-lg p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <Report o={(preview ?? done)!} filename={file?.name} />
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={close} className="rounded px-3 py-1.5 text-[13px] hover:bg-[var(--surface-2)]">
                {done ? "Close" : "Cancel"}
              </button>
              {preview && !preview.error && preview.status !== "duplicate" && preview.status !== "unrecognised" && (
                <button
                  onClick={confirm}
                  disabled={busy}
                  className="rounded bg-[var(--text-primary)] px-3 py-1.5 text-[13px] font-medium text-[var(--surface-1)] disabled:opacity-50"
                >
                  {busy ? "Importing..." : `Import ${preview.inserted} transactions`}
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

const Row = ({ k, v, bad }: { k: string; v: string; bad?: boolean }) => (
  <div>
    <dt className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{k}</dt>
    <dd className={`tnum ${bad ? "font-semibold text-[var(--status-critical)]" : ""}`}>{v}</dd>
  </div>
);
