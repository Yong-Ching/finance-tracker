// No "server-only" guard here: this module is reached from ingest.ts, which
// the CLI import scripts use. It is server code by nature - it reads the API
// key - and is only ever imported from server components, actions and scripts.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ReviewResult } from "./schema";
import { redactForReview, type RedactedTxn } from "./redact";

const MODEL = "claude-opus-5";

export interface ReviewInput {
  /** Only transactions no rule matched AND not already in the database. */
  candidates: Array<{ txnDate: string; descriptionRaw: string; amountCents: number }>;
  accountName: string;
  period: { from: string | null; to: string | null };
  categories: Array<{ name: string; bucket: string }>;
  existingPatterns: string[];
}

export interface ReviewOutcome {
  status: "ok" | "disabled" | "error";
  model: string;
  sentCount: number;
  result?: ReviewResult;
  /** Exactly what left the machine, so the user can audit it. */
  sent?: RedactedTxn[];
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

/** The review layer is off unless a key is present and it is not disabled. */
export function reviewEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY) && process.env.FINANCE_AI_REVIEW !== "0";
}

const SYSTEM = `You are reviewing bank statement transactions for a personal finance tracker in Singapore.

The tracker's parser has already read the statement and verified that its balances reconcile
exactly. Amounts, dates and balances are settled facts - you are not asked to correct them and
you cannot change them. Your job is to help with the part regular expressions cannot do.

Three tasks:

1. CATEGORIES. For each transaction, suggest the budget category. Prefer a category from the
   supplied list. Only propose a new one when nothing in the list is a reasonable fit, and then
   keep the name short and general enough to recur.

2. RULES. Where a payee will plainly recur, propose a substring rule that would catch it next
   month. The pattern must be distinctive to that payee - never a generic fragment like
   "PAYNOW TRANSFER", "OTHER" or "Advice FAST Payment", which appear on almost every line.
   Do not propose a pattern already in the existing list.

3. FLAGS. Raise a flag only where you have specific evidence:
   - parse: the description looks truncated mid-word, or the amount is implausible for the
     described merchant by an order of magnitude, or the date falls outside the statement period.
   - duplicate: two rows are near-identical in date, amount and payee.
   - transfer: the line looks like money moving to another account the owner holds (a card
     payment, a wallet top-up, a transfer to a brokerage or a second bank), rather than a
     purchase from a third party.

Context you should use:
- Currency is SGD. Singapore hawker and kopitiam names are common and are food.
- "PAYNOW TRANSFER TO: <a person's name>" for a small amount is usually a shared meal or
  settling up between friends, not a merchant purchase.
- Identifiers have been redacted to [ref], [account] and [owner]. Their absence is expected
  and is never evidence of a parse problem.

Be conservative. A wrong category quietly corrupts a year of totals, and an unhelpful flag
costs the user attention. Where a line is genuinely ambiguous, say so in the reasoning and
give it a low confidence rather than guessing confidently.`;

export async function reviewStatement(input: ReviewInput): Promise<ReviewOutcome> {
  if (!reviewEnabled()) {
    return { status: "disabled", model: MODEL, sentCount: 0 };
  }
  if (!input.candidates.length) {
    return { status: "ok", model: MODEL, sentCount: 0, sent: [], result: { categories: [], rules: [], flags: [] } };
  }

  const sent = redactForReview(input.candidates, input.accountName);
  const client = new Anthropic();

  const userContent = [
    `Account: ${input.accountName}`,
    `Statement period: ${input.period.from ?? "?"} to ${input.period.to ?? "?"}`,
    "",
    "Existing categories (name — bucket):",
    ...input.categories.map((c) => `  ${c.name} — ${c.bucket}`),
    "",
    "Existing rule patterns (do not propose these again):",
    input.existingPatterns.length ? input.existingPatterns.map((p) => `  ${p}`).join("\n") : "  (none)",
    "",
    `Transactions needing review (${sent.length}). Negative amounts are money out:`,
    JSON.stringify(sent, null, 1),
  ].join("\n");

  try {
    // Streaming: the response can be long for a big statement, and a
    // non-streaming request at this max_tokens risks an HTTP timeout.
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "medium",
        format: zodOutputFormat(ReviewResult),
      },
      system: SYSTEM,
      messages: [{ role: "user", content: userContent }],
    });
    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      return {
        status: "error",
        model: MODEL,
        sentCount: sent.length,
        sent,
        error: `Request declined (${message.stop_details?.category ?? "unspecified"}).`,
      };
    }

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = ReviewResult.safeParse(JSON.parse(text));
    if (!parsed.success) {
      return { status: "error", model: MODEL, sentCount: sent.length, sent, error: "Response did not match the expected shape." };
    }

    return {
      status: "ok",
      model: MODEL,
      sentCount: sent.length,
      sent,
      result: sanitise(parsed.data, sent.length),
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return { status: "error", model: MODEL, sentCount: sent.length, sent, error: "ANTHROPIC_API_KEY was rejected." };
    }
    if (err instanceof Anthropic.RateLimitError) {
      return { status: "error", model: MODEL, sentCount: sent.length, sent, error: "Rate limited - try the review again shortly." };
    }
    if (err instanceof Anthropic.APIError) {
      return { status: "error", model: MODEL, sentCount: sent.length, sent, error: `API error ${err.status}: ${err.message}` };
    }
    return { status: "error", model: MODEL, sentCount: sent.length, sent, error: String(err) };
  }
}

/** Drop anything that points outside the batch or is too generic to be a rule. */
export function sanitise(r: ReviewResult, count: number): ReviewResult {
  const inRange = (ref: number) => Number.isInteger(ref) && ref >= 0 && ref < count;
  const TOO_GENERIC =
    /^(payment|transfer|paynow|other|advice|fast|giro|receipt|payments|bill payment|advice fast payment)$/i;

  return {
    categories: r.categories.filter((c) => inRange(c.ref)),
    flags: r.flags.filter((f) => inRange(f.ref)),
    rules: r.rules.filter(
      (rule) => rule.pattern.trim().length >= 4 && !TOO_GENERIC.test(rule.pattern.trim()),
    ),
  };
}
