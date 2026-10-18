// Cuts a release: bumps the version, commits, tags and pushes. The pushed tag
// starts .github/workflows/release.yml, which builds and publishes the app.
//
//   npm run release -- patch            1.2.0 -> 1.2.1   a bug fix
//   npm run release -- minor            1.2.0 -> 1.3.0   a new feature
//   npm run release -- major            1.2.0 -> 2.0.0   a big change
//   npm run release -- 1.0.0            an exact version
//   npm run release -- minor -m "..."   notes inline instead of in the editor
//
// The tag's message becomes the release notes, which the update prompt shows
// to the person installing it. Write them for them, not for a changelog.

const { execFileSync } = require("node:child_process");
const path = require("node:path");

const DESKTOP = path.resolve(__dirname, "..");
const git = (...args) => execFileSync("git", args, { cwd: DESKTOP, encoding: "utf8" }).trim();
const run = (cmd, args) => execFileSync(cmd, args, { cwd: DESKTOP, stdio: "inherit" });

function fail(msg) {
  console.error(`release: ${msg}`);
  process.exit(1);
}

const VERSION = /^\d+\.\d+\.\d+$/;
const parse = (v) => v.split(".").map(Number);
const compare = (a, b) => {
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

// ---- Arguments --------------------------------------------------------------

const args = process.argv.slice(2);
const bump = args[0];
const mIndex = args.indexOf("-m");
const notes = mIndex >= 0 ? args[mIndex + 1] : null;
if (!bump || (mIndex >= 0 && !notes)) {
  fail("usage: npm run release -- <patch|minor|major|X.Y.Z> [-m \"release notes\"]");
}
if (!VERSION.test(bump) && !["patch", "minor", "major"].includes(bump)) {
  fail(`"${bump}" is not patch, minor, major or a version like 1.2.3`);
}

// ---- Preconditions ----------------------------------------------------------

if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") fail("releases are cut from main");
if (git("status", "--porcelain")) fail("commit or stash your changes first; a release builds what is committed");

git("fetch", "--quiet", "--tags", "origin", "main");
if (git("rev-list", "--count", "HEAD..origin/main") !== "0") fail("main is behind origin/main; pull first");

const tags = git("tag", "--list", "v*").split("\n").map((t) => t.replace(/^v/, "")).filter((t) => VERSION.test(t));
const latest = tags.sort(compare).at(-1) || null;
const current = require(path.join(DESKTOP, "package.json")).version;
const base = latest || current;

let next;
if (VERSION.test(bump)) next = bump;
else {
  const [ma, mi, pa] = parse(base);
  next = bump === "major" ? `${ma + 1}.0.0` : bump === "minor" ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`;
}

// Installed apps only offer a version newer than their own.
if (latest && compare(next, latest) <= 0) fail(`${next} is not newer than the latest release, ${latest}`);
const tag = `v${next}`;

// ---- Bump, commit, tag, push ------------------------------------------------

console.log(`Releasing ${tag}${latest ? ` (latest is v${latest})` : " (first release)"}`);
run("npm", ["version", next, "--no-git-tag-version", "--allow-same-version"]);
if (git("status", "--porcelain")) {
  run("git", ["add", "package.json", "package-lock.json"]);
  run("git", ["commit", "-m", `Release ${tag}`]);
}

try {
  // With no -m, git opens the editor for the notes; an empty message aborts.
  run("git", ["tag", "-a", tag, ...(notes ? ["-m", notes] : [])]);
} catch {
  if (git("log", "-1", "--format=%s") === `Release ${tag}`) git("reset", "--hard", "HEAD~1");
  fail("tag not created, nothing released");
}

try {
  // Both or neither: a pushed tag without its commit would build the wrong code.
  run("git", ["push", "--atomic", "origin", "main", `refs/tags/${tag}`]);
} catch {
  fail(`push failed. ${tag} and the release commit are still local; fix the problem and run:\n` +
    `  git push --atomic origin main refs/tags/${tag}`);
}

console.log(`\nPushed ${tag}. The release workflow is building it:`);
console.log("  https://github.com/Yong-Ching/finance-tracker/actions");
