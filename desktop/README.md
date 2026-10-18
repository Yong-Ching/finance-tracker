# finance-tracker desktop app

A thin Electron shell around `../finance`. Double-click **finance-tracker** on the
Desktop (or in `~/Applications`) and it opens the dashboard in its own window.

The same shell is built two ways:

|                     | Development app (`npm run install-app`) | Release app (`npm run dist`)                  |
| ------------------- | --------------------------------------- | --------------------------------------------- |
| For                 | you, while changing the code            | other people, via GitHub Releases             |
| Name                | finance-tracker                         | Finance Tracker                               |
| Runs                | your live `finance/` on system Node     | a server built into the app, on Electron's Node |
| Data                | `finance/data/`                         | `~/Library/Application Support/Finance Tracker/data/` |
| Updates             | edit the code, reopen                   | **Update and Restart**, one click             |

The two have different names and app IDs, so both can be installed side by
side without sharing settings or data. Everything below the release section
is about the development app.

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
    npm run dist            # build the release DMGs and update zips into dist-release/
    npm run release -- patch  # cut a release: bump, commit, tag, push (or minor, major)

## The release app

### Cutting a release

From `desktop/`, with everything committed:

    npm run release -- patch     # 1.2.0 -> 1.2.1, a bug fix
    npm run release -- minor     # 1.2.0 -> 1.3.0, a new feature
    npm run release -- major     # 1.2.0 -> 2.0.0, a big change

`scripts/release.js` bumps `package.json`, commits `Release v1.2.1`, and opens
your editor for the release notes (or pass `-m "..."`). Write them for the
person installing it: they appear in the update prompt. Then it pushes the
commit and an annotated tag `v1.2.1` together. The first release is
`npm run release -- 1.0.0`.

The tag starts `.github/workflows/release.yml`, which checks that the tag
matches `package.json`, runs `npm run dist` on a macOS runner, and publishes
to GitHub Releases, with the tag's message as the notes:

| File                              | For                                  |
| --------------------------------- | ------------------------------------ |
| `Finance-Tracker-<v>-<arch>.dmg`  | a first install                      |
| `Finance-Tracker-<v>-<arch>.zip`  | what the in-app updater downloads    |
| `SHA256SUMS`                      | what the updater checks the zip against |

Versions must only go up: an installed app offers a release only when its
version is newer than its own. A broken release is fixed with a new patch
release, never by deleting and re-pushing a tag.

### How it is built

`npm run dist` does four things:

1. `scripts/stage-server.js` builds `finance/` as a standalone Next server into
   `build/release/`. It builds from a **clean export of the files git tracks**,
   never from the working copy, so `.env.local` and `data/` cannot end up in a
   public installer, and it refuses to finish if anything that looks personal
   (an env file, database, PDF or CSV) is in the output. It also compiles the
   migrate and seed scripts to plain JS for the app to run.
2. `electron-builder.release.js` packages the shell for `arm64` and `x64`.
   The staged server is the same for both: its only native module,
   better-sqlite3, ships Node-API binaries for both kinds of Mac, and those load
   in Electron's Node without a rebuild.
3. `scripts/after-pack.js` copies the server into `Resources/server`
   (electron-builder's `extraResources` drops `node_modules`) and signs the app
   ad hoc.
4. `scripts/zip-release.js` zips each app with `ditto` (which keeps the
   symlinks the signature depends on) and writes `SHA256SUMS`.

On launch, the release app backs up and migrates the database when the
migrations changed, seeds what is missing (accounts, starter categories and
rules on a first launch), and starts the server on port 3418, so it can run
next to the development app. `updates.js` checks
`releases/latest` once per launch and from **Check for Updates…**.

### How updating works

The app has no Apple Developer ID, so `electron-updater` (which needs one) is
out; `updates.js` does the same job by hand. **Update and Restart**:

1. downloads the zip for this Mac's architecture and checks it against
   `SHA256SUMS`
2. unzips it and checks the app inside: the bundle id, the version it was
   offered, and an intact signature (`codesign --verify --deep --strict`)
3. quits, and a detached shell script waits for the app to exit, swaps the new
   bundle in (putting the old one back if that fails), and reopens it

macOS only blocks unsigned apps that carry the quarantine flag a browser adds
to downloads. The app downloads the update itself, so the flag is never set
and only the first install needs **Open Anyway**. The checksum guards against
a broken download, not a compromised GitHub account; the trust is in the repo.

It cannot update itself when run straight from the DMG, or from a folder the
account cannot write to; it then says to move it to Applications. If anything
fails, nothing is changed and it offers the DMG instead. A Developer ID ($99 a
year) would make updates silent and remove the first-launch prompt too.

The logo lives in `../logo-assets/` (all platforms). Packaging builds
`build/icon.icns` from `logo-assets/macos/AppIcon.iconset` (`scripts/make-icon.sh`),
so to change the app icon, replace that iconset and run `npm run install-app`.

The web app uses the same logo, copied from `logo-assets/web/`:
`favicon.ico`, `favicon.svg` (as `finance/src/app/icon.svg`) and
`apple-touch-icon.png` (as `finance/src/app/apple-icon.png`).
