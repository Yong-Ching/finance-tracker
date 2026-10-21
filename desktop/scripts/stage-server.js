// Builds the self-contained server that the release app ships, into
// build/release/{server,drizzle}. The release app runs it on Electron's own
// Node, so the person installing it needs no Node, npm or git.
//
// It always builds from a clean export of the files git would publish, never
// from the working copy: finance/ here also holds .env.local (an API key and
// the owner's name) and data/ (the real database and statements), and neither
// may end up inside an installer that is posted publicly.
//
//   node scripts/stage-server.js
//
// The output runs on both Apple Silicon and Intel: the only native module is
// better-sqlite3, which ships prebuilt Node-API binaries for both.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DESKTOP = path.resolve(__dirname, "..");
const REPO = path.resolve(DESKTOP, "..");
const OUT = path.join(DESKTOP, "build", "release");

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const step = (msg) => console.log(`\n== ${msg}`);

// ---- 1. Export: only what git tracks or would track ------------------------

step("exporting finance/ (git-tracked files only)");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "finance-export-"));
const app = path.join(work, "finance");
const files = execFileSync("git", ["-C", REPO, "ls-files", "-co", "--exclude-standard", "-z", "finance"])
  .toString()
  .split("\0")
  .filter(Boolean);
for (const rel of files) {
  const src = path.join(REPO, rel);
  if (!fs.existsSync(src)) continue; // deleted in the working copy, not yet committed
  const dest = path.join(work, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}
console.log(`${files.length} files -> ${app}`);

try {
  // ---- 2. Build ------------------------------------------------------------

  step("installing dependencies");
  sh("npm", ["ci", "--no-audit", "--no-fund"], { cwd: app });

  // Collecting page data opens the database. Give it a throwaway one outside
  // the export, so file tracing cannot pull a database into the output, and
  // create it first: build workers opening a missing database at once race.
  const buildData = path.join(work, "build-data");
  step("creating a throwaway database for the build");
  sh(path.join(app, "node_modules", ".bin", "tsx"), ["scripts/migrate.ts"], {
    cwd: app,
    env: { ...process.env, FINANCE_DATA_DIR: buildData },
  });

  step("next build (standalone)");
  sh(path.join(app, "node_modules", ".bin", "next"), ["build"], {
    cwd: app,
    env: {
      ...process.env,
      FINANCE_STANDALONE: "1",
      FINANCE_DATA_DIR: buildData,
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });

  // ---- 3. Assemble ---------------------------------------------------------

  step("assembling build/release");
  fs.rmSync(OUT, { recursive: true, force: true });
  const server = path.join(OUT, "server");
  fs.cpSync(path.join(app, ".next", "standalone"), server, { recursive: true });
  // Next links hashed package names in .next/node_modules to the real packages
  // by absolute path, which points into the export about to be deleted.
  const links = path.join(server, ".next", "node_modules");
  for (const name of fs.existsSync(links) ? fs.readdirSync(links) : []) {
    const link = path.join(links, name);
    const target = fs.readlinkSync(link);
    const pkg = target.split(`${path.sep}node_modules${path.sep}`).pop();
    fs.rmSync(link);
    fs.symlinkSync(path.join("..", "..", "node_modules", pkg), link);
    if (!fs.existsSync(link)) throw new Error(`${name} -> ${pkg} does not resolve`);
  }
  if (!fs.existsSync(path.join(server, "server.js"))) {
    throw new Error("standalone output has no server.js at its root; did Next pick a different tracing root?");
  }
  // The standalone server does not include static assets; Next documents copying them.
  fs.cpSync(path.join(app, ".next", "static"), path.join(server, ".next", "static"), { recursive: true });
  fs.cpSync(path.join(app, "public"), path.join(server, "public"), { recursive: true });
  fs.cpSync(path.join(app, "drizzle"), path.join(OUT, "drizzle"), { recursive: true });

  // migrate and seed are TypeScript run by tsx in development. Compiled to
  // plain JS beside server.js, they resolve better-sqlite3 from the server's
  // own node_modules, the copy rebuilt for Electron below.
  step("compiling migrate and seed");
  require("esbuild").buildSync({
    entryPoints: [path.join(app, "scripts", "migrate.ts"), path.join(app, "scripts", "seed.ts")],
    outdir: path.join(server, "scripts"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["better-sqlite3"],
    tsconfig: path.join(app, "tsconfig.json"),
    logLevel: "warning",
  });

  // The MCP server Claude launches (desktop/claude.js), compiled the same way.
  // Two Next-only imports are swapped for stand-ins: "server-only" is a build
  // guard that throws outside Next, and there are no pages to revalidate.
  step("compiling the MCP server");
  require("esbuild").buildSync({
    entryPoints: [path.join(app, "src", "mcp", "server.ts")],
    outfile: path.join(server, "mcp.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["better-sqlite3"],
    alias: {
      "server-only": path.join(app, "src", "mcp", "shims", "server-only.ts"),
      "next/cache": path.join(app, "src", "mcp", "shims", "next-cache.ts"),
    },
    tsconfig: path.join(app, "tsconfig.json"),
    logLevel: "warning",
  });

  // ---- 4. better-sqlite3 for both Macs --------------------------------------

  // Tracing keeps only the host's binary. Its Node-API prebuilds load in
  // Electron's Node unchanged, so ship both macOS ones and the app runs on
  // either kind of Mac.
  step("adding better-sqlite3 binaries");
  const prebuilds = path.join("node_modules", "better-sqlite3", "prebuilds");
  for (const arch of ["arm64", "x64"]) {
    fs.copyFileSync(path.join(app, prebuilds, `darwin-${arch}.node`), path.join(server, prebuilds, `darwin-${arch}.node`));
  }
  step("checking it loads in Electron");
  sh(require("electron"), ["-e", `new (require(${JSON.stringify(path.join(server, "node_modules", "better-sqlite3"))}))(":memory:").close()`], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });

  // ---- 5. Nothing personal goes out -------------------------------------------

  step("checking for personal files");
  const bad = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      const rel = path.relative(OUT, p);
      if (ent.isDirectory()) {
        if (ent.name === "data" && !rel.includes("node_modules")) bad.push(rel);
        else walk(p);
      } else if (/^\.env/.test(ent.name) || /\.(db|db-wal|db-shm|pdf|csv)$/i.test(ent.name)) {
        // node_modules ships its own .pdf test fixtures in some packages; ours never does.
        if (!(rel.includes("node_modules") && /\.pdf$/i.test(ent.name))) bad.push(rel);
      }
    }
  };
  walk(OUT);
  if (bad.length) {
    fs.rmSync(OUT, { recursive: true, force: true });
    throw new Error(`refusing to package; these look personal:\n  ${bad.join("\n  ")}`);
  }

  console.log(`\nstaged: ${path.relative(DESKTOP, OUT)}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
