import { describe, it, expect } from "vitest";
import { dedupeHash } from "@/lib/dedupe";

const base = { accountId: 1, txnDate: "2026-07-05", amountCents: -75_000, descriptionRaw: "TO: JOHN DOE" };

describe("dedupeHash", () => {
  it("is stable across whitespace and case, which parsers vary on", () => {
    expect(dedupeHash({ ...base, descriptionRaw: "to:   john doe  " })).toBe(dedupeHash(base));
  });

  it("separates the collision the legacy date+amount key could not", () => {
    const a = { ...base, amountCents: -35_000, descriptionRaw: "TO: JANE ROE" };
    const b = { ...base, amountCents: -35_000, descriptionRaw: "TO: SOMEONE ELSE" };
    expect(dedupeHash(a)).not.toBe(dedupeHash(b));
  });

  it("distinguishes the same line on different accounts", () => {
    expect(dedupeHash({ ...base, accountId: 2 })).not.toBe(dedupeHash(base));
  });
});
