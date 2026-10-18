// Checks GitHub Releases for a newer version of the release app, and installs
// it with one click.
//
// The app is not signed with an Apple Developer ID, so electron-updater (which
// needs one) is out. Instead it does the same job by hand:
//
//   1. download the zip for this Mac's architecture, and the release's SHA256SUMS
//   2. check the zip against its checksum, unzip it, and check the app inside:
//      the right bundle id and version, and an intact signature
//   3. quit, and let a small shell script swap the new app in and reopen it
//
// macOS only asks "are you sure?" about files a browser downloads (they carry
// a quarantine flag). The app downloads this one itself, so after the first
// install updates open without the Privacy & Security detour. Its data lives
// in ~/Library/Application Support, outside the app, so swapping it is safe.
//
// A release without a zip (or a failed install) falls back to opening the DMG.

const { app, dialog, net, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { promisify } = require("node:util");

const REPO = "Yong-Ching/finance-tracker";
const BUNDLE_ID = "io.github.yong-ching.finance-tracker";
const run = promisify(execFile);

let installing = false;

async function latestRelease() {
  const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "finance-tracker" },
  });
  if (res.status === 404) return null; // nothing released yet
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return res.json();
}

/** true when version a is newer than b ("1.2.10" > "1.2.9"). */
function isNewer(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

/** The .app this process runs from, e.g. /Applications/Finance Tracker.app. */
function currentBundle() {
  // process.execPath is <bundle>/Contents/MacOS/<name>
  return path.resolve(process.execPath, "..", "..", "..");
}

/** Why the running app cannot replace itself, or null when it can. */
function cannotReplaceReason(bundle) {
  if (!bundle.endsWith(".app")) return "it is not running from an app bundle";
  // Opened straight from the DMG, or from Downloads before being moved, macOS
  // runs a read-only copy from a hidden folder.
  if (bundle.startsWith("/Volumes/") || bundle.includes("/AppTranslocation/")) {
    return "it is running from the download, not from Applications";
  }
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
  } catch {
    return `this account cannot change ${path.dirname(bundle)}`;
  }
  return null;
}

/** Downloads url to file, reporting 0..1 progress; resolves to its sha256. */
async function download(url, file, onProgress) {
  const res = await net.fetch(url, { headers: { "User-Agent": "finance-tracker" } });
  if (!res.ok) throw new Error(`download answered ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const hash = crypto.createHash("sha256");
  let received = 0;
  const meter = new Transform({
    transform(chunk, _enc, done) {
      hash.update(chunk);
      received += chunk.length;
      if (total) onProgress(received / total);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(file));
  return hash.digest("hex");
}

async function expectedSum(release, assetName) {
  const sums = release.assets.find((a) => a.name === "SHA256SUMS");
  if (!sums) throw new Error("the release has no SHA256SUMS");
  const res = await net.fetch(sums.browser_download_url, { headers: { "User-Agent": "finance-tracker" } });
  if (!res.ok) throw new Error(`SHA256SUMS answered ${res.status}`);
  const line = (await res.text()).split("\n").find((l) => l.trim().endsWith(`  ${assetName}`));
  if (!line) throw new Error(`SHA256SUMS does not list ${assetName}`);
  return line.split(/\s+/)[0].toLowerCase();
}

async function plistValue(bundle, key) {
  const { stdout } = await run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path.join(bundle, "Contents", "Info.plist")]);
  return stdout.trim();
}

/** Downloads, checks and unpacks the update; resolves to the new .app's path. */
async function prepare(release, zipAsset, version, onProgress) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "finance-tracker-update-"));
  const zip = path.join(work, zipAsset.name);

  const [want, got] = await Promise.all([
    expectedSum(release, zipAsset.name),
    download(zipAsset.browser_download_url, zip, onProgress),
  ]);
  if (got !== want) throw new Error("the download does not match its checksum");

  const unpacked = path.join(work, "unpacked");
  await run("ditto", ["-x", "-k", zip, unpacked]);
  fs.rmSync(zip);
  const name = fs.readdirSync(unpacked).find((f) => f.endsWith(".app"));
  if (!name) throw new Error("the download has no app in it");
  const next = path.join(unpacked, name);

  if ((await plistValue(next, "CFBundleIdentifier")) !== BUNDLE_ID) throw new Error("the download is a different app");
  const nextVersion = await plistValue(next, "CFBundleShortVersionString");
  if (nextVersion !== version) throw new Error(`the download is version ${nextVersion}, not ${version}`);
  await run("codesign", ["--verify", "--deep", "--strict", next]);
  return next;
}

/**
 * Starts a detached script that waits for this process to exit, swaps the new
 * app in (keeping the old one until the new one is in place), and reopens it.
 */
function scheduleSwap(next, bundle) {
  const script = `
    pid="$1"; next="$2"; bundle="$3"; old="$bundle.old"
    while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
    rm -rf "$old"
    mv "$bundle" "$old" || { open "$bundle"; exit 1; }
    if mv "$next" "$bundle"; then
      rm -rf "$old"
    else
      mv "$old" "$bundle"
    fi
    open "$bundle"
    rm -rf "$(dirname "$(dirname "$next")")"
  `;
  spawn("/bin/sh", ["-c", script, "swap", String(process.pid), next, bundle], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

async function install({ win, show, release, zipAsset, dmgUrl, latest }) {
  if (installing) return;
  installing = true;
  const progress = (p) => win && !win.isDestroyed() && win.setProgressBar(p);
  try {
    const bundle = currentBundle();
    const reason = cannotReplaceReason(bundle);
    if (reason) {
      await show({
        type: "warning",
        message: "Move Finance Tracker to Applications first",
        detail: `It cannot update itself because ${reason}. Quit it, drag it into the Applications folder, open it from there and check for updates again.`,
      });
      return;
    }
    progress(0);
    const next = await prepare(release, zipAsset, latest, progress);
    scheduleSwap(next, bundle);
    app.quit(); // main.js stops the server first; the script then swaps and reopens
  } catch (err) {
    progress(-1);
    const { response } = await show({
      type: "error",
      message: "The update could not be installed",
      detail: `${err.message}\n\nNothing was changed. You can download it and install it by hand instead.`,
      buttons: ["Download", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) shell.openExternal(dmgUrl);
  } finally {
    installing = false;
  }
}

/**
 * @param {object} opts
 * @param {Electron.BrowserWindow|null} opts.win
 * @param {object} opts.state       persisted settings; remembers a skipped version
 * @param {(s: object) => void} opts.saveState
 * @param {boolean} opts.interactive  true from the menu: also report "up to date" and errors
 */
async function checkForUpdates({ win, state, saveState, interactive }) {
  const show = (options) => (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
  const current = app.getVersion();
  if (installing) return;

  let release;
  try {
    release = await latestRelease();
  } catch (err) {
    if (interactive) await show({ type: "error", message: "Could not check for updates", detail: err.message });
    return;
  }

  const latest = release ? release.tag_name.replace(/^v/, "") : null;
  if (!latest || !isNewer(latest, current)) {
    if (interactive) await show({ type: "info", message: "You're up to date", detail: `Finance Tracker ${current} is the latest version.` });
    return;
  }
  // A version skipped from the launch prompt still shows when asked for.
  if (!interactive && state.skippedVersion === latest) return;

  const zipAsset = release.assets.find((a) => a.name === `Finance-Tracker-${latest}-${process.arch}.zip`);
  const dmg = release.assets.find((a) => a.name.endsWith(`-${process.arch}.dmg`));
  const dmgUrl = dmg ? dmg.browser_download_url : release.html_url;
  const notes = (release.body || "").trim();
  const { response } = await show({
    type: "info",
    message: `Finance Tracker ${latest} is available`,
    detail:
      `You have ${current}.\n\n` +
      (zipAsset
        ? "It installs and restarts the app in a minute or so. Your data is kept."
        : "Download it, quit this app, open the download and drag Finance Tracker " +
          "into Applications to replace this one. Your data is kept.") +
      (notes ? `\n\nWhat's new:\n${notes.length > 800 ? `${notes.slice(0, 800)}…` : notes}` : ""),
    buttons: [zipAsset ? "Update and Restart" : "Download", "Later", "Skip This Version"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    if (zipAsset) await install({ win, show, release, zipAsset, dmgUrl, latest });
    else shell.openExternal(dmgUrl);
  }
  if (response === 2) {
    state.skippedVersion = latest;
    saveState(state);
  }
}

module.exports = { checkForUpdates, isNewer };
