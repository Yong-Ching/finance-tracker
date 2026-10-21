// Connects the release app's MCP server (Resources/server/mcp.js) to Claude, so
// someone can ask Claude to sort their transactions instead of editing each one.
//
// The server is run by this app's own binary as Node (ELECTRON_RUN_AS_NODE), so
// nothing else needs installing, and it reads the same database the app does -
// it works with the app closed. Claude Desktop learns about it from an entry in
// its config file; Claude Code from a `claude mcp add` command.

const { app, clipboard, dialog } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const NAME = "finance-tracker";
const CONFIG = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");

/** How Claude should launch the server. */
function serverEntry(dataDir) {
  return {
    command: process.execPath,
    args: [path.join(process.resourcesPath, "server", "mcp.js")],
    env: { ELECTRON_RUN_AS_NODE: "1", FINANCE_DATA_DIR: dataDir },
  };
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function claudeCodeCommand(entry) {
  const env = Object.entries(entry.env).map(([k, v]) => `-e ${k}=${quote(v)}`).join(" ");
  return `claude mcp add ${NAME} --scope user ${env} -- ${quote(entry.command)} ${entry.args.map(quote).join(" ")}`;
}

/** The config as an object, {} when there is none yet; throws on a file it cannot read safely. */
function readConfig() {
  if (!fs.existsSync(CONFIG)) return {};
  const text = fs.readFileSync(CONFIG, "utf8");
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("it is not a JSON object");
  return parsed;
}

/** Writes the config, keeping a copy of the previous one beside it. */
function writeConfig(config) {
  if (fs.existsSync(CONFIG)) fs.copyFileSync(CONFIG, `${CONFIG}.before-finance-tracker`);
  fs.writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * @param {object} opts
 * @param {Electron.BrowserWindow|null} opts.win
 * @param {string} opts.dataDir  where the database lives
 */
async function connectClaude({ win, dataDir }) {
  const show = (options) => (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));

  // Claude would be told to launch this exact path; a copy running from the DMG vanishes on eject.
  if (process.execPath.startsWith("/Volumes/") || process.execPath.includes("/AppTranslocation/")) {
    await show({
      type: "warning",
      message: "Move Finance Tracker to Applications first",
      detail: "It is running from the download. Quit it, drag it into the Applications folder, open it from there and try again.",
    });
    return;
  }

  const entry = serverEntry(dataDir);
  let config;
  try {
    config = readConfig();
  } catch (err) {
    await show({
      type: "error",
      message: "Claude Desktop's settings could not be read",
      detail: `${CONFIG} could not be read safely (${err.message}), so it was left untouched. The Claude Code command below still works.\n\n${claudeCodeCommand(entry)}`,
    });
    return;
  }
  const connected = !!config.mcpServers?.[NAME];
  const desktopInstalled = fs.existsSync(path.dirname(CONFIG));

  const buttons = [
    connected ? "Update in Claude Desktop" : "Add to Claude Desktop",
    "Copy Claude Code Command",
    ...(connected ? ["Remove from Claude Desktop"] : []),
    "Cancel",
  ];
  const { response } = await show({
    type: "question",
    message: connected ? "Finance Tracker is connected to Claude Desktop" : "Let Claude read and sort your finances?",
    detail:
      "This lets Claude read your transactions and, when you ask, file them into categories, add remarks and create " +
      "rules - so a whole month can be sorted in one conversation instead of one row at a time.\n\n" +
      "What Claude reads is sent to Anthropic to answer you. Every change is recorded like one you made by hand, and " +
      "your database is backed up before Claude's first change each session.\n\n" +
      (desktopInstalled ? "" : "Claude Desktop does not seem to be installed; you can still copy the command for Claude Code.\n\n") +
      "After adding it, quit and reopen Claude Desktop.",
    buttons,
    cancelId: buttons.length - 1,
    defaultId: 0,
  });
  const choice = buttons[response];

  if (choice === "Copy Claude Code Command") {
    clipboard.writeText(claudeCodeCommand(entry));
    await show({
      type: "info",
      message: "Command copied",
      detail: "Paste it into Terminal and press Return. Claude Code can then use Finance Tracker in any project.",
    });
    return;
  }
  if (choice === "Remove from Claude Desktop") {
    delete config.mcpServers[NAME];
    writeConfig(config);
    await show({ type: "info", message: "Removed", detail: "Quit and reopen Claude Desktop for it to take effect." });
    return;
  }
  if (choice !== buttons[0]) return;

  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  config.mcpServers = { ...(config.mcpServers ?? {}), [NAME]: entry };
  writeConfig(config);
  await show({
    type: "info",
    message: connected ? "Updated" : "Added to Claude Desktop",
    detail:
      "Quit and reopen Claude Desktop. Then try asking:\n\n" +
      "“Group my uncategorised transactions by merchant and suggest a category for each.”",
  });
}

module.exports = { connectClaude, claudeCodeCommand, serverEntry };
