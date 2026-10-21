import { describe, it, expect } from "vitest";
import { convert, money, moneyInColumn, originalTitle, totalCurrency, ORIGINAL_FX, type Fx } from "@/lib/fx";

// A made-up round rate: 1 SGD = 3 MYR.
const rates = { SGD: 1, MYR: 3 };
const view = (mode: string): Fx => ({ mode, perBase: rates, asOf: "2000-01-01", currencies: ["SGD", "MYR"] });

describe("showing amounts in one currency", () => {
  it("changes nothing in the original view", () => {
    expect(convert(-1000, "MYR", ORIGINAL_FX)).toEqual({ cents: -1000, currency: "MYR", approx: false });
    expect(money(-1000, "MYR", ORIGINAL_FX)).toBe("-RM10.00");
    expect(moneyInColumn(1000, "SGD", ORIGINAL_FX)).toBe("10.00");
    expect(moneyInColumn(1000, "MYR", ORIGINAL_FX)).toBe("RM10.00");
    expect(totalCurrency(ORIGINAL_FX)).toBe("SGD");
  });
  it("converts either way at the rate, and marks it rough", () => {
    expect(convert(3000, "MYR", view("SGD"))).toEqual({ cents: 1000, currency: "SGD", approx: true });
    expect(convert(1000, "SGD", view("MYR"))).toEqual({ cents: 3000, currency: "MYR", approx: true });
    expect(money(3000, "MYR", view("SGD"))).toBe("≈S$10.00");
    expect(moneyInColumn(-1000, "SGD", view("MYR"))).toBe("≈-30.00");
  });
  it("leaves an amount already in the view's currency exact", () => {
    expect(money(1000, "MYR", view("MYR"))).toBe("RM10.00");
    expect(originalTitle(1000, "MYR", view("MYR"))).toBeUndefined();
    expect(originalTitle(1000, "MYR", view("SGD"))).toBe("RM10.00 at the latest rate");
  });
  it("rounds to whole cents", () => {
    expect(convert(1001, "MYR", view("SGD")).cents).toBe(334);
  });
});
