// The updater maps electron-updater's events to the renderer's four phases, never touches the network in a development
// run, and asks before an install interrupts running sessions. electron-updater itself is faked.
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createUpdater, reduceStatus } from "../../desktop/updater.mjs";

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cgs-updater-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeApp({ packaged = true } = {}) {
  const root = tempDir();
  return {
    isPackaged: packaged,
    getVersion: () => "0.3.0",
    getPath: () => root,
    getPreferredSystemLanguages: () => ["en"],
    root,
  };
}

class FakeUpdater extends EventEmitter {
  checks = 0;
  downloads = 0;
  installed = [];
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  async checkForUpdates() {
    this.checks += 1;
    this.emit("checking-for-update");
    this.emit("update-available", { version: "0.4.0" });
    return {};
  }
  async downloadUpdate() {
    this.downloads += 1;
    this.emit("download-progress", { percent: 42.4 });
    this.emit("update-downloaded", { version: "0.4.0" });
  }
  quitAndInstall(silent, force) {
    this.installed.push([silent, force]);
  }
}

test("electron-updater events become the renderer phases", () => {
  const idle = { phase: "idle" };
  expect(reduceStatus(idle, "update-available", { version: "0.4.0" })).toEqual({ phase: "available", version: "0.4.0", percent: 0 });
  expect(reduceStatus({ phase: "available", version: "0.4.0" }, "download-progress", { percent: 42.4 })).toEqual({ phase: "downloading", version: "0.4.0", percent: 42 });
  expect(reduceStatus({ phase: "downloading", version: "0.4.0" }, "update-downloaded", { version: "0.4.0" })).toEqual({ phase: "downloaded", version: "0.4.0", percent: 100 });
  expect(reduceStatus(idle, "update-not-available")).toEqual({ phase: "idle" });
  expect(reduceStatus({ phase: "downloaded", version: "0.4.0", percent: 100 }, "error", new Error("late"))).toMatchObject({ phase: "downloaded" });
  expect(reduceStatus(idle, "error", new Error("offline"))).toEqual({ phase: "error", error: "offline" });
});

test("a development run checks without a network or a download", async () => {
  const app = fakeApp({ packaged: false });
  const updater = new FakeUpdater();
  updater.checkForUpdates = () => {
    throw new Error("must not check in development");
  };
  const api = createUpdater({ app, autoUpdater: updater, env: {}, settingsFile: path.join(app.root, "desktop.json") });
  await expect(api.check()).resolves.toEqual({ version: "0.3.0" });
  await api.download();
  expect(api.status()).toEqual({ phase: "idle" });
  expect(api.enabled()).toBe(false);
});

test("check, download and install follow the user's clicks", async () => {
  const app = fakeApp();
  const updater = new FakeUpdater();
  const shutdownHost = vi.fn(async () => {});
  const requestHost = vi.fn(async () => ({ status: 200, body: { children: [{ id: "c1", ring: "work" }] } }));
  const dialog = { showMessageBox: vi.fn(async () => ({ response: 0 })) };
  const api = createUpdater({ app, autoUpdater: updater, requestHost, dialog, shutdownHost, env: {}, settingsFile: path.join(app.root, "desktop.json") });

  await expect(api.check()).resolves.toEqual({ version: "0.3.0", available: "0.4.0" });
  expect(api.status()).toMatchObject({ phase: "available", version: "0.4.0" });
  await api.download();
  expect(api.status()).toEqual({ phase: "downloaded", version: "0.4.0", percent: 100 });
  await api.install();
  expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  expect(shutdownHost).toHaveBeenCalledTimes(1);
  expect(updater.installed).toEqual([[false, true]]);
});

test("cancelling the running-sessions warning keeps the app running", async () => {
  const app = fakeApp();
  const updater = new FakeUpdater();
  const shutdownHost = vi.fn(async () => {});
  const dialog = { showMessageBox: vi.fn(async () => ({ response: 1 })) };
  const api = createUpdater({
    app,
    autoUpdater: updater,
    requestHost: async () => ({ status: 200, body: { children: [{ id: "c1", ring: "think" }] } }),
    dialog,
    shutdownHost,
    env: {},
    settingsFile: path.join(app.root, "desktop.json"),
  });
  await api.check();
  await api.download();
  await api.install();
  expect(shutdownHost).not.toHaveBeenCalled();
  expect(updater.installed).toEqual([]);
});

test("the auto-check setting is stored next to the resident settings", async () => {
  const app = fakeApp({ packaged: false });
  const file = path.join(app.root, "desktop.json");
  const api = createUpdater({ app, autoUpdater: new FakeUpdater(), env: {}, settingsFile: file });
  expect(await api.getAutoCheck()).toBe(true);
  await api.setAutoCheck(false);
  expect(await api.getAutoCheck()).toBe(false);
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ autoCheck: false });
});
