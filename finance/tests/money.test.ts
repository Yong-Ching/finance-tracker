import { describe, it, expect } from "vitest";
import { parseCents, formatCents, formatMoney, fromFloat, sumCents } from "@/lib/money";

describe("money is integer cents", () => {
  it("parses the shapes statements actually print", () => {
    expect(parseCents("750.00")).toBe(75_000);
    expect(parseCents("1,234.56")).toBe(123_456);
    expect(parseCents("-42.10")).toBe(-4_210);
    expect(parseCents("(15.00)")).toBe(-1_500); // accountancy parentheses
    expect(parseCents(" 7.10 ")).toBe(710);
  });

  it("rejects anything it cannot represent exactly", () => {
    expect(() => parseCents("")).toThrow();
    expect(() => parseCents("12.345")).toThrow();
    expect(() => parseCents("abc")).toThrow();
  });

  it("round-trips", () => {
    for (const s of ["0.00", "0.01", "9.99", "1,000.00", "12,345.67"]) {
      expect(formatCents(parseCents(s))).toBe(s);
    }
  });

  it("never produces a fractional cent", () => {
    for (let i = 0; i < 2000; i++) {
      const dollars = Math.round(Math.random() * 2_000_000) / 100;
      const c = fromFloat(dollars);
      expect(Number.isInteger(c)).toBe(true);
      expect(Number.isInteger(sumCents([c, c, -c]))).toBe(true);
    }
  });

  it("formats negatives with the sign outside the symbol", () => {
    expect(formatMoney(-123_456)).toBe("-S$1,234.56");
  });
});
