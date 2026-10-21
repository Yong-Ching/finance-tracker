// Connects the app's MCP server to AI assistants, so someone can ask one to
// sort their transactions instead of editing each one. MCP is an open
// standard: the server is the same for every assistant, and only where each
// app keeps its list of servers differs.
//
// The release app's server is its compiled copy (Resources/server/mcp.js), run
// by this app's own binary as Node (ELECTRON_RUN_AS_NODE), so nothing else needs
// installing; the development app's is the source, on the system Node. Either
// reads the same database the app does, and works with the app closed.
//
// ChatGPT chats are not here: they only reach MCP servers on the internet, and
// this one runs on the Mac alone. Codex in the ChatGPT desktop app is - it reads
// the same settings file as the Codex CLI.

const { clipboard, dialog } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** The release app's name in an assistant's settings; the development app adds "-dev". */
const NAME = "finance-tracker";
const home = (...p) => path.join(os.homedir(), ...p);
const appSupport = (...p) => home("Library", "Application Support", ...p);

/** How an assistant launches the release app's server: its compiled copy, on this app's own binary. */
function serverEntry(dataDir) {
  return {
    command: process.execPath,
    args: [path.join(process.resourcesPath, "server", "mcp.js")],
    env: { ELECTRON_RUN_AS_NODE: "1", FINANCE_DATA_DIR: dataDir },
  };
}

/**
 * How an assistant launches the development app's server: the source, through
 * tsx, on the system Node the app found. The full path to node matters - an
 * assistant starts it with Finder's PATH, which has no node in it.
 */
function sourceEntry(node, projectDir) {
  return {
    command: node,
    args: [
      path.join(projectDir, "node_modules", "tsx", "dist", "cli.mjs"),
      // Explicit: an assistant starts it from its own folder, where the "@/"
      // paths in finance/tsconfig.json would not be found.
      "--tsconfig",
      path.join(projectDir, "tsconfig.json"),
      "--conditions=react-server",
      path.join(projectDir, "src", "mcp", "server.ts"),
    ],
    env: { FINANCE_DATA_DIR: path.join(projectDir, "data") },
  };
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function claudeCodeCommand(entry, name = NAME) {
  const env = Object.entries(entry.env).map(([k, v]) => `-e ${k}=${quote(v)}`).join(" ");
  return `claude mcp add ${name} --scope user ${env} -- ${quote(entry.command)} ${entry.args.map(quote).join(" ")}`;
}

/** The standard form most MCP apps accept, to paste into one not listed here. */
const genericSetup = (entry, name = NAME) => JSON.stringify({ mcpServers: { [name]: entry } }, null, 2);

/** Keeps a copy of a settings file before changing it. */
function backup(file) {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.before-finance-tracker`);
}

/* ---------------------------------------------------- apps with a JSON file --- */

/** The settings as an object, {} when there are none yet; throws on a file it cannot read safely. */
function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8");
  if (!text.trim()) return {};
  // A file with comments (JSONC) fails here, and is then left alone rather than rewritten without them.
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("it is not a JSON object");
  return parsed;
}

/** `key` is the object servers live under; `shape` adapts the standard entry where an app differs. */
function jsonApp({ id, name, file, key = "mcpServers", shape = (e) => e, local = false }) {
  return {
    id, name, file, local,
    installed: () => fs.existsSync(path.dirname(file)),
    connected: (server) => !!readJson(file)[key]?.[server],
    async add(server, entry) {
      const config = readJson(file);
      config[key] = { ...(config[key] ?? {}), [server]: shape(entry) };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      backup(file);
      fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    },
    async remove(server) {
      const config = readJson(file);
      delete config[key]?.[server];
      backup(file);
      fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    },
  };
}

/* ---------------------------------------------------------------- Codex --- */

// Codex keeps servers in TOML, shared by the CLI, the IDE extension and Codex in
// the ChatGPT desktop app. Only this app's own table is ever touched: it is
// removed by its header and appended whole, and the rest of the file stays as
// written, comments included.
const CODEX_FILE = home(".codex", "config.toml");
const tomlString = (s) => JSON.stringify(String(s)); // a TOML basic string uses the same escapes
const tomlKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k));

/** The header of this server's table, or one of its subtables, in either quoting. */
const ownHeader = (server) =>
  new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${server}|"${server}")\\s*(?:\\..*)?\\]\\s*(?:#.*)?$`);

function withoutServer(text, server) {
  const out = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) skipping = ownHeader(server).test(line);
    if (!skipping) out.push(line);
  }
  // The marker comment this app writes above its table goes with it.
  return out.join("\n").replace(new RegExp(`\\n*# Added by Finance Tracker \\(${server}\\)\\n*$`), "\n");
}

const codex = {
  id: "codex",
  name: "Codex (CLI, IDE and ChatGPT app)",
  file: CODEX_FILE,
  installed: () =>
    fs.existsSync(path.dirname(CODEX_FILE)) ||
    fs.existsSync("/Applications/ChatGPT.app") ||
    fs.existsSync("/Applications/Codex.app"),
  connected: (server) =>
    fs.existsSync(CODEX_FILE) && fs.readFileSync(CODEX_FILE, "utf8").split("\n").some((l) => ownHeader(server).test(l)),
  async add(server, entry) {
    const text = fs.existsSync(CODEX_FILE) ? withoutServer(fs.readFileSync(CODEX_FILE, "utf8"), server) : "";
    const env = Object.entries(entry.env).map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`).join(", ");
    const table = [
      `# Added by Finance Tracker (${server})`,
      `[mcp_servers.${tomlKey(server)}]`,
      `command = ${tomlString(entry.command)}`,
      `args = [${entry.args.map(tomlString).join(", ")}]`,
      `env = { ${env} }`,
      "",
    ].join("\n");
    fs.mkdirSync(path.dirname(CODEX_FILE), { recursive: true });
    backup(CODEX_FILE);
    fs.writeFileSync(CODEX_FILE, `${text.trimEnd()}${text.trim() ? "\n\n" : ""}${table}`);
  },
  async remove(server) {
    backup(CODEX_FILE);
    fs.writeFileSync(CODEX_FILE, `${withoutServer(fs.readFileSync(CODEX_FILE, "utf8"), server).trimEnd()}\n`);
  },
};

/* ---------------------------------------------------------- Claude Code --- */

// Claude Code's own command does the writing: ~/.claude.json holds a great deal
// of its other state, and is not this app's to rewrite. It is only read, to tick
// the menu.
const CLAUDE_JSON = home(".claude.json");

/** The `claude` command, as the user's terminal would find it. Finder's PATH does not include it. */
function findClaude() {
  return new Promise((resolve) => {
    execFile(process.env.SHELL || "/bin/zsh", ["-ilc", "command -v claude"], { timeout: 5000 }, (_err, stdout) => {
      const found = (stdout || "").trim().split("\n").pop();
      const fallbacks = [found, home(".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
      resolve(fallbacks.find((p) => p && p.startsWith("/") && fs.existsSync(p)) || null);
    });
  });
}

function runClaude(args) {
  return findClaude().then((claude) => new Promise((resolve, reject) => {
    if (!claude) return reject(new Error("the claude command was not found. Is Claude Code installed?"));
    execFile(claude, args, { timeout: 30000 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || stdout || err.message).trim())) : resolve(stdout));
  }));
}

const claudeCode = {
  id: "claude-code",
  name: "Claude Code",
  file: CLAUDE_JSON,
  installed: () => fs.existsSync(CLAUDE_JSON) || fs.existsSync(home(".claude")),
  connected: (server) => !!readJson(CLAUDE_JSON).mcpServers?.[server],
  async add(server, entry) {
    if (claudeCode.connected(server)) await runClaude(["mcp", "remove", server, "--scope", "user"]);
    const env = Object.entries(entry.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    // The name first: -e takes several values, and would otherwise swallow it.
    await runClaude(["mcp", "add", server, "--scope", "user", ...env, "--", entry.command, ...entry.args]);
  },
  async remove(server) {
    await runClaude(["mcp", "remove", server, "--scope", "user"]);
  },
};

/* ------------------------------------------------------------ the list --- */

const ASSISTANTS = [
  jsonApp({ id: "claude", name: "Claude Desktop", file: appSupport("Claude", "claude_desktop_config.json") }),
  claudeCode,
  codex,
  jsonApp({ id: "cursor", name: "Cursor", file: home(".cursor", "mcp.json") }),
  jsonApp({ id: "windsurf", name: "Windsurf", file: home(".codeium", "windsurf", "mcp_config.json") }),
  jsonApp({
    id: "vscode", name: "VS Code (Copilot)", file: appSupport("Code", "User", "mcp.json"), key: "servers",
    shape: (e) => ({ type: "stdio", ...e }),
  }),
  jsonApp({ id: "gemini", name: "Gemini CLI", file: home(".gemini", "settings.json") }),
  // Runs the model on this Mac, so nothing it reads leaves the machine.
  jsonApp({ id: "lmstudio", name: "LM Studio", file: home(".lmstudio", "mcp.json"), local: true }),
];

function isConnected(a, name = NAME) {
  try {
    return a.connected(name);
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- dialogs --- */

function privacyNote(a) {
  return a?.local
    ? "The AI model runs on this Mac, so nothing it reads leaves your computer."
    : "What the assistant reads is sent to the company that runs its AI model, to answer you. " +
      "(LM Studio is the exception: it runs the model on your Mac.)";
}

const WHAT_IT_DOES =
  "This lets the assistant read your transactions and, when you ask, file them into categories, add remarks and " +
  "create rules - so a whole month can be sorted in one conversation instead of one row at a time. It cannot " +
  "delete anything. Every change is recorded like one you made by hand, and your database is backed up before " +
  "the assistant's first change each session.";

/** Refuses when this copy is running from the DMG: the path the assistant is given would vanish on eject. */
async function checkLocation(show) {
  if (!process.execPath.startsWith("/Volumes/") && !process.execPath.includes("/AppTranslocation/")) return true;
  await show({
    type: "warning",
    message: "Move Finance Tracker to Applications first",
    detail: "It is running from the download. Quit it, drag it into the Applications folder, open it from there and try again.",
  });
  return false;
}

/** Connects or disconnects one app, after saying what that means. */
async function toggle(a, { show, entry, name }) {
  if (!(await checkLocation(show))) return;
  let connected;
  try {
    connected = a.connected(name);
  } catch (err) {
    await show({
      type: "error",
      message: `${a.name}'s settings could not be read`,
      detail: `${a.file} could not be read safely (${err.message}), so it was left untouched. ` +
        "Copy Setup for Another App gives the text to add by hand.",
    });
    return;
  }

  if (connected) {
    const { response } = await show({
      type: "question",
      message: `Disconnect Finance Tracker from ${a.name}?`,
      detail: `${a.name} will no longer be able to read or change your finance data. Restart it for this to take effect.`,
      buttons: ["Disconnect", "Cancel"],
      cancelId: 1,
    });
    if (response !== 0) return;
  } else {
    const { response } = await show({
      type: "question",
      message: `Let ${a.name} read and sort your finances?`,
      detail: `${WHAT_IT_DOES}\n\n${privacyNote(a)}`,
      buttons: [`Connect ${a.name}`, "Cancel"],
      cancelId: 1,
    });
    if (response !== 0) return;
  }

  try {
    if (connected) await a.remove(name);
    else await a.add(name, entry);
  } catch (err) {
    await show({ type: "error", message: `${a.name} could not be ${connected ? "disconnected" : "connected"}`, detail: err.message });
    return;
  }
  if (connected) return;
  await show({
    type: "info",
    message: `Connected to ${a.name}`,
    detail:
      `Quit and reopen ${a.name} (or start a new session). Then try asking:\n\n` +
      "“Group my uncategorised transactions by merchant and suggest a category for each.”" +
      (a.local ? "\n\nIn LM Studio, pick a model that supports tool use." : ""),
  });
}

async function copySetup({ show, entry, name }) {
  if (!(await checkLocation(show))) return;
  const buttons = ["Copy Setup (JSON)", "Copy Claude Code Command", "Cancel"];
  const { response } = await show({
    type: "question",
    message: "Connect another AI assistant",
    detail:
      `${WHAT_IT_DOES}\n\n${privacyNote(null)}\n\n` +
      "Any app that supports MCP servers on your Mac can use Finance Tracker. Most take the JSON setup: paste it " +
      "into the app's MCP settings (its “mcpServers” section). Claude Code takes a Terminal command instead.",
    buttons,
    cancelId: 2,
  });
  if (response === 2) return;
  await clipboard.writeText(response === 0 ? genericSetup(entry, name) : claudeCodeCommand(entry, name));
  await show({
    type: "info",
    message: "Copied",
    detail: response === 0
      ? "Paste it into the app's MCP settings, then restart the app."
      : "Paste it into Terminal and press Return. Claude Code can then use Finance Tracker in any project.",
  });
}

/**
 * The "Connect an AI Assistant" submenu: each supported app found on this Mac,
 * ticked when connected, then the copy-it-yourself option for everything else.
 *
 * @param {object} opts
 * @param {() => Electron.BrowserWindow|null} opts.getWin
 * @param {object} opts.entry     how to launch the server (serverEntry or sourceEntry)
 * @param {string} [opts.name]    its name in the assistant's settings
 * @param {() => void} opts.onChange  rebuilds the menu so the ticks stay true
 */
function assistantsMenu({ getWin, entry, name = NAME, onChange }) {
  const show = (options) => {
    const win = getWin();
    return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
  };
  const found = ASSISTANTS.filter((a) => a.installed());
  return [
    ...found.map((a) => ({
      label: a.local ? `${a.name} (runs on this Mac)` : a.name,
      type: "checkbox",
      checked: isConnected(a, name),
      click: async () => {
        await toggle(a, { show, entry, name });
        onChange();
      },
    })),
    ...(found.length ? [] : [{ label: "No supported assistant found", enabled: false }]),
    { type: "separator" },
    { label: "Copy Setup for Another App…", click: () => copySetup({ show, entry, name }) },
  ];
}

module.exports = {
  assistantsMenu, ASSISTANTS, serverEntry, sourceEntry, claudeCodeCommand, genericSetup, toggle, isConnected, withoutServer,
};
