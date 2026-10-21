# Finance

Personal finance across DBS, CPF, YouTrip, Citibank, Maybank and Touch 'n Go, from PDF statements.
Runs locally; nothing is uploaded anywhere.

    npm run dev        # http://127.0.0.1:3000

Or double-click **finance-tracker** on the Desktop: `../desktop` wraps this app in
Electron and rebuilds it on launch whenever something here has changed. See
`../desktop/README.md`.

## The monthly loop

1. **Upload statement** in the header, drop the PDF.
2. Read the parse report - account, period, transaction count, and whether the
   balances reconcile - then confirm. Nothing is written until you do.
3. Clear the review queue on **Transactions** (`Needs review` filter). When a
   payee will recur, add a rule and backfill it.
4. Confirm any proposed matches on **Reconcile**.

Or skip most of step 3: connect an AI assistant over MCP (below) and ask it to
group the review queue by merchant and file it.

## The rules that keep the numbers honest

**Money is integer cents.** No float ever touches a ledger total.

**A statement whose balances do not reconcile is quarantined.** The gate is
`opening + sum(amounts) == closing`, exactly. A quarantined statement is stored
and visible on **Accounts**, but excluded from every total - the dashboard is
never quietly wrong.

**Nothing is ever guessed.** An unmatched transaction gets no category and lands
in the review queue. (The predecessor guessed "Food & groceries" for small
payments; that is gone, which is why the unclassified pile looks large at first.)

**Transfers between your own accounts are not spending.** A DBS payment to
YouTrip or the Citibank card, or a Maybank top-up of the Touch 'n Go wallet, is
an `internal_transfer` and never enters the expense total. Its contents arrive
with that pocket's own statement, and **Reconcile** links the two. Until that
link exists the money is reported as *unaccounted* - never as spending, never
as accounted-for. A transfer across currencies (DBS to Maybank) is linked by
hand: its two sides are in different currencies, so amounts cannot match.

**Currencies never mix.** Each account has a currency. Combined totals are the
SGD accounts only; a ringgit account is totalled on its own, in RM. No exchange
rate is ever applied, so no figure is an estimate. (`BASE_CURRENCY` in
`src/lib/queries.ts`.)

**A category decides how a transaction counts.** Choosing an expense, income
or savings category sets the type to match, so money back into a spending
category - a refund, a friend repaying - nets that spending down rather than
counting as income. Category totals keep their sign. **Paid for friends** works
this way: the outlay and the repayment cancel, leaving what is still owed.

**A manual edit outlives the statement it came from.** Edits are stored against
a content hash of the transaction, so deleting and re-importing a statement
preserves them. A manual decision always beats a rule. A remark (the note on a
transaction) travels the same way, but on its own it does not take a row out
of the review queue - only a category does.

## The Claude review layer (optional, off by default)

The parse -> continuity -> classify pipeline is **fully deterministic and always
will be**. The review layer sits beside it and only proposes.

It runs during the upload preview - *before* anything is committed - and two
gates stand in front of the API call:

1. **Already in the database?** Dropped. Re-uploading a statement never re-sends
   its contents.
2. **Already settled by a rule or a manual edit?** Dropped. The model only ever
   sees what the local pipeline could not place.

Whatever survives is **redacted**: account and card numbers, transaction
references and your name become `[account]`, `[ref]` and `[owner]`. Balances,
statement files and account numbers are never sent; merchant names and amounts
are, because categorisation needs them.

It returns three things, all as proposals on the **Review** page:

- **Categories** for transactions no rule could place
- **Rules** for payees that will recur - accepting one backfills it over history
- **Flags**: possible parse errors, possible duplicates, and outflows that look
  like transfers to your own accounts

**Nothing is applied until you accept it.** A pending suggestion leaves the
transaction uncategorized and in the review queue, so the "never guess" rule
still holds for the data itself.

Enable it by putting a key in `.env.local` (see `.env.example`):

    ANTHROPIC_API_KEY=sk-ant-...
    FINANCE_OWNER_NAMES=Your Name        # masked before sending

With no key, the layer reports itself as off and everything else is unaffected.

## Layout

    src/db/schema.ts        tables (Drizzle); `npm run db:generate` after editing
    src/lib/parsers/pdf.ts  pdfjs text extraction that keeps x/y, so table
                            columns survive - direction is read from the column
    src/lib/parsers/dbs.ts  the DBS statement parser; citibank.ts, youtrip.ts,
                            maybank.ts and tng.ts beside it
    src/lib/ingest.ts       hash-dedupe -> detect -> parse -> continuity -> insert
    src/lib/classify.ts     override -> rule -> uncategorized
    src/lib/reconcile.ts    transfer matching and the pocket ledger
    src/lib/subscriptions.ts  matching, status and detection of recurring charges
    src/lib/queries.ts      every dashboard aggregation
    src/lib/ai/redact.ts    what may leave the machine, and what may not
    src/lib/ai/review.ts    the Claude call; proposals only, never writes
    src/lib/ai/persist.ts   the two gates, then stores proposals as pending
    src/mcp/tools.ts        the MCP tools, over the same queries and actions
    src/mcp/server.ts       the stdio entry an assistant launches

Adding a bank means one file in `src/lib/parsers/` and one line in its
`index.ts`. `npm run probe -- <file.pdf>` dumps a PDF's positioned text, which
is how you find a new statement's column geometry.

## Scripts

    npm run db:generate     # write a migration after changing schema.ts
    npm run db:migrate      # apply migrations
    npm run db:seed         # accounts, categories, rules
    npm run import:pdfs     # bulk-import ../data/statements/DBS (--reset to replace)
    npm run parity          # check the totals against the legacy Python output
    npm run mcp             # the MCP server on stdio, on finance/data
    npm test                # money, parsers, ingest, currencies, remarks, MCP, subscriptions...

## Status

DBS, Citibank, YouTrip, Maybank (Malaysia) and Touch 'n Go eWallet statements
parse. CPF is a balance feed rather than a transaction feed and is not parsed yet.

A Touch 'n Go export covers any range of months in one PDF. Only its wallet
section is read: the GO+ section after it accrues interest in fractions of a
sen, which a ledger of whole cents cannot hold, and every purchase is made from
the wallet anyway, so moves to and from GO+ show as transfers.

Totals are in SGD. An account in another currency (Maybank, in ringgit) is
shown on its own, in its own currency, and left out of every combined total
and of subscription detection; no exchange rate is ever applied. Password-
protected PDFs have to be unlocked before uploading.

## MCP: sorting with an assistant

`src/mcp/` exposes the data as an MCP server, so any assistant that runs local
MCP servers (Claude Desktop and Code, Codex, Cursor, Windsurf, VS Code, Gemini
CLI, LM Studio...) can read transactions and file them in bulk. Tools: `list_accounts`,
`list_categories`, `list_rules`, `find_transactions`, `group_transactions`
(uncategorised rows by merchant, with every id), `summarize`, `categorize`,
`set_remark`, `create_category`, `create_rule`. There is no delete.

Writes go through the same actions as the pages, so an edit made through MCP
is an override like a manual one and survives re-importing a statement. The
first write of a session backs the database up to `data/backups/`.

From source, against `finance/data`, the development app's **Develop → Connect
an AI Assistant** sets it up for each assistant (as `finance-tracker-dev`). By
hand, for Claude Code (`--silent` keeps npm's banner off stdout, which carries
the protocol):

    claude mcp add finance-dev -- npm --silent --prefix /path/to/finance run mcp

The supported assistants and where each keeps its settings are in
`desktop/assistants.js`. Ordinary ChatGPT chats are not among them: they only
reach MCP servers on the internet, and this one runs on the Mac alone.

The release app ships it compiled as `Resources/server/mcp.js`, run by the
app's own binary as Node; **Data → Connect an AI Assistant** writes each
supported app's MCP settings, or copies the standard `mcpServers` JSON for any
other (`desktop/assistants.js`).

## Tests and private data

This repo is public; statements and the database never enter it. The parser
suites run against real PDFs and skip unless two private inputs exist:
the PDFs under `../data/statements/` and `tests/fixtures/statements.local.json`
(copy `statements.example.json` and fill in your own balances). Every other
test uses synthetic data - keep it that way.
