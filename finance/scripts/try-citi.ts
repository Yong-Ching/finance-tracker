import fs from "node:fs";
import { extractRows } from "../src/lib/parsers/pdf";
import { citibankParser } from "../src/lib/parsers/citibank";
import { formatCents } from "../src/lib/money";

async function main() {
  for (const file of process.argv.slice(2)) {
    const r = citibankParser.parse(await extractRows(new Uint8Array(fs.readFileSync(file))));
    const sum = r.transactions.reduce((a, t) => a + t.amountCents, 0);
    const delta = (r.openingBalanceCents ?? 0) + sum - (r.closingBalanceCents ?? 0);
    console.log(
      `${file.split("/").pop()!.padEnd(24)} ${String(r.transactions.length).padStart(3)} txns  ` +
      `open ${formatCents(r.openingBalanceCents ?? 0).padStart(10)}  close ${formatCents(r.closingBalanceCents ?? 0).padStart(10)}  ` +
      `continuity ${formatCents(delta).padStart(8)}  ${r.periodFrom}..${r.periodTo}` +
      (r.warnings.length ? `  [${r.warnings.length} warn]` : ""),
    );
    for (const w of r.warnings.slice(0, 3)) console.log(`      ! ${w}`);
  }
}
main();
