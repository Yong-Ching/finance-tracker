import { z } from "zod";

/**
 * What Claude is allowed to return. Everything is a proposal - there is no
 * field here that can change an amount, a date or a balance. Those come from
 * the statement and are settled by the deterministic continuity check before
 * the review layer ever runs.
 */

export const CategorySuggestion = z.object({
  ref: z.number().int().describe("The `ref` of the transaction this concerns"),
  categoryName: z
    .string()
    .describe("An existing category name, or a new one if none fit"),
  isNewCategory: z.boolean().describe("True if categoryName is not in the provided list"),
  txnType: z.enum(["expense", "income", "savings", "debt_repayment", "internal_transfer"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().describe("One short sentence. What in the description decided it."),
});

export const RuleSuggestion = z.object({
  pattern: z
    .string()
    .describe(
      "A case-insensitive substring of the description that identifies this payee " +
        "in future statements. Must be distinctive - not a generic word like TRANSFER or PAYMENT.",
    ),
  categoryName: z.string(),
  txnType: z.enum(["expense", "income", "savings", "debt_repayment", "internal_transfer"]),
  matchCount: z.number().int().describe("How many of the supplied transactions this would match"),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

export const Flag = z.object({
  ref: z.number().int(),
  flagType: z
    .enum(["parse", "duplicate", "transfer"])
    .describe(
      "parse: the row looks mis-read (truncated text, an amount off by an order of " +
        "magnitude, a date outside the period). duplicate: near-identical to another " +
        "row and may be a double charge or a double parse. transfer: looks like a " +
        "movement between the owner's own accounts rather than spending.",
    ),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().describe("One short sentence naming the specific evidence."),
});

export const ReviewResult = z.object({
  categories: z.array(CategorySuggestion),
  rules: z.array(RuleSuggestion),
  flags: z.array(Flag),
});

export type ReviewResult = z.infer<typeof ReviewResult>;
export type CategorySuggestion = z.infer<typeof CategorySuggestion>;
export type RuleSuggestion = z.infer<typeof RuleSuggestion>;
export type Flag = z.infer<typeof Flag>;
