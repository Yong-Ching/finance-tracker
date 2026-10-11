import type { Rule, TxnType } from "@/db/schema";

export interface Classifiable {
  accountId: number;
  txnDate: string; // ISO yyyy-mm-dd
  amountCents: number;
  descriptionRaw: string;
}

export interface OverrideRow {
  dedupeHash: string;
  categoryId: number | null;
  txnType: TxnType | null;
  seen: boolean | null;
  note: string | null;
}

export interface Classification {
  categoryId: number | null;
  txnType: TxnType;
  seen: boolean;
  matchedRuleId: number | null;
  note: string | null;
  /** false means it lands in the review queue. */
  isReviewed: boolean;
  source: "override" | "rule" | "none";
}

function ruleMatches(rule: Rule, tx: Classifiable): boolean {
  if (!rule.active) return false;
  if (rule.accountId !== null && rule.accountId !== tx.accountId) return false;

  switch (rule.matchType) {
    case "substring":
      return tx.descriptionRaw.toUpperCase().includes(rule.pattern.toUpperCase());
    case "regex":
      try {
        return new RegExp(rule.pattern, "i").test(tx.descriptionRaw);
      } catch {
        return false; // an invalid pattern must not break the whole import
      }
    case "amountAndDay": {
      if (rule.amountCents === null || rule.dayMax === null) return false;
      if (tx.amountCents !== rule.amountCents) return false;
      const day = Number(tx.txnDate.slice(8, 10));
      return day <= rule.dayMax;
    }
    default:
      return false;
  }
}

/**
 * Classifies one transaction. First match wins:
 *   1. an override on this exact transaction  - a manual decision beats a rule
 *   2. a rule, by ascending priority
 *   3. nothing - categoryId stays null and the row goes to the review queue
 *
 * Step 3 deliberately does NOT guess. The legacy Python parser fell back to
 * "Food & groceries" for small outflows; that invented a category and is gone.
 * txnType still has to be set (the column is NOT NULL), so it falls back to the
 * direction of the amount - a fact from the statement, not a guess.
 */
export function classify(
  tx: Classifiable,
  rules: Rule[],
  override: OverrideRow | undefined,
): Classification {
  if (override) {
    return {
      categoryId: override.categoryId,
      txnType: override.txnType ?? (tx.amountCents >= 0 ? "income" : "expense"),
      seen: override.seen ?? true,
      matchedRuleId: null,
      note: override.note,
      isReviewed: true,
      source: "override",
    };
  }

  for (const rule of rules) {
    if (ruleMatches(rule, tx)) {
      return {
        categoryId: rule.categoryId,
        txnType: rule.txnType,
        seen: rule.seen,
        matchedRuleId: rule.id,
        note: null,
        isReviewed: true,
        source: "rule",
      };
    }
  }

  return {
    categoryId: null,
    txnType: tx.amountCents >= 0 ? "income" : "expense",
    seen: true,
    matchedRuleId: null,
    note: null,
    isReviewed: false,
    source: "none",
  };
}

/** Rules must be applied in priority order; call this once after loading. */
export const byPriority = (rules: Rule[]): Rule[] =>
  [...rules].sort((a, b) => a.priority - b.priority || a.id - b.id);
