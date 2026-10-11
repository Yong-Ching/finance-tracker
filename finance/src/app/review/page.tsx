import Link from "next/link";
import { formatCents } from "@/lib/money";
import { listSuggestions, reviewSummary, listTransactions } from "@/lib/queries";
import { SuggestionButtons, AcceptAll, RunBacklogReview } from "@/components/SuggestionActions";
import { Card, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";

const FLAG_LABEL: Record<string, string> = {
  parse: "Possible parse error",
  duplicate: "Possible duplicate",
  transfer: "Looks like an internal transfer",
};

export default async function ReviewPage() {
  const categories = listSuggestions("category");
  const rules = listSuggestions("rule");
  const flags = listSuggestions("flag");
  const { runs } = reviewSummary();
  // Rows still needing a category that have no proposal waiting on them.
  const backlog = listTransactions({ reviewOnly: true, perPage: 1 }).total;
  const awaiting = new Set(categories.map((c) => c.dedupeHash));
  const unproposed = Math.max(0, backlog - awaiting.size);
  const enabled = Boolean(process.env.ANTHROPIC_API_KEY) && process.env.FINANCE_AI_REVIEW !== "0";

  const confident = categories.filter((c) => c.confidence >= 0.8).length;
  const confidentRules = rules.filter((r) => r.confidence >= 0.8).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-[15px] font-semibold tracking-tight">Claude review</h1>
        <p className="text-[12px] text-[var(--text-muted)]">
          Proposals only. Nothing here has changed your data.
        </p>
      </div>

      {enabled && unproposed > 0 && (
        <Card
          title="Review the backlog"
          subtitle={`${unproposed} transactions have no category and no proposal waiting`}
        >
          <RunBacklogReview pendingCount={unproposed} />
          <p className="mt-2 text-[12px] text-[var(--text-muted)]">
            Runs on transactions already imported. Statements uploaded from now on are reviewed
            automatically during the upload preview.
          </p>
        </Card>
      )}

      {!enabled && (
        <Card title="Review layer is off">
          <p className="text-[13px] text-[var(--text-secondary)]">
            Set <code className="rounded bg-[var(--surface-2)] px-1">ANTHROPIC_API_KEY</code> in{" "}
            <code className="rounded bg-[var(--surface-2)] px-1">.env.local</code> to enable it. Everything
            else — parsing, rules, reconciliation — runs locally and is unaffected.
          </p>
        </Card>
      )}

      {/* What actually leaves the machine, stated plainly. */}
      <Card title="What is sent" subtitle="Two gates run before any request is made">
        <ol className="ml-4 list-decimal space-y-1 text-[13px] text-[var(--text-secondary)]">
          <li>Transactions already in the database are dropped — re-uploading never re-sends.</li>
          <li>Transactions a local rule or a manual edit already settles are dropped.</li>
          <li>
            What remains is redacted: account and card numbers, transaction references and your name
            become <code className="rounded bg-[var(--surface-2)] px-1">[account]</code>,{" "}
            <code className="rounded bg-[var(--surface-2)] px-1">[ref]</code> and{" "}
            <code className="rounded bg-[var(--surface-2)] px-1">[owner]</code>.
          </li>
        </ol>
        <p className="mt-2 text-[13px] text-[var(--text-secondary)]">
          Balances, statement files and account numbers are never sent. Merchant names and amounts are,
          because categorisation needs them.
        </p>
      </Card>

      {/* Categories ---------------------------------------------------------- */}
      <Card
        title={`Category suggestions (${categories.length})`}
        subtitle="Each applies to one transaction that no rule could place"
        action={<AcceptAll kind="category" count={confident} />}
      >
        {categories.length ? (
          <ul className="divide-y divide-[var(--border)]">
            {categories.map((c) => (
              <li key={c.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 py-2.5 text-[13px]">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span className="tnum text-[var(--text-secondary)]">{c.txnDate}</span>
                    <span className="tnum font-medium">{formatCents(c.txnAmountCents ?? 0)}</span>
                    <span className="font-medium">
                      {c.categoryName ?? c.newCategoryName}
                      {!c.categoryName && c.newCategoryName && (
                        <span className="ml-1.5 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                          new category
                        </span>
                      )}
                    </span>
                    <span className="tnum text-[11px] text-[var(--text-muted)]">
                      {Math.round(c.confidence * 100)}%
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-1 text-[12px] text-[var(--text-muted)]">{c.txnDesc}</p>
                  {c.reasoning && (
                    <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">{c.reasoning}</p>
                  )}
                </div>
                <SuggestionButtons id={c.id} />
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No category suggestions pending.</Empty>
        )}
      </Card>

      {/* Rules --------------------------------------------------------------- */}
      <Card
        title={`Rule proposals (${rules.length})`}
        subtitle="Accepting one also backfills it across existing transactions"
        action={<AcceptAll kind="rule" count={confidentRules} />}
      >
        {rules.length ? (
          <ul className="divide-y divide-[var(--border)]">
            {rules.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 py-2.5 text-[13px]">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <code className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-medium">{r.pattern}</code>
                    <span>&rarr; {r.categoryName ?? r.newCategoryName}</span>
                    <span className="text-[var(--text-secondary)]">{r.txnType?.replace("_", " ")}</span>
                    <span className="tnum text-[11px] text-[var(--text-muted)]">
                      {Math.round(r.confidence * 100)}%
                    </span>
                  </div>
                  {r.reasoning && (
                    <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">{r.reasoning}</p>
                  )}
                </div>
                <SuggestionButtons id={r.id} acceptLabel="Add rule" />
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No rule proposals pending.</Empty>
        )}
      </Card>

      {/* Flags --------------------------------------------------------------- */}
      <Card title={`Flags (${flags.length})`} subtitle="Things worth a second look before you trust the numbers">
        {flags.length ? (
          <ul className="divide-y divide-[var(--border)]">
            {flags.map((f) => (
              <li key={f.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 py-2.5 text-[13px]">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span className="font-medium text-[var(--status-warning)]">
                      {FLAG_LABEL[f.flagType ?? ""] ?? f.flagType}
                    </span>
                    <span className="tnum text-[var(--text-secondary)]">{f.txnDate}</span>
                    <span className="tnum">{formatCents(f.txnAmountCents ?? 0)}</span>
                  </div>
                  <p className="mt-0.5 line-clamp-1 text-[12px] text-[var(--text-muted)]">{f.txnDesc}</p>
                  {f.reasoning && (
                    <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">{f.reasoning}</p>
                  )}
                </div>
                <SuggestionButtons id={f.id} acceptLabel="Mark handled" />
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Nothing flagged.</Empty>
        )}
      </Card>

      {runs.length > 0 && (
        <Card title="Review runs" subtitle={`${runs.length}`}>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                <th className="py-2 font-medium">When</th>
                <th className="py-2 font-medium">Model</th>
                <th className="py-2 text-right font-medium">Sent</th>
                <th className="py-2 text-right font-medium">Skipped (already held)</th>
                <th className="py-2 text-right font-medium">Tokens</th>
                <th className="py-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="py-1.5 text-[var(--text-secondary)]">
                    {new Date(r.createdAt * 1000).toLocaleString("en-SG")}
                  </td>
                  <td className="py-1.5 text-[var(--text-secondary)]">{r.model}</td>
                  <td className="tnum py-1.5 text-right">{r.sentCount}</td>
                  <td className="tnum py-1.5 text-right text-[var(--text-muted)]">{r.skippedExistingCount}</td>
                  <td className="tnum py-1.5 text-right text-[var(--text-muted)]">
                    {r.inputTokens ?? "-"} / {r.outputTokens ?? "-"}
                  </td>
                  <td className="py-1.5">
                    {r.error ? (
                      <span className="text-[var(--status-critical)]">{r.error}</span>
                    ) : (
                      <span className="text-[var(--text-muted)]">ok</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
