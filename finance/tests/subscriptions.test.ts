import { describe, it, expect } from "vitest";
import {
  merchantKey, normalise, matches, monthlyCents, nextDue, assess, detectCandidates,
  type ChargeRow,
} from "@/lib/subscriptions";

// Synthetic statement lines in the shapes the parsers produce. No real data.
let nextId = 1;
const charge = (date: string, cents: number, desc: string, accountId = 1, categoryName = "Subscriptions"): ChargeRow => ({
  id: nextId++, accountId, txnDate: date, amountCents: -cents, descriptionRaw: desc, categoryName,
});
const monthly = (desc: string, cents: number, months: string[], day = "15", accountId = 1) =>
  months.map((m) => charge(`2026-${m}-${day}`, cents, desc, accountId));

const STREAM = "STREAMCO*PREMIUM, Some Street, SG";
const PAYNOW = (ref: string) => `Advice FAST Payment / Receipt PAYNOW TRANSFER ${ref} TO: JOHN DOE PAYNOW TRANSFER OTHER`;
const asOf = new Map([[1, "2026-06-30"], [2, "2026-06-30"]]);

describe("merchant key - who was paid", () => {
  it("takes the card merchant before the location", () => {
    expect(merchantKey(STREAM)).toBe("STREAMCO*PREMIUM");
  });
  it("takes the PayNow payee after TO:, without the reference", () => {
    expect(merchantKey(PAYNOW("1234567"))).toBe("JOHN DOE");
  });
  it("takes the GIRO payee and drops the tax reference", () => {
    expect(merchantKey("GIRO Payments / Collections via GIRO IRAS INCOME TAX T0000000A")).toBe("IRAS INCOME TAX");
  });
  it("normalises away reference numbers so charges compare across months", () => {
    expect(normalise(PAYNOW("1234567"))).toBe(normalise(PAYNOW("7654321")));
  });
});

describe("matching a tracked subscription to its charges", () => {
  const sub = { pattern: "streamco*premium", accountId: 1, amountCents: 1598 };

  it("matches the merchant case-insensitively, within the amount tolerance", () => {
    expect(matches(charge("2026-03-15", 1598, STREAM), sub)).toBe(true);
    expect(matches(charge("2026-03-15", 1650, STREAM), sub)).toBe(true); // FX drift
  });
  it("keeps two plans at one merchant apart by amount", () => {
    expect(matches(charge("2026-03-15", 2998, STREAM), sub)).toBe(false);
  });
  it("respects the account, and ignores money coming in", () => {
    expect(matches(charge("2026-03-15", 1598, STREAM, 2), sub)).toBe(false);
    expect(matches({ ...charge("2026-03-15", 1598, STREAM), amountCents: 1598 }, sub)).toBe(false);
  });
});

describe("cadence arithmetic", () => {
  it("expresses every cadence per month so they can be summed", () => {
    expect(monthlyCents(1200, "monthly")).toBe(1200);
    expect(monthlyCents(12000, "yearly")).toBe(1000);
    expect(monthlyCents(3000, "quarterly")).toBe(1000);
    expect(monthlyCents(1000, "weekly")).toBe(4333);
  });
  it("keeps the billing day, clamping the 31st to a short month", () => {
    expect(nextDue("2026-01-15", "monthly")).toBe("2026-02-15");
    expect(nextDue("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(nextDue("2026-03-10", "yearly")).toBe("2027-03-10");
  });
});

describe("is it still running?", () => {
  const sub = { pattern: "STREAMCO*PREMIUM", accountId: 1, amountCents: 1598, cadence: "monthly" as const };

  it("is on track when the next charge is not yet due by the statement end", () => {
    const st = assess(sub, monthly(STREAM, 1598, ["03", "04", "05", "06"]), "2026-06-30");
    expect(st.health.kind).toBe("on_track");
    expect(st.nextDue).toBe("2026-07-15");
  });
  it("judges lateness against the statement, not the calendar", () => {
    // Last statement ends 30 June; a June charge is fine even if read in August.
    const st = assess(sub, monthly(STREAM, 1598, ["04", "05", "06"]), "2026-06-30");
    expect(st.health.kind).toBe("on_track");
  });
  it("flags a subscription with no charge for well over a cycle", () => {
    const st = assess(sub, monthly(STREAM, 1598, ["01", "02", "03"]), "2026-06-30");
    expect(st.health).toMatchObject({ kind: "overdue" });
  });
  it("notices a price change within tolerance", () => {
    const st = assess(sub, [...monthly(STREAM, 1598, ["04", "05"]), charge("2026-06-15", 1698, STREAM)], "2026-06-30");
    expect(st.health).toEqual({ kind: "price_changed", nowCents: 1698 });
  });
  it("reports a subscription that matches nothing", () => {
    expect(assess(sub, [], "2026-06-30").health.kind).toBe("no_charges");
  });
});

describe("detecting candidates", () => {
  const months = ["02", "03", "04", "05", "06"];

  it("proposes each plan at a shared merchant separately", () => {
    const rows = [...monthly(STREAM, 398, months), ...monthly(STREAM, 2998, months, "02")];
    const c = detectCandidates(rows, [], asOf);
    expect(c.map((x) => x.amountCents).sort((a, b) => a - b)).toEqual([398, 2998]);
    expect(c.every((x) => x.cadence === "monthly" && x.pattern === "STREAMCO*PREMIUM")).toBe(true);
  });

  it("ignores spending that is frequent but irregular", () => {
    const rows = ["2026-02-01", "2026-02-03", "2026-03-20", "2026-05-02", "2026-05-04"].map((d) =>
      charge(d, 450, "HAWKER STALL, Somewhere", 1, "Food & groceries"));
    expect(detectCandidates(rows, [], asOf)).toEqual([]);
  });

  it("ignores a habit that recurs in only some weeks", () => {
    // Weekly-looking median gap, but present in about one week in three.
    const dates = ["01-05", "01-12", "01-19", "02-23", "03-02", "03-09", "04-13", "04-20", "05-25", "06-01", "06-08", "06-29"];
    const rows = dates.map((d) => charge(`2026-${d}`, 320, "SOME BAKERY PTE. LTD.", 1, "Food & groceries"));
    expect(detectCandidates(rows, [], asOf)).toEqual([]);
  });

  it("keeps a real plan whose billing day drifts", () => {
    const rows = ["2026-01-02", "2026-02-01", "2026-03-17", "2026-04-12", "2026-05-02", "2026-06-19"].map((d) => charge(d, 2998, STREAM));
    expect(detectCandidates(rows, [], asOf)).toHaveLength(1);
  });

  it("needs three charges in three different months", () => {
    expect(detectCandidates(monthly(STREAM, 1598, ["05", "06"]), [], asOf)).toEqual([]);
  });

  it("drops one that has lapsed by the statement end", () => {
    expect(detectCandidates(monthly(STREAM, 1598, ["01", "02", "03"]), [], asOf)).toEqual([]);
  });

  it("never re-proposes something tracked or dismissed", () => {
    const rows = monthly(STREAM, 1598, months);
    const known = [{ pattern: "STREAMCO*PREMIUM", accountId: 1, amountCents: 1598 }];
    expect(detectCandidates(rows, known, asOf)).toEqual([]);
  });

  it("finds a monthly PayNow despite a new reference every time", () => {
    const rows = months.map((m, i) => charge(`2026-${m}-03`, 75_000, PAYNOW(String(1000000 + i)), 1, "Rent"));
    const [c] = detectCandidates(rows, [], asOf);
    expect(c).toMatchObject({ pattern: "JOHN DOE", amountCents: 75_000, count: 5, categoryName: "Rent" });
  });
});
