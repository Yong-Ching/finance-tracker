/**
 * Text extraction that preserves layout.
 *
 * A bank statement is a table. The plain text layer of a PDF flattens it, which
 * is why the previous Python tool had to infer money-in vs money-out from the
 * running balance rising or falling - a trick that only works on statements
 * that print a running balance, and so cannot parse a credit-card statement.
 *
 * pdfjs exposes each text item's transform matrix, so rows can be rebuilt from
 * y-positions and columns from x-positions. Direction then comes from which
 * column the amount sits in: what the statement actually says.
 */

export interface TextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PositionedRow {
  page: number;
  y: number;
  items: TextItem[];
  /** All items joined by a single space, in x order. */
  text: string;
}

/** Items whose baselines are within this many points count as the same row. */
const ROW_TOLERANCE = 2.5;

export async function extractRows(data: Uint8Array): Promise<PositionedRow[]> {
  // The legacy build is the one that runs without a DOM.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    // pdf.js takes ownership of the array it is handed and detaches the
    // underlying buffer, so give it a copy - the caller still needs the bytes
    // to archive the file after parsing.
    data: new Uint8Array(data),
    useSystemFonts: true,
  });
  const doc = await loadingTask.promise;

  const rows: PositionedRow[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();

    const items: TextItem[] = [];
    for (const raw of content.items) {
      if (!("str" in raw) || !raw.str.trim()) continue;
      const t = raw.transform as number[];
      items.push({
        str: raw.str,
        x: t[4],
        y: t[5],
        width: raw.width ?? 0,
        height: raw.height ?? 0,
      });
    }

    // Group by baseline, top of page first.
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const buckets: TextItem[][] = [];
    for (const it of items) {
      const last = buckets[buckets.length - 1];
      if (last && Math.abs(last[0].y - it.y) <= ROW_TOLERANCE) last.push(it);
      else buckets.push([it]);
    }

    for (const b of buckets) {
      b.sort((a, c) => a.x - c.x);
      rows.push({
        page: p,
        y: b[0].y,
        items: b,
        text: b.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim(),
      });
    }
    page.cleanup();
  }

  await loadingTask.destroy();
  return rows;
}

/** Every row's text, for parser auto-detection. */
export const rowsToText = (rows: PositionedRow[]): string => rows.map((r) => r.text).join("\n");
