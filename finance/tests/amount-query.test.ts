import { describe, it, expect } from "vitest";
import { parseAmountQuery as p } from "@/lib/amount-query";

describe("amount search expressions", () => {
  it("an exact amount, in either direction", () => {
    expect(p("3.98")).toEqual({ minCents: 398, maxCents: 398 });
    expect(p("750")).toEqual({ minCents: 75_000, maxCents: 75_000 });
  });

  it("ignores currency symbols, commas and spaces", () => {
    expect(p(" S$1,250.00 ")).toEqual({ minCents: 125_000, maxCents: 125_000 });
    expect(p("$ 12.5")).toEqual({ minCents: 1250, maxCents: 1250 });
  });

  it("a range, in any of three spellings, in either order", () => {
    const r = { minCents: 1000, maxCents: 5000 };
    expect(p("10-50")).toEqual(r);
    expect(p("10 to 50")).toEqual(r);
    expect(p("10..50")).toEqual(r);
    expect(p("50-10")).toEqual(r);
  });

  it("comparisons, strict and inclusive", () => {
    expect(p(">100")).toEqual({ minCents: 10_001 });
    expect(p(">=100")).toEqual({ minCents: 10_000 });
    expect(p("<5")).toEqual({ maxCents: 499 });
    expect(p("<=5")).toEqual({ maxCents: 500 });
  });

  it("roughly an amount: within 10%, never under 50 cents", () => {
    expect(p("~30")).toEqual({ minCents: 2700, maxCents: 3300 });
    expect(p("~2")).toEqual({ minCents: 150, maxCents: 250 });
  });

  it("a leading sign picks a direction and combines with every form", () => {
    expect(p("-3.98")).toEqual({ minCents: 398, maxCents: 398, direction: "out" });
    expect(p("+3.98")).toEqual({ minCents: 398, maxCents: 398, direction: "in" });
    expect(p("-10-50")).toEqual({ minCents: 1000, maxCents: 5000, direction: "out" });
    expect(p("+>1000")).toEqual({ minCents: 100_001, direction: "in" });
    expect(p("-~30")).toEqual({ minCents: 2700, maxCents: 3300, direction: "out" });
  });

  it("refuses what is not an amount, rather than guessing", () => {
    for (const bad of ["", "abc", "12.345", "1-2-3", ">", "~", "--5", "10-", "S$"]) {
      expect(p(bad), bad).toBeNull();
    }
  });
});
