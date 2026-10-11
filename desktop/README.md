# finance-tracker desktop app

A thin Electron shell around `../finance`. Double-click **finance-tracker** on the
Desktop (or in `~/Applications`) and it opens the dashboard in its own window.

## How it works

The `.app` contains no copy of the dashboard and no copy of the data. On every
launch it:

1. finds `finance/` (the path is baked in when packaging)
2. applies new database migrations, **after** backing up `data/sqlite.db` to
   `finance/data/backups/`, but only if `drizzle/` changed since last launch
3. runs `next build`, but only if something in `src/`, `public/`, the package
   files, config or `.env*` changed since the last build
4. starts `next start` on http://127.0.0.1:3417 with your system `node` and
   loads it in the window
5. stops the server when you quit

Because it runs the system Node, `better-sqlite3` never needs an Electron
rebuild, and `npm run dev` in the terminal keeps working as before.

## Making changes

| You changed…                         | What to do                                         |
| ------------------------------------ | -------------------------------------------------- |
| anything in `finance/`               | Nothing. Quit and reopen; it rebuilds itself.      |
| a DB schema (`npm run db:generate`)  | Nothing. The next launch backs up and migrates.    |
| a new npm dependency in `finance/`   | `npm install` in `finance/`, then reopen.          |
| this shell (`main.js`, `server.js`…) | `npm run install-app` here, to repackage.          |

While iterating on the UI, **Develop → Live-Reload Mode** switches the app to
`next dev`, so edits show up instantly without quitting. Turn it off
afterwards for the faster production build. If a change breaks the build, the
app shows the error output and offers to open in live-reload mode, which
still serves while there is a type error.

Other items under **Develop**: Rebuild and Restart (⇧⌘R), Open in Browser,
Show Project Folder, Show Server Log, Change Project Folder… (use this if you
move the repo), and the Chromium dev tools.

## Files

    main.js           window, menu, lifecycle
    server.js         find node -> migrate -> build if stale -> start/stop Next
    splash.html       the loading/error screen shown while the server starts
    scripts/          bake-path.js (records finance/ location), install.sh,
                      make-icon.sh (builds the .icns from ../logo-assets)

Settings and the server log live in `~/Library/Application Support/finance-tracker/`.
Deleting `settings.json` forces a fresh build and migration check on next launch.

## Commands

    npm start               # run the shell from source, without packaging
    npm run install-app     # package, copy to ~/Applications, link on Desktop

The logo lives in `../logo-assets/` (all platforms). Packaging builds
`build/icon.icns` from `logo-assets/macos/AppIcon.iconset` (`scripts/make-icon.sh`),
so to change the app icon, replace that iconset and run `npm run install-app`.

The web app uses the same logo, copied from `logo-assets/web/`:
`favicon.ico`, `favicon.svg` (as `finance/src/app/icon.svg`) and
`apple-touch-icon.png` (as `finance/src/app/apple-icon.png`).
