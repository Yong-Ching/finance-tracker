<h1>
  <img src="logo-assets/svg/icon-rounded.svg" alt="" width="40" height="40" align="top">
  finance-tracker
</h1>

<p align="center">
  <img src="logo-assets/github/social-preview-1280x640.png" alt="finance-tracker: personal finance, tracked" width="100%">
</p>

A local-first personal finance tracker built from bank statement PDFs. It parses
your statements, refuses any statement whose balances do not reconcile,
categorises transactions by rules you write (it never guesses), and shows the
result on a dashboard. Everything runs on your own machine; nothing is uploaded.

It is built around Singapore accounts (amounts in SGD) and currently reads:

| Statement                        | What it covers                           |
| -------------------------------- | ---------------------------------------- |
| DBS bank account (PDF)           | your main account: income, spending      |
| Citibank credit card eStatement  | what was bought on the card              |
| YouTrip SGD statement            | what was spent from the travel wallet    |

```
finance/    the app: Next.js + SQLite
desktop/    optional macOS app that opens it with a double-click
```

---

## Install the app (macOS)

No Node, git or setup needed.

1. Open the [latest release](https://github.com/Yong-Ching/finance-tracker/releases/latest)
   and download the DMG for your Mac: `arm64` for Apple Silicon (M1 and later),
   `x64` for Intel. Not sure? Apple menu → **About This Mac** → *Chip*.
2. Open the DMG and drag **Finance Tracker** into **Applications**.
3. The first time only: open it, and when macOS says it can't verify the app,
   click **Done**. Then go to **System Settings → Privacy & Security**, scroll
   down to *"Finance Tracker" was blocked*, and click **Open Anyway**. (The app
   isn't signed with a paid Apple developer certificate, so macOS asks once.)

### Updating

The app checks for a new version each time it opens, and from **Finance Tracker
→ Check for Updates…**. When one is out, click **Update and Restart**: it
downloads the new version, replaces itself and reopens, in a minute or so. Your
data is kept: it lives outside the app, in `~/Library/Application Support/Finance Tracker/`.

### Settings

**Data → Edit Settings…** opens a settings file where you can add a Claude API
key to turn on the Review page (see step 5 below for what that does). Restart
the app after editing. **Data → Show Data Folder** shows your database and
stored statements; copy that folder while the app is closed to back it up.

---

## Run from source

For changing the code, or running on Linux or Windows.

### 1. Install the prerequisites

- **Node.js 20.9 or newer** (tested on 22). Check with `node -v`.
  Get it from [nodejs.org](https://nodejs.org) or `brew install node`.
- **git**

### 2. Get the code

```sh
git clone https://github.com/Yong-Ching/finance-tracker.git
cd finance-tracker/finance
```

### 3. Install dependencies

```sh
npm install
```

### 4. Create the database

```sh
npm run db:migrate     # creates finance/data/sqlite.db
npm run db:seed        # adds the accounts, starter categories and transfer rules
```

Both are safe to run again: migrate only applies what is new, and the seed only
adds what is missing.

### 5. (Optional) Turn on the Claude review layer

The app works fully without this. If you want Claude to *suggest* categories for
transactions your rules don't cover:

```sh
cp .env.example .env.local
```

Then edit `.env.local`: set `ANTHROPIC_API_KEY`, and put your own name in
`FINANCE_OWNER_NAMES` so it is masked before anything is sent. Account numbers,
card numbers and references are always masked; balances are never sent.

### 6. Start it

```sh
npm run dev
```

Open **http://127.0.0.1:3000**. The dashboard is empty until you upload a statement.

### 7. (Optional, macOS) Install the desktop app

```sh
cd ../desktop
npm install
npm run install-app
```

This puts **finance-tracker** in `~/Applications` and a shortcut on your Desktop. It runs
your copy of `finance/` directly: when you change the code, the next launch
rebuilds by itself. Details are in [desktop/README.md](desktop/README.md).

---

## Using it

The routine is the same every month: upload, categorise, reconcile.

### 1. Upload a statement

1. Download the statement PDF from your bank's website or app.
2. Click **Upload statement** at the top right and choose the PDF.
3. Read the preview before importing: which account it detected, the period,
   how many transactions, and whether the balances **reconcile** (opening
   balance + every transaction = closing balance).
4. Click **Import**. Nothing is saved until you do.

If the balances don't add up, the statement is **quarantined**: it is kept and
shown on **Accounts**, but left out of every total, so the dashboard is never
quietly wrong. Uploading the same file twice does nothing.

### 2. Categorise what the rules didn't catch

1. Go to **Transactions** and tick **Needs review**.
2. Pick a category for each row from its dropdown. To do many at once, tick
   their checkboxes and choose a category from the bar that appears.
3. A manual choice always beats a rule, and survives deleting and re-importing
   the statement.

To find a transaction by how much it was, use **Amount** in the filters: `3.98`
(exact), `10-50` (a range), `>100` or `<5`, `~30` (within 10%). Start with `-`
for money out only or `+` for money in only, e.g. `-~30`.

### 3. Write rules for payees that recur

1. Go to **Rules**. Enter a text the description contains (for example
   `NTUC FP`) and the category it belongs to.
2. Click **Add and backfill** to apply it to your history as well (**Add only**
   applies it to future uploads). An existing rule can be re-applied any time
   with its **Backfill** button.

Each month the review queue gets shorter as your rules grow.

### 4. Reconcile transfers to your own accounts

Moving money from DBS to your Citibank card or YouTrip wallet is **not
spending**; the spending is whatever that money bought, which only the card's or
wallet's own statement shows. Until that statement is uploaded, the money is
shown as **Unaccounted** on the dashboard.

1. Upload the Citibank and YouTrip statements as in step 1.
2. Go to **Reconcile**. It proposes matches between the two sides of each
   transfer by amount and date.
3. Confirm the ones that are right. Nothing is linked until you do.

### 5. Track your subscriptions

**Subscriptions** shows what you pay on repeat, and what that adds up to per
month and per year.

1. Under **Suggested**, the app lists charges that repeat at a steady amount and
   interval (an Apple plan, a phone bill). Click **Track** and give it a name, or
   **Dismiss** it if it is just a habit; dismissed ones never come back.
2. Use **Add by hand** for anything the suggestions can't see yet, such as a
   yearly plan.
3. Each tracked subscription shows its last charge and when the next is due. It
   is flagged if a charge is missed (judged against your latest statement, not
   today's date) or if the price changes. Mark one **Cancelled** when you end it.
4. Click a subscription to trace it: every charge matched to it, each linked to
   the statement it appeared on (opens the original PDF), with missed months
   shown as gaps. **Show in Transactions** opens exactly those charges to edit.
   A suggestion expands the same way, so you can check it before tracking.

### 6. Read the dashboard

- Use the period picker (top right) to switch between a single month, the
  last 3 months, year to date or all time.
- Click any figure to see the transactions behind it.
- **Review** shows Claude's suggestions, if you turned that on. Accepting a
  suggested rule also backfills it.

---

## Your data

When running from source (the installed app keeps the same files in
`~/Library/Application Support/Finance Tracker/`):

| What                    | Where                                      |
| ----------------------- | ------------------------------------------ |
| Database                | `finance/data/sqlite.db`                   |
| Copies of uploaded PDFs | `finance/data/statements/`                 |
| API key, your name      | `finance/.env.local`                       |
| Pre-migration backups   | `finance/data/backups/` (desktop app only) |

All of these are gitignored. To back up, copy the `finance/data/` folder while
the app is closed.

## Updating a source checkout

```sh
git pull
cd finance
npm install
npm run db:migrate
```

The desktop app runs the migration and rebuild for you on its next launch;
you only need `git pull` and, if dependencies changed, `npm install`.

## Troubleshooting

| Problem                                    | Fix                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------- |
| Upload says **Unknown account**            | Run `npm run db:seed` in `finance/`.                                |
| Upload says **No parser recognised this document** | It isn't one of the three supported statement formats. |
| Port 3000 is already in use                | `npm run dev -- -p 3001`, then open http://127.0.0.1:3001           |
| Desktop app shows an error while starting  | The window shows the output; **Develop → Show Server Log** has all of it. |

---

## Changing the code

[finance/README.md](finance/README.md) explains how the app works and where
things live. Adding a new bank means one parser file in `src/lib/parsers/`.

To publish a new version of the installable app, run
`npm run release -- patch` (or `minor`, `major`) in `desktop/`. It bumps the
version, asks for release notes, and pushes a tag; the release workflow builds
and publishes it, and installed apps offer the update on their next launch.
[desktop/README.md](desktop/README.md) covers building one locally.

```sh
cd finance
npm test               # unit tests (real-PDF tests skip without private fixtures)
npm run lint
```

### Keeping personal data out of git

This repo is public, and the folder it lives in may also hold real finances.

- The root `.gitignore` is an **allowlist**: only `finance/`, `desktop/` and
  repo files are ever tracked. Anything else you put in the folder stays local.
- Turn on the pre-commit guard once per clone:

  ```sh
  git config core.hooksPath .githooks
  ```

  It blocks commits containing statement PDFs, databases, env files, account or
  NRIC numbers, and anything you list (one per line) in a `.private-patterns`
  file at the repo root, such as your name, account numbers and payees. That
  file is never committed.
- Every push is reviewed before anything leaves the machine
  (`.githooks/review-push.sh`, run by the `pre-push` hook above):
  1. Local checks: personal file types, account/NRIC formats, your
     `.private-patterns`, and non-noreply commit emails. These never leave
     the machine.
  2. A clean Claude reviewer: a separate `claude -p`, started in an empty temp
     folder with every tool disabled, reads only the outgoing diff and commit
     messages and blocks anything that looks like real personal or financial
     data. If it can't run, the push is refused.

  This needs the [Claude Code](https://claude.com/claude-code) CLI signed in.
  To have Claude Code's own pushes reviewed the same way, add this to
  `.claude/settings.json`:

  ```json
  { "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ {
    "type": "command", "timeout": 300,
    "command": "\"$CLAUDE_PROJECT_DIR\"/.githooks/review-push.sh claude"
  } ] } ] } }
  ```
- Tests use made-up data. Parser tests against real PDFs read their expected
  values from `finance/tests/fixtures/statements.local.json` (gitignored);
  `statements.example.json` shows the format.
