// Runs after electron-builder in `npm run dist`. Zips each packed app for the
// in-app updater and writes SHA256SUMS for every file a release publishes.
//
// The DMGs are for a first install; the zips are what updates.js downloads.
// ditto, not zip: it keeps the bundle's symlinks and extended attributes, and
// the ad hoc signature breaks without them.
//
//   dist-release/Finance-Tracker-1.2.0-arm64.zip
//   dist-release/Finance-Tracker-1.2.0-x64.zip
//   dist-release/SHA256SUMS

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const OUT = path.resolve(__dirname, "..", "dist-release");
const APP = "Finance Tracker.app";
const { version } = require("../package.json");

// electron-builder's output folder for each architecture.
const ARCH_DIRS = { "mac-arm64": "arm64", mac: "x64" };

for (const [dir, arch] of Object.entries(ARCH_DIRS)) {
  const appPath = path.join(OUT, dir, APP);
  if (!fs.existsSync(appPath)) throw new Error(`missing ${appPath}`);
  const zip = path.join(OUT, `Finance-Tracker-${version}-${arch}.zip`);
  fs.rmSync(zip, { force: true });
  execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zip], { stdio: "inherit" });
  console.log(`zipped ${path.basename(zip)}`);
}

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const published = fs
  .readdirSync(OUT)
  .filter((f) => f.startsWith(`Finance-Tracker-${version}-`) && /\.(dmg|zip)$/.test(f))
  .sort();
// The format `shasum -a 256 -c SHA256SUMS` checks.
fs.writeFileSync(path.join(OUT, "SHA256SUMS"), published.map((f) => `${sha256(path.join(OUT, f))}  ${f}\n`).join(""));
console.log(`wrote SHA256SUMS for ${published.length} files`);
