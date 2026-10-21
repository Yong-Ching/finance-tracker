// Runs the finance/ Next.js app as a child process on the system Node.
//
// Why system Node and not Electron's: finance/ depends on better-sqlite3, a
// native module compiled for the Node that ran `npm install`. Loading it inside
// Electron would need an electron-rebuild after every install, and would break
// `npm run dev` in the terminal. Spawning `node` keeps the two worlds apart.
//
// Nothing here copies the project or its database. The app always runs the live
// finance/ folder, so edits there show up on the next launch.

const { spawn, execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

// Anything under these paths changes the compiled app, so it forces a rebuild.
const BUILD_INPUTS = [
  "src",
  "public",
  "package.json",
  "package-lock.json",
  "next.config.ts",
  "postcss.config.mjs",
  "tsconfig.json",
  ".env",
  ".env.local",
  ".env.production",
];

// Finder launches apps with PATH=/usr/bin:/bin:/usr/sbin:/sbin, which has no
// node in it. Ask the login shell for the PATH the terminal would have.
function loginShellPath() {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh";
    execFile(
      shell,
      ["-ilc", 'printf "__PATH__%s__PATH__" "$PATH"'],
      { timeout: 5000 },
      (_err, stdout) => {
        const m = /__PATH__(.*)__PATH__/.exec(stdout || "");
        const fallback = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
        const dirs = [...(m ? m[1].split(":") : []), ...fallback];
        resolve([...new Set(dirs.filter(Boolean))].join(":"));
      },
    );
  });
}

function findNode(PATH) {
  for (const dir of PATH.split(":")) {
    const candidate = path.join(dir, "node");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function freePort(preferred) {
  const tryPort = (port) =>
    new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(null));
      srv.listen(port, "127.0.0.1", () => {
        const { port: got } = srv.address();
        srv.close(() => resolve(got));
      });
    });
  return tryPort(preferred).then((p) => p ?? tryPort(0));
}

// Newest mtime + file count over the build inputs. The count catches deletions,
// which do not bump any surviving file's mtime.
function fingerprint(projectDir) {
  let newest = 0;
  let count = 0;
  const walk = (p) => {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p)) {
        if (name === "node_modules" || name.startsWith(".DS_Store")) continue;
        walk(path.join(p, name));
      }
    } else {
      newest = Math.max(newest, st.mtimeMs);
      count++;
    }
  };
  for (const rel of BUILD_INPUTS) walk(path.join(projectDir, rel));
  return `${Math.floor(newest)}:${count}`;
}

function migrationsHash(migrationsDir) {
  const journal = path.join(migrationsDir, "meta", "_journal.json");
  try {
    return crypto.createHash("sha1").update(fs.readFileSync(journal)).digest("hex");
  } catch {
    return null;
  }
}

function waitForHttp(url, child, timeoutMs = 60000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (child.exitCode !== null) return reject(new Error("server exited during startup"));
      if (Date.now() - started > timeoutMs) return reject(new Error("server did not respond in time"));
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => setTimeout(attempt, 300));
      req.setTimeout(2000, () => req.destroy());
    };
    attempt();
  });
}

class FinanceServer {
  /**
   * @param {object} opts
   * @param {string} opts.projectDir  absolute path to finance/
   * @param {string} opts.logFile     where child output is written
   * @param {object} opts.state       persisted settings (read and written)
   * @param {(s: object) => void} opts.saveState
   * @param {(msg: string) => void} opts.onStatus
   * @param {(chunk: string) => void} opts.onLog
   * @param {(code: number|null) => void} opts.onUnexpectedExit
   */
  constructor(opts) {
    Object.assign(this, opts);
    this.dataDir = path.join(this.projectDir, "data");
    this.migrationsDir = path.join(this.projectDir, "drizzle");
    this.preferredPort = 3417;
    this.child = null;
    this.stopping = false;
  }

  log(text) {
    fs.appendFileSync(this.logFile, text);
    this.onLog(text);
  }

  // Runs one command to completion, streaming its output into the log.
  run(args, label, cmd = this.node) {
    this.log(`\n$ ${label}\n`);
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: this.projectDir, env: this.env });
      child.stdout.on("data", (d) => this.log(d.toString()));
      child.stderr.on("data", (d) => this.log(d.toString()));
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`${label} failed (exit ${code})`)),
      );
    });
  }

  nextBin() {
    return path.join(this.projectDir, "node_modules", "next", "dist", "bin", "next");
  }

  async prepare() {
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    fs.writeFileSync(this.logFile, `--- ${new Date().toISOString()} ---\n`);

    this.onStatus("Finding Node");
    const PATH = await loginShellPath();
    this.node = findNode(PATH);
    if (!this.node) throw new Error("Could not find `node` on your PATH. Is Node installed?");
    // Strip Electron's own variables so the child is a plain Node process.
    const env = { ...process.env, PATH };
    for (const k of Object.keys(env)) if (k.startsWith("ELECTRON_")) delete env[k];
    this.env = env;

    if (!fs.existsSync(this.nextBin())) {
      this.onStatus("Installing dependencies (first run)");
      await this.run(["install"], "npm install", path.join(path.dirname(this.node), "npm"));
    }
  }

  /** What decides whether migrate() runs: here, the migration journal. */
  setupHash() {
    return migrationsHash(this.migrationsDir);
  }

  // Applies pending drizzle migrations, but only when the migration journal has
  // changed since the last launch - and takes a backup of the database first.
  async migrateIfNeeded() {
    const hash = this.setupHash();
    if (!hash || hash === this.state.migrationsHash) return;

    const db = path.join(this.dataDir, "sqlite.db");
    if (fs.existsSync(db)) {
      this.onStatus("Backing up database before migrating");
      const dir = path.join(this.dataDir, "backups");
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dest = path.join(dir, `sqlite-${stamp}.db`);
      // sqlite3's .backup is WAL-safe; a plain file copy is not.
      await new Promise((resolve, reject) =>
        execFile("/usr/bin/sqlite3", [db, `.backup '${dest}'`], (err) =>
          err ? reject(err) : resolve(),
        ),
      );
      this.log(`database backed up to ${path.relative(this.dataDir, dest)}\n`);
    }

    this.onStatus("Applying database migrations");
    await this.migrate();
    this.state.migrationsHash = hash;
    this.saveState(this.state);
  }

  migrate() {
    const tsx = path.join(this.projectDir, "node_modules", "tsx", "dist", "cli.mjs");
    return this.run([tsx, "scripts/migrate.ts"], "migrate");
  }

  async buildIfStale() {
    const fp = fingerprint(this.projectDir);
    const built = fs.existsSync(path.join(this.projectDir, ".next", "BUILD_ID"));
    if (built && fp === this.state.buildFingerprint) return;

    this.onStatus(built ? "Changes found, rebuilding" : "Building for the first time");
    await this.run([this.nextBin(), "build"], "next build");
    // Recompute: the build itself may touch tsconfig.json or next-env.d.ts.
    this.state.buildFingerprint = fingerprint(this.projectDir);
    this.saveState(this.state);
  }

  /** @param {"production"|"dev"} mode */
  async start(mode) {
    await this.prepare();
    await this.migrateIfNeeded();
    if (mode === "production") await this.buildIfStale();

    const port = await freePort(this.state.port || this.preferredPort);
    const url = `http://127.0.0.1:${port}`;
    this.onStatus(mode === "dev" ? "Starting live-reload server" : "Starting");

    const { args, env } = this.serverCommand(mode, port);
    this.log(`\n$ ${args.map((a) => path.basename(a)).join(" ")}\n`);
    // detached: the child leads its own process group, so stop() can take down
    // everything Next spawns, not just the top process.
    const child = spawn(this.node, args, { cwd: this.projectDir, env, detached: true });
    this.child = child;
    this.stopping = false;
    child.stdout.on("data", (d) => this.log(d.toString()));
    child.stderr.on("data", (d) => this.log(d.toString()));
    child.on("exit", (code) => {
      if (this.child === child) this.child = null;
      if (!this.stopping) this.onUnexpectedExit(code);
    });

    await waitForHttp(url, child);
    return url;
  }

  serverCommand(mode, port) {
    const cmd = mode === "dev" ? "dev" : "start";
    return { args: [this.nextBin(), cmd, "-H", "127.0.0.1", "-p", String(port)], env: this.env };
  }

  stop() {
    const child = this.child;
    if (!child || child.exitCode !== null) return Promise.resolve();
    this.stopping = true;
    return new Promise((resolve) => {
      const kill = (sig) => {
        try {
          process.kill(-child.pid, sig);
        } catch {
          /* already gone */
        }
      };
      const timer = setTimeout(() => kill("SIGKILL"), 4000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      kill("SIGTERM");
    });
  }
}

/**
 * The release app: runs the server shipped inside the .app (see
 * scripts/stage-server.js) on Electron's own Node, with the data in the user's
 * Library folder. Nothing here needs Node, npm or the source on the machine.
 */
class BundledServer extends FinanceServer {
  /**
   * @param {object} opts  as FinanceServer, but instead of projectDir:
   * @param {string} opts.serverDir      Resources/server, holding server.js
   * @param {string} opts.migrationsDir  Resources/drizzle
   * @param {string} opts.dataDir        where the database and statements live
   * @param {string} opts.envFile        optional KEY=value settings (API key)
   */
  constructor(opts) {
    super({ ...opts, projectDir: opts.serverDir });
    this.dataDir = opts.dataDir;
    this.migrationsDir = opts.migrationsDir;
    // Not the development app's port, so both can run at once.
    this.preferredPort = 3418;
  }

  async prepare() {
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    fs.writeFileSync(this.logFile, `--- ${new Date().toISOString()} ---\n`);
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.node = process.execPath;
    this.env = {
      ...process.env,
      ...readEnvFile(this.envFile),
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      FINANCE_DATA_DIR: this.dataDir,
      FINANCE_MIGRATIONS: this.migrationsDir,
      NEXT_TELEMETRY_DISABLED: "1",
    };
  }

  /**
   * The seed as well as the journal: a release can add an account (a new bank)
   * without any migration, and an installed app must still create it.
   */
  setupHash() {
    const journal = migrationsHash(this.migrationsDir);
    if (!journal) return null;
    let seed = "";
    try {
      seed = fs.readFileSync(path.join(this.projectDir, "scripts", "seed.js"), "utf8");
    } catch {}
    return crypto.createHash("sha1").update(journal).update(seed).digest("hex");
  }

  // Seeding after every migration is safe: it only adds what is missing. On a
  // first launch it creates the accounts and starter categories and rules.
  async migrate() {
    await this.run(["scripts/migrate.js"], "migrate");
    await this.run(["scripts/seed.js"], "seed");
  }

  // Shipped already built.
  async buildIfStale() {}

  serverCommand(_mode, port) {
    return {
      args: [path.join(this.projectDir, "server.js")],
      env: { ...this.env, PORT: String(port), HOSTNAME: "127.0.0.1" },
    };
  }
}

/** KEY=value lines; blank lines and # comments ignored, surrounding quotes dropped. */
function readEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return env;
}

module.exports = { FinanceServer, BundledServer, fingerprint };
