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
YouTrip or the Citibank card is an `internal_transfer` and never enters the
expense total. Its contents arrive with that pocket's own statement, and
**Reconcile** links the two. Until that link exists the money is reported as
*unaccounted* - never as spending, never as accounted-for.

**A manual edit outlives the statement it came from.** Edits are stored against
a content hash of the transaction, so deleting and re-importing a statement
preserves them. A manual decision always beats a rule.

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
    src/lib/parsers/dbs.ts  the DBS statement parser
    src/lib/ingest.ts       hash-dedupe -> detect -> parse -> continuity -> insert
    src/lib/classify.ts     override -> rule -> uncategorized
    src/lib/reconcile.ts    transfer matching and the pocket ledger
    src/lib/subscriptions.ts  matching, status and detection of recurring charges
    src/lib/queries.ts      every dashboard aggregation
    src/lib/ai/redact.ts    what may leave the machine, and what may not
    src/lib/ai/review.ts    the Claude call; proposals only, never writes
    src/lib/ai/persist.ts   the two gates, then stores proposals as pending

Adding a bank means one file in `src/lib/parsers/` and one line in its
`index.ts`. `npm run probe -- <file.pdf>` dumps a PDF's positioned text, which
is how you find a new statement's column geometry.

## Scripts

    npm run db:generate     # write a migration after changing schema.ts
    npm run db:migrate      # apply migrations
    npm run db:seed         # accounts, categories, rules
    npm run import:pdfs     # bulk-import ../data/statements/DBS (--reset to replace)
    npm run parity          # check the totals against the legacy Python output
    npm test                # money, classification, parsers, ingest, redaction, subscriptions

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

## Tests and private data

This repo is public; statements and the database never enter it. The parser
suites run against real PDFs and skip unless two private inputs exist:
the PDFs under `../data/statements/` and `tests/fixtures/statements.local.json`
(copy `statements.example.json` and fill in your own balances). Every other
test uses synthetic data - keep it that way.
