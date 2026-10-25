import { describe, it, expect } from "vitest";
import type { PositionedRow, TextItem } from "@/lib/parsers/pdf";
import { parseGeneric } from "@/lib/parsers/generic";

/**
 * Synthetic statements, laid out the way PDFs position text: each row is a list
 * of [text, x] at a baseline y. Nothing here is from a real statement.
 */
type Cell = [string, number];
function page(lines: Array<[number, Cell[]]>, p = 1): PositionedRow[] {
  return lines.map(([y, cells]) => {
    const items: TextItem[] = cells.map(([str, x]) => ({ str, x, y, width: str.length * 5, height: 8 }));
    return { page: p, y, items, text: items.map((i) => i.str).join(" ") };
  });
}
const net = (r: ReturnType<typeof parseGeneric>) =>
  r.openingBalanceCents! + r.transactions.reduce((a, t) => a + t.amountCents, 0) - r.closingBalanceCents!;

describe("generic statement reader", () => {
  it("reads direction from withdrawal and deposit columns", () => {
    const r = parseGeneric(page([
      [700, [["Date", 40], ["Description", 120], ["Withdrawal", 330], ["Deposit", 420], ["Balance", 510]]],
      [680, [["Balance Brought Forward", 120], ["1,000.00", 505]]],
      [660, [["01/01/2000", 40], ["ACME RESTAURANT", 120], ["25.00", 335], ["975.00", 510]]],
      [648, [["CARD 0000", 120]]],
      [630, [["02/01/2000", 40], ["SALARY ACME PTE LTD", 120], ["500.00", 425], ["1,475.00", 505]]],
      [610, [["Balance Carried Forward", 120], ["1,475.00", 505]]],
    ]));
    expect(r.transactions.map((t) => [t.txnDate, t.amountCents, t.descriptionRaw])).toEqual([
      ["2000-01-01", -2500, "ACME RESTAURANT CARD 0000"],
      ["2000-01-02", 50000, "SALARY ACME PTE LTD"],
    ]);
    expect(r.openingBalanceCents).toBe(100000);
    expect(net(r)).toBe(0);
  });

  it("reads a card: unsigned is a purchase, parentheses a credit, balances owed", () => {
    const r = parseGeneric(page([
      [720, [["Statement Date", 40], ["15 Jan 2000", 200]]],
      [700, [["DATE", 40], ["DESCRIPTION", 120], ["AMOUNT (SGD)", 480]]],
      [680, [["BALANCE PREVIOUS STATEMENT", 120], ["100.00", 500]]],
      [660, [["20 DEC", 40], ["PAYMENT THANK YOU", 120], ["(100.00)", 495]]],
      [640, [["05 JAN", 40], ["ACME BOOKS", 120], ["30.00", 505]]],
      [620, [["GRAND TOTAL", 120], ["30.00", 505]]],
    ]));
    expect(r.transactions.map((t) => [t.txnDate, t.amountCents])).toEqual([
      ["1999-12-20", 10000],
      ["2000-01-05", -3000],
    ]);
    expect(r.openingBalanceCents).toBe(-10000);
    expect(r.closingBalanceCents).toBe(-3000);
    expect(net(r)).toBe(0);
  });

  it("reads a signed amount column (trailing - and +)", () => {
    const r = parseGeneric(page([
      [700, [["ENTRY DATE", 40], ["TRANSACTION DESCRIPTION", 120], ["TRANSACTION AMOUNT", 320], ["STATEMENT BALANCE", 420]]],
      [680, [["BEGINNING BALANCE", 120], ["200.00", 440]]],
      [660, [["01/01/00", 40], ["SALE DEBIT", 120], ["20.00-", 360], ["180.00", 440]]],
      [640, [["02/01/00", 40], ["TRANSFER IN", 120], ["5.00+", 365], ["185.00", 440]]],
      [620, [["ENDING BALANCE", 120], ["185.00", 440]]],
    ]));
    expect(r.transactions.map((t) => t.amountCents)).toEqual([-2000, 500]);
    expect(net(r)).toBe(0);
  });

  it("infers direction from the running balance when nothing marks it", () => {
    const r = parseGeneric(page([
      [700, [["Date", 40], ["Description", 120], ["Amount", 400], ["Balance", 500]]],
      [680, [["1/1/2000", 40], ["Top up", 120], ["10.00", 400], ["10.00", 500]]],
      [660, [["2/1/2000", 40], ["Payment ACME", 120], ["4.00", 400], ["6.00", 500]]],
      [640, [["3/1/2000", 40], ["Failed attempt", 120], ["9.00", 400], ["6.00", 500]]],
    ]));
    expect(r.transactions.map((t) => t.amountCents)).toEqual([1000, -400]);
    expect(r.openingBalanceCents).toBe(0);
    expect(r.warnings.some((w) => /did not move/.test(w))).toBe(true);
  });

  it("gives a line printed above its date to the transaction below it", () => {
    const r = parseGeneric(page([
      [700, [["Date", 40], ["Description", 140], ["Money Out", 360], ["Money In", 440], ["Balance", 520]]],
      [680, [["1 Jan 2000", 40], ["Opening Balance", 140], ["50.00", 520]]],
      [646, [["ACME STORE", 140]]],
      [640, [["2 Jan 2000", 40]]],
      [637, [["10.00", 370], ["40.00", 520]]],
      [628, [["9:00 AM", 40]]],
      [600, [["3 Jan 2000", 40], ["BUS TOTAL FARE", 140], ["1.00", 375], ["39.00", 520]]],
      [570, [["31 Jan 2000", 40], ["Closing Balance", 140], ["39.00", 520]]],
    ]));
    expect(r.transactions.map((t) => [t.descriptionRaw, t.amountCents])).toEqual([
      ["ACME STORE", -1000],
      ["BUS TOTAL FARE", -100],
    ]);
    expect(net(r)).toBe(0);
  });

  it("stops at a second section with a different header", () => {
    const rows = [
      ...page([
        [700, [["Date", 40], ["Description", 120], ["Amount", 400], ["Wallet Balance", 480]]],
        [680, [["1/1/2000", 40], ["Top up", 120], ["10.00", 400], ["10.00", 500]]],
      ]),
      ...page([
        [700, [["Date", 40], ["Description", 120], ["Amount", 400], ["Fund Balance", 480]]],
        [680, [["1/1/2000", 40], ["Fund in", 120], ["10.00", 400], ["10.00", 500]]],
      ], 2),
    ];
    const r = parseGeneric(rows);
    expect(r.transactions).toHaveLength(1);
    expect(r.warnings.some((w) => /another section/.test(w))).toBe(true);
  });

  it("refuses a document with no transaction table", () => {
    expect(() => parseGeneric(page([[700, [["Dear customer", 40]]]]))).toThrow(/no transaction table/);
  });
});
