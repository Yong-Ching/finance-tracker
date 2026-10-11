import { formatMoney, formatCents } from "@/lib/money";
import { allAccounts, listStatements, statementCoverage, availableMonths } from "@/lib/queries";
import { Card, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function AccountsPage() {
  const accounts = allAccounts();
  const statements = listStatements();
  const months = availableMonths();

  return (
    <div className="space-y-4">
      <h1 className="text-[15px] font-semibold tracking-tight">Accounts</h1>

      <div className="grid gap-4 sm:grid-cols-2">
        {accounts.map((a) => {
          const covered = new Set(statementCoverage(a.id));
          const gaps = months.filter((m) => !covered.has(m));
          return (
            <Card key={a.id} title={a.name} subtitle={`${a.institution} · ${a.kind.replace("_", " ")}`}>
              <div className="space-y-3 text-[13px]">
                {covered.size === 0 ? (
                  <p className="text-[var(--text-secondary)]">
                    No statement uploaded.
                    {a.isPocket &&
                      " Until one is, money sent here shows as unaccounted rather than as itemised spending."}
                  </p>
                ) : (
                  <>
                    <div>
                      <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Coverage</div>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {months.map((m) => (
                          <span
                            key={m}
                            title={covered.has(m) ? `${m}: statement on file` : `${m}: no statement`}
                            className={`rounded px-1.5 py-0.5 text-[11px] ${
                              covered.has(m)
                                ? "bg-[var(--surface-2)] text-[var(--text-primary)]"
                                : "border border-dashed border-[var(--border)] text-[var(--text-muted)]"
                            }`}
                          >
                            {m.slice(5)}
                          </span>
                        ))}
                      </div>
                    </div>
                    {gaps.length > 0 && (
                      <p className="text-[12px] text-[var(--text-muted)]">
                        {gaps.length} month{gaps.length > 1 ? "s" : ""} with no statement.
                      </p>
                    )}
                  </>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      <Card title="Statements" subtitle={`${statements.length} imported`}>
        {statements.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-[13px]">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                  <th className="py-2 font-medium">Account</th>
                  <th className="py-2 font-medium">File</th>
                  <th className="py-2 font-medium">Period</th>
                  <th className="py-2 text-right font-medium">Opening</th>
                  <th className="py-2 text-right font-medium">Closing</th>
                  <th className="py-2 text-right font-medium">Txns</th>
                  <th className="py-2 font-medium">Continuity</th>
                </tr>
              </thead>
              <tbody>
                {statements.map((st) => (
                  <tr key={st.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="py-1.5">{st.accountName}</td>
                    <td className="py-1.5 text-[var(--text-secondary)]">
                      {st.filename}
                      <span className="ml-2 text-[11px] text-[var(--text-muted)]">
                        {st.parserName}@{st.parserVersion}
                      </span>
                    </td>
                    <td className="tnum whitespace-nowrap py-1.5 text-[var(--text-secondary)]">
                      {st.periodFrom} - {st.periodTo}
                    </td>
                    <td className="tnum py-1.5 text-right">{formatCents(st.openingBalanceCents ?? 0)}</td>
                    <td className="tnum py-1.5 text-right">{formatCents(st.closingBalanceCents ?? 0)}</td>
                    <td className="tnum py-1.5 text-right text-[var(--text-secondary)]">{st.txnCount}</td>
                    <td className="py-1.5">
                      {st.status === "imported" ? (
                        <span className="text-[var(--text-muted)]">balances reconcile</span>
                      ) : (
                        <span className="font-medium text-[var(--status-critical)]">
                          quarantined &middot; off by {st.continuityDelta} cents
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No statements imported yet.</Empty>
        )}
      </Card>
    </div>
  );
}
