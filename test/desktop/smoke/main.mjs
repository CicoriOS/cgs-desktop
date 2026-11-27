// Xvfb smoke of the shell's window behaviour (ADR 0046 §3, §5): the close prompt and its background path with a fake
// sidecar, the no-tray fallback, and the CLI-sync failure page. Runs the real preload and the built SPA; fake Electron
// objects are used only where a headless X has none (the tray host). Screenshots go to /tmp/cgs-*.png.
//
// Usage: xvfb-run -a electron test/desktop/smoke/main.mjs --no-sandbox [--close|--fallback|--sync-error]
// Requires `bun run build:desktop` first.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, Notification, dialog, ipcMain, nativeImage, protocol } from "electron";
import { APP_URL, handleAppRequests, registerAppScheme } from "../../../desktop/app-protocol.mjs";
import { SHELL_SYNC, createCliSync, registerCliSyncIpc } from "../../../desktop/cli-sync.mjs";
import { shutdownLocalHost, startLocalHost } from "../../../desktop/host-ipc.mjs";
import { startResident } from "../../../desktop/resident.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const fixture = path.join(root, "test", "fixtures", "fake-sidecar.mjs");
const page = path.join(root, "dist", "index.html");
const mode = process.argv.includes("--fallback") ? "fallback" : process.argv.includes("--sync-error") ? "sync-error" : "close";

app.disableHardwareAcceleration();
app.setPath("userData", mkdtempSync(path.join(os.tmpdir(), "cgs-smoke-userdata-")));
// Same transport as a packaged app: `cgs://` over dist/ (ES modules do not load from file://).
registerAppScheme(protocol);

class FakeTray {
  setToolTip() {}
  setContextMenu() {}
  on() {}
  destroy() {}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: true,
    frame: false,
    webPreferences: {
      preload: path.join(root, "desktop", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) console.error(`renderer: ${message}`);
  });
  win.webContents.on("did-fail-load", (_event, code, description) => console.error(`load failed: ${code} ${description}`));
  void win.loadURL(APP_URL);
  return win;
}

async function waitFor(win, expression, timeout = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const value = await win.webContents.executeJavaScript(expression);
      if (value) return value;
    } catch {
      /* the document is still loading */
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for: ${expression}`);
}

async function screenshot(win, file) {
  const image = await win.webContents.capturePage();
  writeFileSync(file, image.toPNG());
  console.log(`screenshot: ${file}`);
}

function fakeSidecarEnv() {
  // The fixture is a Node script; this Electron process is not a Node runtime.
  return { ...process.env, CGS_SIDECAR: JSON.stringify(["node", fixture]), FAKE_SIDECAR_PHASE: "ready" };
}

async function closeSmoke() {
  console.error("smoke: close start");
  ipcMain.handle("cgs:shell:sync", () => ({ phase: "ready" }));
  const env = { ...fakeSidecarEnv(), CGS_TRAY: "1" };
  startLocalHost({ env });
  const resident = startResident({
    app,
    Tray: FakeTray,
    Menu,
    Notification,
    dialog,
    ipcMain,
    nativeImage,
    requestHost: async () => ({ status: 200, body: { children: [] } }),
    env,
    probe: async () => true,
  });
  await resident.start();
  console.error(`smoke: resident started tray=${resident.trayAvailable()}`);
  const win = createWindow();
  resident.attach(win);
  console.error("smoke: window created");
  await waitFor(win, "document.querySelector('#app') !== null");
  console.error("smoke: app mounted");
  win.focus();
  win.close();
  await waitFor(win, "document.querySelector('[data-close-prompt]') !== null");
  await screenshot(win, "/tmp/cgs-close-dialog.png");
  await win.webContents.executeJavaScript("document.querySelector('[data-close-action=background]').click()");
  const hidden = Date.now();
  while (win.isVisible() && Date.now() - hidden < 5000) await sleep(50);
  if (win.isVisible()) throw new Error("the window stayed visible after 'Run in background'");
  resident.showWindow();
  if (!win.isVisible()) throw new Error("the tray's Show did not bring the window back");
  console.log("SMOKE close: prompt -> background -> show: OK");
  await shutdownLocalHost();
}

async function fallbackSmoke() {
  console.error("smoke: fallback start");
  ipcMain.handle("cgs:shell:sync", () => ({ phase: "ready" }));
  const env = { ...fakeSidecarEnv(), CGS_TRAY: "0" };
  startLocalHost({ env });
  const resident = startResident({
    app,
    Tray: FakeTray,
    Menu,
    Notification,
    dialog,
    ipcMain,
    nativeImage,
    requestHost: async () => ({ status: 200, body: { children: [] } }),
    env,
    probe: async () => false,
  });
  await resident.start();
  console.error(`smoke: resident started tray=${resident.trayAvailable()}`);
  if (resident.trayAvailable()) throw new Error("the tray is reported available without a StatusNotifierWatcher");
  const win = createWindow();
  resident.attach(win);
  console.error("smoke: window created");
  await waitFor(win, "document.querySelector('#app') !== null");
  console.error("smoke: app mounted");
  // Xvfb runs no window manager, so `isMinimized()` never becomes true; record the call the resident makes instead.
  let minimized = false;
  const minimize = win.minimize.bind(win);
  win.minimize = () => {
    minimized = true;
    minimize();
  };
  win.close();
  const started = Date.now();
  while (!minimized && Date.now() - started < 5000) await sleep(50);
  if (!minimized) throw new Error("close did not minimize without a tray");
  const prompted = await win.webContents.executeJavaScript("document.querySelector('[data-close-prompt]') !== null");
  if (prompted) throw new Error("the close prompt appeared without a tray");
  if (win.isDestroyed()) throw new Error("the window was destroyed instead of minimized");
  console.log("SMOKE fallback: no tray -> minimize, app still running: OK");
  await shutdownLocalHost();
}

async function syncErrorSmoke() {
  const home = mkdtempSync(path.join(os.tmpdir(), "cgs-smoke-home-"));
  const bin = path.join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const cgs = path.join(bin, "cgs");
  writeFileSync(cgs, "#!/bin/sh\necho cgs/19.2.1-cgs.6.1\n");
  chmodSync(cgs, 0o755);
  // BUN_INSTALL makes this a bun-global copy, so the plan answers cgs_too_new instead of the CGS_BIN dev override.
  const env = { ...process.env, HOME: home, BUN_INSTALL: home, PATH: `${bin}:/usr/bin:/bin`, PI_CONFIG_DIR: ".cgs", CGS_TRAY: "0" };
  const sync = createCliSync({ app, env, home, boundVersion: "19.2.1-cgs.5.4" });
  registerCliSyncIpc(ipcMain, sync);
  sync.subscribe((state) => {
    for (const win of BrowserWindow.getAllWindows()) if (!win.webContents.isDestroyed()) win.webContents.send(SHELL_SYNC, state);
  });
  const state = await sync.start();
  if (state.phase !== "refused" || state.code !== "cgs_too_new") throw new Error(`expected a refusal, got ${JSON.stringify(state)}`);
  const win = createWindow();
  await waitFor(win, "document.querySelector('[data-host-state=\"sync\"]') !== null");
  await screenshot(win, "/tmp/cgs-cli-sync-error.png");
  console.log("SMOKE sync: newer-major refusal page: OK");
}

// No top-level await: Electron emits `ready` only after the entry module settles, so awaiting it there deadlocks.
app.whenReady().then(async () => {
  console.error("smoke: app ready");
  handleAppRequests({ protocol, root: path.join(root, "dist") });
  // The page's window buttons and the updater expect these; the smoke drives close itself and has no updater.
  ipcMain.handle("window:isMaximized", () => false);
  ipcMain.handle("cgs:updater:status", () => ({ phase: "idle" }));
  ipcMain.handle("cgs:updater:getAutoCheck", () => true);
  ipcMain.handle("cgs:updater:check", () => ({ version: app.getVersion() }));
  try {
    if (!existsSync(page)) throw new Error(`missing ${page}; run \`bun run build:desktop\` first`);
    if (mode === "sync-error") await syncErrorSmoke();
    else if (mode === "fallback") await fallbackSmoke();
    else await closeSmoke();
    app.exit(0);
  } catch (error) {
    console.error(`SMOKE ${mode} FAILED: ${error instanceof Error ? error.stack : String(error)}`);
    await shutdownLocalHost().catch(() => {});
    app.exit(1);
  }
});
