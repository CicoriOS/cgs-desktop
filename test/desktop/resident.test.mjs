// Close-to-background and tray fallback (ADR 0046 §5): the settings file, the close decision, notification diffs, and the
// resident module against fake Electron objects (no window, tray or D-Bus is created).
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { decideClose, diffChildren, probeTray, readSettings, startResident, writeSettings } from "../../desktop/resident.mjs";

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cgs-resident-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("settings default to asking and survive a damaged file", () => {
  const file = path.join(tempDir(), "desktop.json");
  expect(readSettings(file)).toEqual({ closeBehavior: "ask", autoCheck: true });
  writeFileSync(file, "{not json");
  expect(readSettings(file)).toEqual({ closeBehavior: "ask", autoCheck: true });
  writeFileSync(file, JSON.stringify({ closeBehavior: "sideways", autoCheck: "yes" }));
  expect(readSettings(file)).toEqual({ closeBehavior: "ask", autoCheck: true });
});

test("writing one setting keeps the others", () => {
  const file = path.join(tempDir(), "desktop.json");
  writeSettings(file, { autoCheck: false });
  const merged = writeSettings(file, { closeBehavior: "background" });
  expect(merged).toEqual({ closeBehavior: "background", autoCheck: false });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ closeBehavior: "background", autoCheck: false });
});

test("close: ask only with a tray; otherwise minimize unless quitting was chosen", () => {
  expect(decideClose({ behavior: "ask", trayAvailable: true })).toBe("ask");
  expect(decideClose({ behavior: "ask", trayAvailable: false })).toBe("minimize");
  expect(decideClose({ behavior: "background", trayAvailable: true })).toBe("hide");
  expect(decideClose({ behavior: "background", trayAvailable: false })).toBe("minimize");
  expect(decideClose({ behavior: "quit", trayAvailable: true })).toBe("quit");
  expect(decideClose({ behavior: "quit", trayAvailable: false })).toBe("quit");
  expect(decideClose({ behavior: "ask", trayAvailable: true, quitting: true })).toBe("quit");
});

test("notification diffs: finished work and unseen output, never on the baseline", () => {
  const before = new Map([
    ["a", { id: "a", ring: "work", unseen: false }],
    ["b", { id: "b", ring: "idle", unseen: false }],
    ["c", { id: "c", ring: "think", unseen: false }],
  ]);
  const next = [
    { id: "a", ring: "idle", unseen: true },
    { id: "b", ring: "idle", unseen: true },
    { id: "c", ring: "think", unseen: false },
  ];
  const events = diffChildren(before, next);
  expect(events.map((event) => [event.kind, event.child.id])).toEqual([["finished", "a"], ["attention", "b"]]);
  expect(diffChildren(undefined, next)).toEqual([]);
});

test("the tray probe follows CGS_TRAY and the D-Bus tools", async () => {
  expect(await probeTray({ env: { CGS_TRAY: "1" }, platform: "linux" })).toBe(true);
  expect(await probeTray({ env: { CGS_TRAY: "0" }, platform: "linux" })).toBe(false);
  expect(await probeTray({ env: {}, platform: "darwin" })).toBe(true);
});

function fakeElectron({ root }) {
  const quit = vi.fn();
  const app = {
    whenReady: async () => {},
    on: vi.fn(),
    quit,
    getPath: () => root,
    getPreferredSystemLanguages: () => ["en"],
  };
  class Tray extends EventEmitter {
    setToolTip() {}
    setContextMenu() {}
    destroy() {}
  }
  const windows = [];
  class FakeWindow extends EventEmitter {
    destroyed = false;
    minimized = false;
    visible = true;
    focused = true;
    sent = [];
    constructor() {
      super();
      windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    isMinimized() {
      return this.minimized;
    }
    isVisible() {
      return this.visible;
    }
    isFocused() {
      return this.focused;
    }
    hide() {
      this.visible = false;
    }
    show() {
      this.visible = true;
    }
    minimize() {
      this.minimized = true;
    }
    restore() {
      this.minimized = false;
    }
    focus() {}
    webContents = { send: (channel) => this.sent.push(channel) };
  }
  const handlers = new Map();
  const ipcMain = { on: (channel, handler) => handlers.set(channel, handler) };
  const Menu = { buildFromTemplate: (template) => ({ template }), setApplicationMenu: vi.fn() };
  return { app, Tray, FakeWindow, Menu, ipcMain, handlers, quit, windows };
}

test("with a tray, the close prompt can put the window in the background and remember it", async () => {
  const root = tempDir();
  const electron = fakeElectron({ root });
  const resident = startResident({
    app: electron.app,
    Tray: electron.Tray,
    Menu: electron.Menu,
    Notification: { isSupported: () => false },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    ipcMain: electron.ipcMain,
    nativeImage: { createFromDataURL: () => ({}) },
    requestHost: async () => ({ status: 200, body: { children: [] } }),
    env: { CGS_TRAY: "1" },
  });
  await resident.start();
  expect(resident.trayAvailable()).toBe(true);
  const win = new electron.FakeWindow();
  resident.attach(win);
  win.emit("close", { preventDefault() {} });
  expect(win.sent).toContain("cgs:shell:close-prompt");
  expect(win.visible).toBe(true);
  electron.handlers.get("cgs:shell:close-answer")(null, { action: "background", remember: true });
  expect(win.visible).toBe(false);
  expect(readSettings(path.join(root, "desktop.json")).closeBehavior).toBe("background");
});

test("without a tray, close minimizes and the explicit quit entry remains", async () => {
  const root = tempDir();
  const electron = fakeElectron({ root });
  const resident = startResident({
    app: electron.app,
    Tray: electron.Tray,
    Menu: electron.Menu,
    Notification: { isSupported: () => false },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    ipcMain: electron.ipcMain,
    nativeImage: { createFromDataURL: () => ({}) },
    requestHost: async () => ({ status: 200, body: { children: [] } }),
    env: { CGS_TRAY: "0" },
  });
  await resident.start();
  expect(resident.trayAvailable()).toBe(false);
  const win = new electron.FakeWindow();
  resident.attach(win);
  win.emit("close", { preventDefault() {} });
  expect(win.minimized).toBe(true);
  expect(win.sent).not.toContain("cgs:shell:close-prompt");
  expect(resident.stayResident()).toBe(false);
  const menu = electron.Menu.setApplicationMenu.mock.calls[0][0];
  expect(JSON.stringify(menu.template)).toContain("CmdOrCtrl+Q");
  resident.quit();
  expect(electron.quit).toHaveBeenCalled();
});
