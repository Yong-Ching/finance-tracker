import { describe, it, expect } from "vitest";
import { classify, byPriority } from "@/lib/classify";
import type { Rule } from "@/db/schema";

const rule = (over: Partial<Rule>): Rule => ({
  id: 1, pattern: "GRAB", matchType: "substring", accountId: null, categoryId: 7,
  txnType: "expense", seen: true, priority: 10, active: true,
  amountCents: null, dayMax: null, note: null, hitCount: 0, lastMatchedAt: null,
  ...over,
} as Rule);

const tx = (desc: string, amount = -1000, date = "2026-07-05") => ({
  accountId: 1, txnDate: date, amountCents: amount, descriptionRaw: desc,
});

describe("classification", () => {
  it("does not guess a category when nothing matches", () => {
    const c = classify(tx("SOME HAWKER STALL PTE LTD"), [], undefined);
    expect(c.categoryId).toBeNull();
    expect(c.isReviewed).toBe(false);   // lands in the review queue
    expect(c.source).toBe("none");
  });

  it("still records direction, which is a fact rather than a guess", () => {
    expect(classify(tx("X", -500), [], undefined).txnType).toBe("expense");
    expect(classify(tx("X", 500), [], undefined).txnType).toBe("income");
  });

  it("takes the first matching rule by priority", () => {
    const rules = byPriority([
      rule({ id: 2, pattern: "GRAB", categoryId: 99, priority: 20 }),
      rule({ id: 1, pattern: "GRAB", categoryId: 7, priority: 10 }),
    ]);
    expect(classify(tx("GRAB SINGAPORE"), rules, undefined).categoryId).toBe(7);
  });

  it("matches case-insensitively on a substring", () => {
    expect(classify(tx("payment to grab holdings"), [rule({})], undefined).categoryId).toBe(7);
  });

  it("honours account scope", () => {
    const scoped = [rule({ accountId: 2 })];
    expect(classify(tx("GRAB"), scoped, undefined).categoryId).toBeNull();
  });

  it("skips inactive rules", () => {
    expect(classify(tx("GRAB"), [rule({ active: false })], undefined).categoryId).toBeNull();
  });

  it("matches rent by amount and day, since the payee name changes", () => {
    const rent = [rule({ matchType: "amountAndDay", amountCents: -75_000, dayMax: 8, categoryId: 3 })];
    expect(classify(tx("ANY NEW LANDLORD", -75_000, "2026-07-05"), rent, undefined).categoryId).toBe(3);
    // same amount, too late in the month
    expect(classify(tx("ANY NEW LANDLORD", -75_000, "2026-07-20"), rent, undefined).categoryId).toBeNull();
  });

  it("lets a manual override beat every rule", () => {
    const c = classify(tx("GRAB"), [rule({})], {
      dedupeHash: "h", categoryId: 42, txnType: "savings", seen: true, note: "actually a transfer",
    });
    expect(c.categoryId).toBe(42);
    expect(c.source).toBe("override");
  });

  it("survives an invalid regex rule instead of failing the import", () => {
    expect(() => classify(tx("X"), [rule({ matchType: "regex", pattern: "([" })], undefined)).not.toThrow();
  });
});
