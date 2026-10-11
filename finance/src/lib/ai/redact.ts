/**
 * Redaction applied before any transaction text leaves this machine.
 *
 * The project's standing rule is that these files are not sent to external
 * services. An API-based review cannot honour that literally, so it honours it
 * as far as it can: Claude sees merchant names and amounts - which is what
 * categorisation actually needs - and never sees the identifiers that make a
 * line traceable to an account, a card, or a person.
 */

/**
 * Names to mask wherever they appear. Configured, not inferred.
 * Read on each call rather than at module load: an import is hoisted above any
 * env assignment, which would silently disable masking depending on load order.
 */
const ownerNames = (): string[] =>
  (process.env.FINANCE_OWNER_NAMES ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);

const RULES: Array<[RegExp, string]> = [
  // Bank account numbers: 123-456789-0
  [/\b\d{3}-\d{6}-\d\b/g, "[account]"],
  // Card numbers, long transaction and I-BANK reference numbers
  [/\b\d{12,}\b/g, "[ref]"],
  // Any long alphanumeric token containing a digit: QR26010500000001,
  // EPOSABCDEF12GHIJK3LM4NOP, an IRAS tax reference like T0000000A. The
  // digit requirement keeps real trading names (MOOMOO, BULLIONSTAR) intact.
  [/\b(?=[A-Z0-9]*\d)[A-Z0-9]{8,}\b/g, "[ref]"],
  // Bare reference numbers 6+ digits (PAYNOW TRANSFER 1234567).
  // 4-5 digit runs are left alone: they are usually part of a trading name.
  [/\b\d{6,}\b/g, "[ref]"],
];

export function redactDescription(raw: string): string {
  let out = raw;
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  for (const name of ownerNames()) {
    out = out.replace(new RegExp(escapeRegex(name), "gi"), "[owner]");
  }
  return out.replace(/\s+/g, " ").trim();
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Everything about a transaction that is allowed to leave the machine.
 * Balances, account numbers, statement files and the raw description never do.
 */
export interface RedactedTxn {
  /** Local index, so suggestions can be mapped back without sending an id. */
  ref: number;
  date: string;
  description: string;
  amount: string;
  account: string;
}

export function redactForReview(
  txns: Array<{ txnDate: string; descriptionRaw: string; amountCents: number }>,
  accountName: string,
): RedactedTxn[] {
  return txns.map((t, i) => ({
    ref: i,
    date: t.txnDate,
    description: redactDescription(t.descriptionRaw),
    amount: (t.amountCents / 100).toFixed(2),
    account: accountName,
  }));
}
