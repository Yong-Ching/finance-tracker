import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { redactDescription, redactForReview } from "@/lib/ai/redact";
import { sanitise, reviewEnabled } from "@/lib/ai/review";

const OLD = { ...process.env };
beforeEach(() => { process.env.FINANCE_OWNER_NAMES = "TAN WEI MING"; });
afterEach(() => { process.env = { ...OLD }; });

describe("redaction - what may leave the machine", () => {
  it("removes bank account numbers", () => {
    expect(redactDescription("Funds Transfer 123-456789-0")).toBe("Funds Transfer [account]");
  });

  it("removes card numbers and long bank references", () => {
    const out = redactDescription("Bill Payment CCC - 4111111111111111 : I-BANK REF: 12345678901234567890");
    expect(out).not.toMatch(/4111111111111111|12345678901234567890/);
  });

  it("removes PayNow transaction references", () => {
    expect(redactDescription("PAYNOW TRANSFER 1234567 TO: JOHN DOE")).toBe(
      "PAYNOW TRANSFER [ref] TO: JOHN DOE",
    );
  });

  it("removes mixed alphanumeric references and tax references", () => {
    expect(redactDescription("EPOSABCDEF12GHIJK3LM4NOP")).toBe("[ref]");
    expect(redactDescription("IRAS INCOME TAX T0000000A")).toBe("IRAS INCOME TAX [ref]");
    expect(redactDescription("QR26010500000001")).toBe("[ref]");
  });

  it("removes the owner's name", () => {
    expect(redactDescription("TO TAN WEI MING")).toBe("TO [owner]");
    expect(redactDescription("to tan wei ming")).toBe("to [owner]");
  });

  it("keeps the merchant names categorisation depends on", () => {
    const out = redactDescription("TO: NTUC FP SHENG SIONG MOOMOO BULLIONSTAR 7ELEVEN QIAN MAN 2021");
    for (const name of ["NTUC FP", "SHENG SIONG", "MOOMOO", "BULLIONSTAR", "7ELEVEN", "QIAN MAN 2021"]) {
      expect(out).toContain(name);
    }
  });

  it("never emits a run of 6+ digits, whatever the input", () => {
    const inputs = [
      "REF 123456789012345",
      "ACC 999999",
      "PAYNOW 1234567 TO: SOMEONE",
      "MIXED AB1234567890XY",
    ];
    for (const i of inputs) expect(redactDescription(i)).not.toMatch(/\d{6,}/);
  });

  it("sends no balance, account id or raw description", () => {
    const [row] = redactForReview(
      [{ txnDate: "2026-07-05", descriptionRaw: "PAYNOW TRANSFER 1234567 TO: JOHN DOE", amountCents: -75_000 }],
      "DBS",
    );
    expect(Object.keys(row).sort()).toEqual(["account", "amount", "date", "description", "ref"]);
    expect(row.description).not.toContain("1234567");
    expect(row.amount).toBe("-750.00");
  });
});

describe("review is off unless explicitly configured", () => {
  it("is disabled with no API key", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(reviewEnabled()).toBe(false);
  });

  it("is disabled when switched off even with a key", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.FINANCE_AI_REVIEW = "0";
    expect(reviewEnabled()).toBe(false);
  });

  it("is enabled with a key and no override", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    delete process.env.FINANCE_AI_REVIEW;
    expect(reviewEnabled()).toBe(true);
  });
});

describe("model output is sanitised before it is stored", () => {
  const base = { categories: [], rules: [], flags: [] };

  it("drops suggestions pointing outside the batch", () => {
    const out = sanitise(
      {
        ...base,
        categories: [
          { ref: 0, categoryName: "Food", isNewCategory: false, txnType: "expense", confidence: 1, reasoning: "x" },
          { ref: 99, categoryName: "Food", isNewCategory: false, txnType: "expense", confidence: 1, reasoning: "x" },
          { ref: -1, categoryName: "Food", isNewCategory: false, txnType: "expense", confidence: 1, reasoning: "x" },
        ],
      } as never,
      2,
    );
    expect(out.categories.map((c) => c.ref)).toEqual([0]);
  });

  it("drops rule patterns too generic to be safe", () => {
    const rule = (pattern: string) => ({
      pattern, categoryName: "Food", txnType: "expense" as const,
      matchCount: 3, confidence: 0.9, reasoning: "x",
    });
    const out = sanitise(
      { ...base, rules: [rule("PAYNOW"), rule("OTHER"), rule("Advice FAST Payment"), rule("NTUC FP"), rule("ab")] } as never,
      1,
    );
    expect(out.rules.map((r) => r.pattern)).toEqual(["NTUC FP"]);
  });

  it("drops flags pointing outside the batch", () => {
    const out = sanitise(
      { ...base, flags: [{ ref: 5, flagType: "parse", confidence: 1, reasoning: "x" }] } as never,
      2,
    );
    expect(out.flags).toEqual([]);
  });
});

describe("the API call path", () => {
  it("returns an error outcome rather than throwing when the key is rejected", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-invalid-key-for-shape-check";
    delete process.env.FINANCE_AI_REVIEW;
    const { reviewStatement } = await import("@/lib/ai/review");

    const out = await reviewStatement({
      candidates: [
        { txnDate: "2026-07-31", descriptionRaw: "PAYNOW TRANSFER 7654321 TO: FOMO PAY PTE. LTD.", amountCents: -230 },
      ],
      accountName: "DBS",
      period: { from: "2026-07-01", to: "2026-07-31" },
      categories: [{ name: "Food & groceries", bucket: "expense" }],
      existingPatterns: ["GRAB"],
    });

    // A bad key must degrade, never crash the upload.
    expect(out.status).toBe("error");
    expect(out.error).toBeTruthy();
    // And the redacted payload is still available for auditing what was attempted.
    expect(out.sent?.[0].description).not.toContain("7654321");
  }, 60_000);

  it("does nothing and sends nothing when there are no candidates", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-invalid-key-for-shape-check";
    const { reviewStatement } = await import("@/lib/ai/review");
    const out = await reviewStatement({
      candidates: [],
      accountName: "DBS",
      period: { from: null, to: null },
      categories: [],
      existingPatterns: [],
    });
    expect(out.status).toBe("ok");
    expect(out.sentCount).toBe(0);
    expect(out.sent).toEqual([]);
  });
});
