# financial-assistant

A local-first personal finance tracker built from bank statement PDFs. It parses
DBS, Citibank and YouTrip statements, refuses any statement whose balances do not
reconcile, classifies transactions by explicit rules (never guesses), and shows
the result on a dashboard. Nothing is uploaded anywhere. An optional Claude review
layer can propose categories, but only sees redacted descriptions.

    finance/    the app: Next.js + SQLite (see finance/README.md)
    desktop/    an Electron shell that opens the app from the Desktop (see desktop/README.md)

## Quick start

    cd finance
    npm install
    npm run db:migrate
    npm run dev            # http://127.0.0.1:3000

Then upload a statement from the header. For the desktop app, see `desktop/README.md`.

## Contributing to your own copy

This repo is public, and the folder it lives in also holds real finances, so:

- The root `.gitignore` is an **allowlist**: only `finance/`, `desktop/` and repo
  files are ever tracked. Data, statements and notes elsewhere stay local.
- Enable the guard once per clone. It blocks commits containing statement
  PDFs, databases, env files, account or NRIC numbers, or anything listed in your
  local `.private-patterns`:

      git config core.hooksPath .githooks

- Tests use synthetic data. Parser tests against real PDFs read their expected
  values from a gitignored fixture; see `finance/README.md`.
