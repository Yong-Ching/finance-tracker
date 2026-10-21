// Connects the release app's MCP server (Resources/server/mcp.js) to AI
// assistants, so someone can ask one to sort their transactions instead of
// editing each one. MCP is an open standard: the server is the same for every
// assistant, and only where each app keeps its list of servers differs.
//
// The server is run by this app's own binary as Node (ELECTRON_RUN_AS_NODE), so
// nothing else needs installing, and it reads the same database the app does -
// it works with the app closed.
//
// Not here: ChatGPT. Its apps only reach MCP servers on the internet, and this
// one deliberately runs on the Mac alone.

const { clipboard, dialog } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** The release app's name in an assistant's settings; the development app adds "-dev". */
const NAME = "finance-tracker";
const home = (...p) => path.join(os.homedir(), ...p);
const appSupport = (...p) => home("Library", "Application Support", ...p);

/**
 * Apps that run local MCP servers from a JSON file. `key` is the object the
 * servers live under; `shape` adapts the standard entry where an app differs.
 */
const ASSISTANTS = [
  { id: "claude", name: "Claude Desktop", file: appSupport("Claude", "claude_desktop_config.json"), key: "mcpServers" },
  { id: "cursor", name: "Cursor", file: home(".cursor", "mcp.json"), key: "mcpServers" },
  { id: "windsurf", name: "Windsurf", file: home(".codeium", "windsurf", "mcp_config.json"), key: "mcpServers" },
  {
    id: "vscode", name: "VS Code (Copilot)", file: appSupport("Code", "User", "mcp.json"), key: "servers",
    shape: (e) => ({ type: "stdio", ...e }),
  },
  { id: "gemini", name: "Gemini CLI", file: home(".gemini", "settings.json"), key: "mcpServers" },
  // Runs the model on this Mac, so nothing it reads leaves the machine.
  { id: "lmstudio", name: "LM Studio", file: home(".lmstudio", "mcp.json"), key: "mcpServers", local: true },
];

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

/** An app counts as installed when the folder its settings live in exists. */
const installed = (a) => fs.existsSync(path.dirname(a.file));

/** The settings as an object, {} when there are none yet; throws on a file it cannot read safely. */
function readConfig(a) {
  if (!fs.existsSync(a.file)) return {};
  const text = fs.readFileSync(a.file, "utf8");
  if (!text.trim()) return {};
  // A file with comments (JSONC) fails here, and is then left alone rather than rewritten without them.
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("it is not a JSON object");
  return parsed;
}

function isConnected(a, name = NAME) {
  try {
    return !!readConfig(a)[a.key]?.[name];
  } catch {
    return false;
  }
}

/** Writes the settings, keeping a copy of the previous file beside it. */
function writeConfig(a, config) {
  fs.mkdirSync(path.dirname(a.file), { recursive: true });
  if (fs.existsSync(a.file)) fs.copyFileSync(a.file, `${a.file}.before-finance-tracker`);
  fs.writeFileSync(a.file, `${JSON.stringify(config, null, 2)}\n`);
}

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
  let config;
  try {
    config = readConfig(a);
  } catch (err) {
    await show({
      type: "error",
      message: `${a.name}'s settings could not be read`,
      detail: `${a.file} could not be read safely (${err.message}), so it was left untouched. ` +
        "Copy Setup for Another App gives the text to add by hand.",
    });
    return;
  }

  if (config[a.key]?.[name]) {
    const { response } = await show({
      type: "question",
      message: `Disconnect Finance Tracker from ${a.name}?`,
      detail: `${a.name} will no longer be able to read or change your finance data. Restart it for this to take effect.`,
      buttons: ["Disconnect", "Cancel"],
      cancelId: 1,
    });
    if (response !== 0) return;
    delete config[a.key][name];
    writeConfig(a, config);
    return;
  }

  const { response } = await show({
    type: "question",
    message: `Let ${a.name} read and sort your finances?`,
    detail: `${WHAT_IT_DOES}\n\n${privacyNote(a)}`,
    buttons: [`Connect ${a.name}`, "Cancel"],
    cancelId: 1,
  });
  if (response !== 0) return;
  config[a.key] = { ...(config[a.key] ?? {}), [name]: a.shape ? a.shape(entry) : entry };
  writeConfig(a, config);
  await show({
    type: "info",
    message: `Connected to ${a.name}`,
    detail:
      `Quit and reopen ${a.name}. Then try asking:\n\n` +
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
  const found = ASSISTANTS.filter(installed);
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

module.exports = { assistantsMenu, ASSISTANTS, serverEntry, sourceEntry, claudeCodeCommand, genericSetup, toggle, isConnected };
