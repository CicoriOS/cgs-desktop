"use strict";
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, nativeTheme, screen, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { resolveBinaries, startServices } = require("./services");
const { PrefsStore } = require("./prefs");
const { windowTitle } = require("./window-title");

const APP_ROOT = path.resolve(__dirname, "..", "..");
const MIN_WIDTH = 960;
const MIN_HEIGHT = 600;
const USAGE_FOCUS_MIN_AGE_MS = 15_000;

let prefs = null;
/** Mirror of ompweb's `omp-*` localStorage keys, see prefs.js. */
function prefsStore() {
  return (prefs ??= new PrefsStore(path.join(app.getPath("userData"), "web-prefs.json")));
}

/** @type {import("electron").BrowserWindow | null} */
let mainWindow = null;
let services = null;
let appOrigin = null;
let quitting = false;
let mainWindowCreated = false;
/** @type {import("../cgs/controller").CgsController | null} */
let cgsController = null;
/** @type {import("./updater").Updater | null} */
let updater = null;
/** @type {{ client: import("../cgs/agent").AgentClient, stop: () => void } | null} */
let cgsAgent = null;
let stopAgentWatch = null;
/** Last agent status ({ mode: "direct" | "relay", endpoint?, ... }); the renderer shows "Relay enabled" in relay mode. */
let networkStatus = null;

function stopAgent() {
  stopAgentWatch?.();
  stopAgentWatch = null;
  cgsAgent?.stop();
  cgsAgent = null;
}

nativeTheme.themeSource = "system";

function getWindowIcon() {
  return nativeImage.createFromPath(path.join(APP_ROOT, "assets", `icon.${process.platform === "win32" ? "ico" : "png"}`));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.on("window-all-closed", () => {
    // The login popup may be the only window for a moment before the main window exists.
    if (mainWindowCreated) app.quit();
  });
  app.on("before-quit", () => {
    quitting = true;
    cgsController?.stop();
    updater?.stop();
    if (services) services.stop();
    stopAgent();
  });
  app.on("will-quit", () => {
    cgsController?.stop();
    if (services) services.stop();
    stopAgent();
  });
  registerIpc();
  app.whenReady().then(start).catch(fatal);
}

function fatal(error) {
  if (quitting) return;
  quitting = true;
  cgsController?.stop();
  if (services) services.stop();
  stopAgent();
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox("CGS Desktop", message);
  app.exit(1);
}

async function start() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "editMenu" }, { role: "viewMenu" }]));

  const { CGS_BASE_URL, prepareAgentDir, needsStartupLogin, CgsController } = require("../cgs");
  const agentDir = path.join(app.getPath("userData"), "omp", "agent");
  const pluginSourceDir = app.isPackaged
    ? path.join(process.resourcesPath, "plugin", "omp-cgs")
    : path.join(APP_ROOT, "plugin", "omp-cgs");
  await prepareAgentDir(agentDir, { pluginSourceDir });

  const binaries = resolveBinaries({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appRoot: APP_ROOT });
  // Every CGS request (this process, omp, the console window) goes through the agent: direct, or the relay tunnel.
  const { agentSocketPath, startAgent } = require("../cgs/agent");
  const { routeThroughAgent } = require("../cgs/http");
  const agentSocket = agentSocketPath({ userData: app.getPath("userData") });
  cgsAgent = await startAgent({
    binary: binaries.agent,
    socketPath: agentSocket,
    upstream: CGS_BASE_URL,
    dataDir: path.join(app.getPath("userData"), "cgs-agent"),
    logFile: path.join(app.getPath("userData"), "logs", "cgs-agent.log"),
  });
  if (quitting) return cgsAgent.stop();
  routeThroughAgent({ origin: new URL(CGS_BASE_URL).origin, socketPath: agentSocket });
  stopAgentWatch = cgsAgent.client.watch(broadcastNetwork);
  // A crash after startup surfaces as an error dialog instead of leaving a dead window.
  const servicesReady = startServices({
    binaries,
    agentDir,
    agentSocket,
    logDir: path.join(app.getPath("userData"), "logs"),
    portFile: path.join(app.getPath("userData"), "ompweb-port.json"),
    onCrash: fatal,
  });
  servicesReady.then(
    (started) => {
      services = started;
      appOrigin = new URL(started.url).origin;
      if (quitting) started.stop();
    },
    () => {}, // the failure is surfaced where servicesReady is awaited below
  );

  if (await needsStartupLogin(agentDir)) {
    const { openLoginWindow } = require("../login/login-window");
    const outcome = await openLoginWindow({ agentDir, baseUrl: CGS_BASE_URL });
    if (outcome !== "cgs") {
      // Every build signs in through CGS; without it there is nothing to run.
      app.quit();
      return;
    }
  }

  cgsController = new CgsController({ agentDir, pluginDir: pluginSourceDir, agent: cgsAgent.client });
  cgsController.on("change", (snap) => {
    broadcastCgsState(snap);
  });
  cgsController.on("usage", broadcastUsage);

  createMainWindow();
  mainWindowCreated = true;
  const { Updater } = require("./updater");
  updater = new Updater({ app, onState: broadcastUpdate });
  updater.start();
  await mainWindow.loadFile(path.join(__dirname, "loading.html"));
  const started = await servicesReady;
  if (quitting) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL(started.url);
    cgsController.start();
  }
}

function broadcastCgsState(snap) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("cgs:state", snap);
  }
}

function broadcastUsage(usageSnap) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("cgs:usage", usageSnap);
  }
}

function broadcastNetwork(status) {
  networkStatus = status;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("cgs:network", status);
  }
}

function broadcastUpdate(state) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("cgs:update", state);
  }
}

// ---- window -------------------------------------------------------------------------------------------------------

const stateFile = () => path.join(app.getPath("userData"), "window-state.json");

function loadWindowState() {
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    const { x, y, width, height } = saved;
    if ([x, y, width, height].every(Number.isInteger) && width >= MIN_WIDTH && height >= MIN_HEIGHT) {
      const visible = screen.getAllDisplays().some((d) => {
        const b = d.workArea;
        return x < b.x + b.width && x + width > b.x && y < b.y + b.height && y + 40 > b.y;
      });
      if (visible) return { bounds: { x, y, width, height }, maximized: saved.maximized === true };
    }
  } catch {
    // no or unreadable state: use defaults
  }
  return { bounds: { width: 1360, height: 860 }, maximized: false };
}

function saveWindowState(win) {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
  } catch {
    // best effort
  }
}

function isAppUrl(url) {
  try {
    return appOrigin !== null && new URL(url).origin === appOrigin;
  } catch {
    return false;
  }
}

function openExternally(url) {
  try {
    const { protocol } = new URL(url);
    if (protocol === "http:" || protocol === "https:" || protocol === "mailto:") shell.openExternal(url);
  } catch {
    // malformed URL: ignore
  }
}

function secureWebPreferences() {
  return {
    preload: path.join(__dirname, "main-preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}

function guardNavigation(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          frame: false,
          backgroundColor: nativeTheme.shouldUseDarkColors ? "#1e1e1e" : "#ffffff",
          icon: getWindowIcon(),
          webPreferences: secureWebPreferences(),
        },
      };
    }
    openExternally(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (url.startsWith("file:") && url.endsWith("/loading.html")) return;
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternally(url);
  });
}

function broadcastWindowState(win) {
  if (win.isDestroyed()) return;
  win.webContents.send("cgs:window-state", { maximized: win.isMaximized() || win.isFullScreen() });
}

function createMainWindow() {
  const { bounds, maximized } = loadWindowState();
  const win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1e1e1e" : "#ffffff",
    title: "CGS Desktop",
    icon: getWindowIcon(),
    webPreferences: secureWebPreferences(),
  });
  mainWindow = win;
  guardNavigation(win.webContents);
  win.on("page-title-updated", (event, title) => {
    event.preventDefault();
    win.setTitle(windowTitle(title));
  });
  win.webContents.on("did-create-window", (child) => guardNavigation(child.webContents));
  win.once("ready-to-show", () => {
    if (maximized) win.maximize();
    win.show();
  });
  for (const event of ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) {
    win.on(event, () => broadcastWindowState(win));
  }
  win.on("close", () => saveWindowState(win));
  // The window regained focus: refresh the balance/subscription numbers unless they were fetched moments ago.
  win.on("focus", () => void cgsController?.refreshUsage({ minAgeMs: USAGE_FOCUS_MIN_AGE_MS }));
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

// ---- window-control IPC (see main-preload.js) ---------------------------------------------------------------------

function registerIpc() {
  const windowOf = (event) => BrowserWindow.fromWebContents(event.sender);
  ipcMain.on("cgs:window-minimize", (event) => windowOf(event)?.minimize());
  ipcMain.on("cgs:window-toggle-maximize", (event) => {
    const win = windowOf(event);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on("cgs:window-close", (event) => windowOf(event)?.close());
  ipcMain.handle("cgs:window-get-state", (event) => {
    const win = windowOf(event);
    return { maximized: win ? win.isMaximized() || win.isFullScreen() : false };
  });
  ipcMain.handle("cgs:get-state", async () => {
    if (!cgsController) return null;
    return cgsController.snapshot();
  });
  ipcMain.handle("cgs:open-login", async () => {
    if (!cgsController) return null;
    const { CGS_BASE_URL, notifyModelsChanged } = require("../cgs");
    const { openLoginWindow } = require("../login/login-window");
    const outcome = await openLoginWindow({ agentDir: cgsController.agentDir, baseUrl: CGS_BASE_URL });
    if (outcome === "cgs") {
      // ompweb only re-reads credentials.json (via its utility omp process) when models.yml changes.
      await notifyModelsChanged(cgsController.agentDir).catch(() => {});
      await cgsController.onLogin();
    }
    const snap = await cgsController.snapshot();
    broadcastCgsState(snap);
    return snap;
  });
  ipcMain.handle("cgs:refresh-account", async () => {
    if (!cgsController) return null;
    await Promise.all([cgsController.refresh(), cgsController.refreshUsage()]);
    return { state: await cgsController.snapshot(), usage: cgsController.usageSnapshot() };
  });
  ipcMain.handle("cgs:open-console", async (_event, page) => {
    if (!cgsController) return false;
    const { CGS_BASE_URL, readCredentials } = require("../cgs");
    const { consoleUrl } = require("../cgs/account");
    const creds = await readCredentials(cgsController.agentDir);
    const url = consoleUrl(creds ? creds.baseUrl : CGS_BASE_URL, page);
    const { openConsoleWindow } = require("./console-window");
    openConsoleWindow({ url, socketPath: cgsAgent ? cgsAgent.client.socketPath : null, icon: getWindowIcon() });
    return true;
  });
  ipcMain.handle("cgs:logout", async () => {
    if (!cgsController) return { ok: false, error: "CGS 尚未就绪" };
    try {
      const result = await cgsController.logout();
      const snap = await cgsController.snapshot();
      return { ok: true, serverRevoked: result.serverRevoked, cleanupErrors: result.cleanup.errors, state: snap };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("cgs:get-network", () => networkStatus);
  ipcMain.handle("cgs:get-usage", () => (cgsController ? cgsController.usageSnapshot() : null));
  ipcMain.handle("cgs:refresh-usage", () => (cgsController ? cgsController.refreshUsage() : null));
  // Self-update (see updater.js).
  ipcMain.handle("cgs:update-get", () => (updater ? updater.state() : null));
  ipcMain.handle("cgs:update-check", () => (updater ? updater.check() : null));
  ipcMain.handle("cgs:update-install", () => (updater ? updater.install() : false));
  ipcMain.handle("cgs:app-version", () => app.getVersion());
  // Settings → Agents orchestrator (see main-preload.js): config.yml modelRoles.default + task.agentModelOverrides.
  ipcMain.handle("cgs:orchestration-get", async () => {
    if (!cgsController) return { ok: false, error: "CGS not ready" };
    const { readOrchestration } = require("../cgs/config-writer");
    try {
      return { ok: true, orchestration: await readOrchestration(cgsController.agentDir) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("cgs:orchestration-save", async (_event, orchestration) => {
    if (!cgsController) return { ok: false, error: "CGS not ready" };
    const { writeOrchestration } = require("../cgs/config-writer");
    try {
      return { ok: true, orchestration: await writeOrchestration(cgsController.agentDir, orchestration) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  // The server's default layout (GET /api/device/layout), for "restore defaults"; never written here.
  ipcMain.handle("cgs:orchestration-defaults", async () => {
    if (!cgsController) return { ok: false, error: "CGS not ready" };
    const { fetchLayout, readCredentials } = require("../cgs/config-writer");
    const creds = await readCredentials(cgsController.agentDir);
    if (!creds) return { ok: false, error: "signed-out" };
    try {
      return { ok: true, layout: await fetchLayout({ baseUrl: creds.baseUrl, clientSecret: creds.clientSecret }) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  // ompweb's `omp-*` localStorage mirror (see prefs.js / main-preload.js): sync load before page scripts, async deltas.
  ipcMain.on("cgs:prefs-load", (event) => {
    event.returnValue = prefsStore().load();
  });
  ipcMain.on("cgs:prefs-save", (_event, delta) => prefsStore().apply(delta));
}

let cgsLogoDataUrl = null;
ipcMain.handle("cgs:get-logo", () => {
  if (cgsLogoDataUrl === null) {
    try {
      const svg = fs.readFileSync(path.join(APP_ROOT, "assets", "cgs-logo.svg"));
      cgsLogoDataUrl = `data:image/svg+xml;base64,${svg.toString("base64")}`;
    } catch {
      cgsLogoDataUrl = "";
    }
  }
  return cgsLogoDataUrl || null;
});
