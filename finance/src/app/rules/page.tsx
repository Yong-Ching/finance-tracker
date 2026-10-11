import { listRules, allCategories, allAccounts } from "@/lib/queries";
import { NewRuleForm, RuleRowActions } from "@/components/RuleEditor";
import { Card, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function RulesPage() {
  const rules = listRules();
  const categories = allCategories();
  const accounts = allAccounts();
  const nextPriority = (rules.at(-1)?.priority ?? 0) + 10;
  const dead = rules.filter((r) => r.hitCount === 0).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-[15px] font-semibold tracking-tight">Rules</h1>
        <p className="text-[12px] text-[var(--text-muted)]">
          Applied top to bottom; first match wins. A manual edit on a transaction always beats a rule.
        </p>
      </div>

      <Card title="Add a rule">
        <NewRuleForm categories={categories} accounts={accounts} nextPriority={nextPriority} />
      </Card>

      <Card
        title={`${rules.length} rules`}
        subtitle={dead ? `${dead} have never matched anything` : undefined}
      >
        {rules.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-[13px]">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                  <th className="py-2 font-medium">#</th>
                  <th className="py-2 font-medium">Pattern</th>
                  <th className="py-2 font-medium">Category</th>
                  <th className="py-2 font-medium">Type</th>
                  <th className="py-2 text-right font-medium">Hits</th>
                  <th className="py-2 font-medium">Last match</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr
                    key={r.id}
                    className={`border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-2)] ${
                      !r.active ? "opacity-45" : ""
                    }`}
                  >
                    <td className="tnum py-1.5 text-[var(--text-muted)]">{r.priority}</td>
                    <td className="py-1.5 font-medium">
                      {r.pattern}
                      {r.matchType !== "substring" && (
                        <span className="ml-2 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                          {r.matchType}
                        </span>
                      )}
                      {r.note && <span className="mt-0.5 block text-[11px] text-[var(--text-muted)]">{r.note}</span>}
                    </td>
                    <td className="py-1.5">{r.categoryName}</td>
                    <td className="py-1.5 text-[var(--text-secondary)]">{r.txnType.replace("_", " ")}</td>
                    <td className={`tnum py-1.5 text-right ${r.hitCount === 0 ? "text-[var(--text-muted)]" : ""}`}>
                      {r.hitCount}
                    </td>
                    <td className="tnum py-1.5 text-[var(--text-muted)]">{r.lastMatchedAt ?? "-"}</td>
                    <td className="py-1.5"><RuleRowActions id={r.id} active={r.active} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No rules yet.</Empty>
        )}
      </Card>
    </div>
  );
}
