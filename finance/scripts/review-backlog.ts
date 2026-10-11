/**
 * Runs the Claude review over transactions already in the database that no rule
 * could place. The upload preview only reviews rows arriving with a new
 * statement, so this is how an existing backlog gets looked at.
 *
 *   npm run dev            # in another terminal
 *   npm run review -- 50
 *
 * Goes through the running app rather than opening the database directly, so
 * the server-only boundary around src/db/client.ts stays intact.
 */
const BASE = process.env.FINANCE_URL ?? "http://127.0.0.1:3000";

async function main() {
  const limit = Number(process.argv[2] ?? 200);
  console.log(`Reviewing up to ${limit} uncategorized transactions via ${BASE} ...`);

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit }),
    });
  } catch {
    console.error(`Could not reach ${BASE}. Start the app first: npm run dev`);
    process.exit(1);
  }

  const body = (await res.json()) as {
    sent?: number; accounts?: number; errors?: string[]; error?: string;
  };
  if (!res.ok || body.error) {
    console.error("Failed:", body.error ?? res.statusText);
    process.exit(1);
  }
  if (body.errors?.length) {
    for (const e of body.errors) console.error("  error:", e);
    process.exit(1);
  }

  console.log(`Sent ${body.sent} transactions across ${body.accounts} account(s).`);
  console.log(`Review them at ${BASE}/review — nothing is applied until you accept it.`);
}
main();
