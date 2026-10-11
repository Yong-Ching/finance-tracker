import fs from "node:fs";
import { extractRows } from "../src/lib/parsers/pdf";
import { dbsParser } from "../src/lib/parsers/dbs";
import { formatCents } from "../src/lib/money";

async function main() {
  for (const file of process.argv.slice(2)) {
    const rows = await extractRows(new Uint8Array(fs.readFileSync(file)));
    const r = dbsParser.parse(rows);
    const sum = r.transactions.reduce((a, t) => a + t.amountCents, 0);
    const delta = (r.openingBalanceCents ?? 0) + sum - (r.closingBalanceCents ?? 0);
    console.log(
      `${file.split("/").pop()!.padEnd(26)} ${String(r.transactions.length).padStart(3)} txns  ` +
      `open ${formatCents(r.openingBalanceCents ?? 0).padStart(10)}  ` +
      `close ${formatCents(r.closingBalanceCents ?? 0).padStart(10)}  ` +
      `continuity ${formatCents(delta)}  ${r.periodFrom}..${r.periodTo}` +
      (r.warnings.length ? `  [${r.warnings.length} warnings]` : ""),
    );
    for (const w of r.warnings.slice(0, 3)) console.log(`      ! ${w}`);
  }
}
main();
