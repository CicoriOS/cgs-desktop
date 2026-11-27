// The Electron shell: a window around the web client and nothing else. All UI is the Vite + React app in src/, so every change to the
// web client shows up here unchanged (architecture.md: the main process only supervises).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, shell } from "electron";

const url = process.env.CGS_DEV_URL;
if (!url) {
  console.error("CGS_DEV_URL is not set: start the shell with `bun run desktop`.");
  app.exit(1);
}

if (!app.requestSingleInstanceLock()) app.exit(0);

app.on("second-instance", () => {
  const [win] = BrowserWindow.getAllWindows();
  if (!win) return;
  if (win.isMinimized()) win.restore();
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
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on("window-all-closed", () => app.quit());
