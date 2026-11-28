// The Electron shell: a window around the web client and nothing else. All UI is the Vite + React app in src/, so every change to the
// web client shows up here unchanged (architecture.md: the main process only supervises).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, Notification, protocol, shell, Tray } from "electron";
import { APP_URL, handleAppRequests, registerAppScheme } from "./app-protocol.mjs";
import { SHELL_SYNC, createCliSync, registerCliSyncIpc, restartConfirmer } from "./cli-sync.mjs";
import { requestHost, shutdownLocalHost, startLocalHost } from "./host-ipc.mjs";
import { startResident } from "./resident.mjs";
import { createUpdater, registerUpdaterIpc } from "./updater.mjs";
import { registerWorkspaceIpc } from "./workspace.mjs";

// A packaged app loads the built page from disk; the dev shell passes its Vite URL in CGS_DEV_URL.
const devUrl = process.env.CGS_DEV_URL;
if (!devUrl && !app.isPackaged) {
  console.error("CGS_DEV_URL is not set: start the shell with `bun run desktop`.");
  app.exit(1);
}
// A packaged app serves dist/ over `cgs://`; modules cannot load from file:// (see app-protocol.mjs).
const distRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
if (app.isPackaged) registerAppScheme(protocol);
const url = devUrl ?? APP_URL;
/** `?demo` is in-memory: no sidecar, so the demo dev shell never touches the real daemon. */
const demo = new URL(url).searchParams.has("demo");

if (!app.requestSingleInstanceLock()) app.exit(0);

const broadcast = (channel, ...args) => {
  for (const win of BrowserWindow.getAllWindows()) if (!win.webContents.isDestroyed()) win.webContents.send(channel, ...args);
};

// CLI sync runs first (ADR 0046 §3): the sidecar starts only with the CLI copy it validated. The page subscribes to the
// sync state through `window.cgsDesktop.shell`, so a failure has its own page instead of a dead link.
// `net.fetch` follows the system proxy, which the bun download needs where GitHub is only reachable through one.
const sync = demo ? undefined : createCliSync({ app, env: process.env, confirmRestart: restartConfirmer({ app, dialog }), fetch: (...args) => net.fetch(...args) });
let hostStarted = false;
/** The sidecar starts exactly once, when the CLI sync reports a usable CLI (also after a retry from its error page). */
function startHostFromSync(state) {
  if (hostStarted || state.phase !== "ready") return;
  hostStarted = true;
  startLocalHost({ cgs: state.cgs, env: process.env });
}
if (sync) {
  registerCliSyncIpc(ipcMain, sync);
  sync.subscribe((state) => {
    broadcast(SHELL_SYNC, state);
    startHostFromSync(state);
  });
}

// Tray, close-to-background, quit confirmation and background notifications (ADR 0046 §5).
const resident = startResident({ app, Tray, Menu, Notification, dialog, ipcMain, nativeImage, requestHost, env: process.env, createWindow });

// Desktop updates (ADR 0046 §6): check-only in development, electron-updater when packaged.
const updater = createUpdater({ app, requestHost, dialog, shutdownHost: async () => { await shutdownLocalHost(); resident.allowQuit(); }, env: process.env });
registerUpdaterIpc(ipcMain, updater);
updater.subscribe((status) => broadcast("cgs:updater:changed", status));

app.on("second-instance", () => {
  const [win] = BrowserWindow.getAllWindows();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
});

/**
 * Frosted glass behind the sidebar comes from the OS: macOS vibrancy, Windows 11 acrylic. Linux has no window-level blur that Electron can
 * ask for (compositors differ and none exposes it), so there the sidebar stays a solid tint; the page tells the two apart by `glass`.
 */
function glassOptions() {
  if (process.platform === "darwin") return { vibrancy: "sidebar", visualEffectState: "active", backgroundColor: "#00000000" };
  if (process.platform === "win32" && Number(os.release().split(".")[2]) >= 22621) return { backgroundMaterial: "acrylic", backgroundColor: "#00000000" };
  return undefined;
}

// The window buttons the page draws. Each acts on the window that asked.
const windowOf = (event) => BrowserWindow.fromWebContents(event.sender);
ipcMain.on("window:minimize", (event) => windowOf(event)?.minimize());
ipcMain.on("window:toggleMaximize", (event) => {
  const win = windowOf(event);
  if (win) win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on("window:close", (event) => windowOf(event)?.close());
ipcMain.handle("window:isMaximized", (event) => windowOf(event)?.isMaximized() ?? false);

// Which of the dropped paths are folders (the page only gets File objects, which cannot tell).
ipcMain.handle("fs:areDirectories", (_event, paths) =>
  Promise.all(paths.map((p) => fs.stat(p).then((st) => st.isDirectory(), () => false))),
);

// Files and Git for the right panel (`WorkspaceApi`): Node fs plus the git CLI, so the work stays in the main process.
registerWorkspaceIpc(ipcMain);

function createWindow() {
  const glass = glassOptions();
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 420,
    minHeight: 520,
    title: "CGS Desktop",
    // The title bar and the window buttons are drawn by the page (src/ui/WindowControls.tsx), not by GTK or the OS.
    frame: false,
    ...glass,
    webPreferences: {
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
      additionalArguments: glass ? ["--cgs-glass"] : [],
      contextIsolation: true,
      sandbox: true,
    },
  });
  for (const event of ["maximize", "unmaximize"]) win.on(event, () => win.webContents.send("window:maximized", win.isMaximized()));
  // Links leave the app: the window only ever shows the client.
  const origin = new URL(url).origin;
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== origin) {
      event.preventDefault();
      if (/^https?:/.test(target)) void shell.openExternal(target);
    }
  });
  void win.loadURL(url);
  return win;
}

app.whenReady().then(() => {
  if (app.isPackaged) handleAppRequests({ protocol, root: distRoot });
  resident.attach(createWindow());
  void resident.start();
  updater.start();
  // The sidecar waits for the CLI sync; a failure shows its page and `shell.retry` runs the same start path again.
  if (sync) void sync.start();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) resident.attach(createWindow());
  });
});

app.on("window-all-closed", () => {
  // With a tray the app lives on until the explicit quit entry (resident); without one, closing the last window ends it.
  if (!resident.stayResident()) app.quit();
});
