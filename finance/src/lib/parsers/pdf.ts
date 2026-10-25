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

/**
 * `upright` turns a page printed sideways (most of its text rotated a quarter
 * turn) so that its text reads left to right: a table whose columns are
 * transactions comes out as one whose rows are. The bank-specific parsers read
 * pages as printed and leave it off.
 */
export async function extractRows(data: Uint8Array, opts: { upright?: boolean } = {}): Promise<PositionedRow[]> {
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
    let turned = 0;
    for (const raw of content.items) {
      if (!("str" in raw) || !raw.str.trim()) continue;
      const t = raw.transform as number[];
      // +1 reads bottom to top, -1 top to bottom, 0 left to right.
      const quarter = Math.abs(t[1]) > Math.abs(t[0]) ? Math.sign(t[1]) : 0;
      if (quarter) turned += quarter;
      items.push({
        str: raw.str,
        x: t[4],
        y: t[5],
        width: raw.width ?? 0,
        height: raw.height ?? 0,
      });
    }
    if (opts.upright && Math.abs(turned) > items.length / 2) {
      const dir = Math.sign(turned);
      for (const it of items) [it.x, it.y] = dir > 0 ? [it.y, -it.x] : [-it.y, it.x];
    }

    rows.push(...groupRows(p, items));
    page.cleanup();
  }

  await loadingTask.destroy();
  return rows;
}

/** Groups one page's items into rows by baseline, top of page first. */
export function groupRows(page: number, items: TextItem[]): PositionedRow[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const buckets: TextItem[][] = [];
  for (const it of sorted) {
    const last = buckets[buckets.length - 1];
    if (last && Math.abs(last[0].y - it.y) <= ROW_TOLERANCE) last.push(it);
    else buckets.push([it]);
  }
  return buckets.map((b) => {
    b.sort((a, c) => a.x - c.x);
    return {
      page,
      y: b[0].y,
      items: b,
      text: b.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim(),
    };
  });
}

/** Every row's text, for parser auto-detection. */
export const rowsToText = (rows: PositionedRow[]): string => rows.map((r) => r.text).join("\n");
