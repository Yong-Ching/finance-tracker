// Electron shell for finance/. The window is just a browser pointed at the
// local Next server that server.js starts; all app logic lives in finance/.

const { app, BrowserWindow, Menu, dialog, shell, nativeTheme } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { FinanceServer } = require("./server");

const STATE_FILE = path.join(app.getPath("userData"), "settings.json");
const LOG_FILE = path.join(app.getPath("userData"), "logs", "server.log");

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const state = loadState();
let win = null;
let server = null;
let appUrl = null;
let quitting = false;

// ---- Where finance/ lives -------------------------------------------------
//
// Order: a folder chosen from the menu, then the path baked in at package time
// (project-path.json), then ../finance next to this file when run via
// `npm start`. Moving the project only means choosing the folder again.

function isFinanceProject(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name === "finance";
  } catch {
    return false;
  }
}

function bakedProjectDir() {
  try {
    return require("./project-path.json").projectDir;
  } catch {
    return null;
  }
}

function resolveProjectDir() {
  const candidates = [state.projectDir, bakedProjectDir(), path.resolve(__dirname, "..", "finance")];
  return candidates.find((d) => d && isFinanceProject(d)) || null;
}

async function chooseProjectDir() {
  const res = await dialog.showOpenDialog({
    title: "Locate the finance project folder",
    message: "Choose the finance/ folder (the one containing package.json).",
    properties: ["openDirectory"],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const dir = res.filePaths[0];
  if (!isFinanceProject(dir)) {
    await dialog.showMessageBox({ type: "error", message: "That folder is not the finance project." });
    return null;
  }
  state.projectDir = dir;
  // A different checkout has a different build and migration history.
  delete state.buildFingerprint;
  delete state.migrationsHash;
  saveState(state);
  return dir;
}

// ---- Window ---------------------------------------------------------------

function send(fn, arg) {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(`window.${fn} && window.${fn}(${JSON.stringify(arg)})`).catch(() => {});
}

function createWindow() {
  const b = state.bounds || { width: 1320, height: 900 };
  win = new BrowserWindow({
    ...b,
    minWidth: 480,
    minHeight: 400,
    title: "finance-tracker",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b0b0b" : "#ffffff",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (state.maximized) win.maximize();

  const remember = () => {
    if (win.isDestroyed()) return;
    state.maximized = win.isMaximized();
    if (!state.maximized && !win.isMinimized()) state.bounds = win.getBounds();
    saveState(state);
  };
  win.on("resize", remember);
  win.on("move", remember);

  // Links to anything but the local server open in the real browser.
  const isLocal = (url) => appUrl && url.startsWith(appUrl);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isLocal(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith("file://") || isLocal(url)) return;
    e.preventDefault();
    shell.openExternal(url);
  });

  win.on("closed", () => (win = null));
}

// ---- Server lifecycle -----------------------------------------------------

async function boot() {
  const projectDir = resolveProjectDir() || (await chooseProjectDir());
  if (!projectDir) return app.quit();

  appUrl = null;
  await win.loadFile(path.join(__dirname, "splash.html"));
  send("setMode", state.mode === "dev" ? "Live-reload mode" : "");

  server = new FinanceServer({
    projectDir,
    logFile: LOG_FILE,
    state,
    saveState,
    onStatus: (msg) => send("setStatus", msg),
    onLog: (chunk) => send("appendLog", chunk),
    onUnexpectedExit: onServerCrash,
  });

  try {
    appUrl = await server.start(state.mode === "dev" ? "dev" : "production");
    await win.loadURL(appUrl);
  } catch (err) {
    await onStartFailure(err);
  }
  buildMenu();
}

async function onStartFailure(err) {
  send("setStatus", "Could not start");
  send("showLog", true);
  const inDev = state.mode === "dev";
  const buttons = inDev ? ["Retry", "Show Log File", "Quit"] : ["Retry", "Open in Live-Reload Mode", "Quit"];
  const { response } = await dialog.showMessageBox(win, {
    type: "error",
    message: "finance-tracker could not start",
    detail: `${err.message}\n\nThe output is shown in the window behind this message.`,
    buttons,
    defaultId: 0,
  });
  await server.stop();
  if (response === 0) return boot();
  if (response === 1 && !inDev) {
    // `next dev` serves even when `next build` fails on a type error, which
    // makes it the useful fallback while a change is half-finished.
    state.mode = "dev";
    saveState(state);
    return boot();
  }
  if (response === 1) {
    shell.showItemInFolder(LOG_FILE);
    return;
  }
  app.quit();
}

async function onServerCrash(code) {
  if (quitting || !win) return;
  const { response } = await dialog.showMessageBox(win, {
    type: "error",
    message: "The finance server stopped",
    detail: `It exited with code ${code}. The log has the details.`,
    buttons: ["Restart", "Show Log File", "Quit"],
  });
  if (response === 0) return boot();
  if (response === 1) return shell.showItemInFolder(LOG_FILE);
  app.quit();
}

async function restart({ forceBuild = false } = {}) {
  if (forceBuild) {
    delete state.buildFingerprint;
    saveState(state);
  }
  if (server) await server.stop();
  await boot();
}

// ---- Menu -----------------------------------------------------------------

function buildMenu() {
  const template = [
    { role: "appMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Develop",
      submenu: [
        {
          label: "Rebuild and Restart",
          accelerator: "CmdOrCtrl+Shift+R",
          click: () => restart({ forceBuild: true }),
        },
        {
          label: "Live-Reload Mode",
          type: "checkbox",
          checked: state.mode === "dev",
          click: (item) => {
            state.mode = item.checked ? "dev" : "production";
            saveState(state);
            restart();
          },
        },
        { type: "separator" },
        {
          label: "Open in Browser",
          enabled: !!appUrl,
          click: () => appUrl && shell.openExternal(appUrl),
        },
        {
          label: "Show Project Folder",
          click: () => server && shell.openPath(server.projectDir),
        },
        { label: "Show Server Log", click: () => shell.showItemInFolder(LOG_FILE) },
        {
          label: "Change Project Folder…",
          click: async () => {
            if (await chooseProjectDir()) restart();
          },
        },
        { type: "separator" },
        { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- App ------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    boot();
  });

  // Reopening from the Dock after closing the window: the server is still up.
  app.on("activate", () => {
    if (win) return;
    createWindow();
    if (appUrl) win.loadURL(appUrl);
    else boot();
  });

  app.on("window-all-closed", () => app.quit());

  app.on("before-quit", (e) => {
    if (quitting || !server) return;
    e.preventDefault();
    quitting = true;
    server.stop().finally(() => app.quit());
  });
}
