import fs from "node:fs";
import { extractRows } from "../src/lib/parsers/pdf";

async function main() {
  const file = process.argv[2];
  const rows = await extractRows(new Uint8Array(fs.readFileSync(file)));
  const from = Number(process.argv[3] ?? 0);
  const to = Number(process.argv[4] ?? 60);
  console.log(`${rows.length} rows across pages`);
  for (const r of rows.slice(from, to)) {
    const cols = r.items.map((i) => `${Math.round(i.x)}:${i.str}`).join(" | ");
    console.log(`p${r.page} y${Math.round(r.y)}  ${cols}`);
  }
}
main();
