import type { PositionedRow } from "./pdf";

export interface RawTxn {
  txnDate: string; // ISO yyyy-mm-dd
  postDate?: string;
  descriptionRaw: string;
  /** Signed cents, negative = money out. Taken from the column, not inferred. */
  amountCents: number;
  balanceAfterCents?: number;
  currencyOriginal?: string;
  amountOriginalCents?: number;
  fxRate?: number;
}

export interface StatementResult {
  accountHint: string;
  periodFrom: string | null;
  periodTo: string | null;
  openingBalanceCents: number | null;
  closingBalanceCents: number | null;
  transactions: RawTxn[];
  warnings: string[];
}

export interface Parser {
  name: string;
  version: string;
  accountHint: string;
  /** 0..1 - how confident this parser is that it understands the document. */
  detect(text: string): number;
  parse(rows: PositionedRow[]): StatementResult;
}

export class ParseError extends Error {}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * "31 Jan 2026" or "January 15, 2026" -> "2026-01-31" / "2026-01-15".
 * DBS writes day first; Citibank writes month first.
 */
export function textDateToIso(s: string): string | null {
  const dayFirst = /(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/.exec(s);
  if (dayFirst) {
    const mm = MONTHS[dayFirst[2].slice(0, 3).toLowerCase()];
    if (mm) return `${dayFirst[3]}-${mm}-${dayFirst[1].padStart(2, "0")}`;
  }
  const monthFirst = /([A-Za-z]{3,})\s+(\d{1,2}),\s*(\d{4})/.exec(s);
  if (monthFirst) {
    const mm = MONTHS[monthFirst[1].slice(0, 3).toLowerCase()];
    if (mm) return `${monthFirst[3]}-${mm}-${monthFirst[2].padStart(2, "0")}`;
  }
  return null;
}

/** "05/01/2026" -> "2026-01-05" */
export function slashDateToIso(s: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
