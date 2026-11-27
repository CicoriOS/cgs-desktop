// Living in the tray (ADR 0046 §5): the close button hides the window instead of ending the session, the tray brings it
// back, and quitting with running work asks first. On a Linux desktop without a StatusNotifierWatcher the tray is not
// created and closing minimizes instead; quitting then goes through the menu or Ctrl+Q, which always exist.
//
// The window close prompt is drawn by the renderer (src/desktop/close-prompt.tsx) so it is styled and translated like the
// rest of the app; this module only asks and acts on the answer. Notifications are polled from the host's `/api/children`
// only while the window is hidden or unfocused, since ChildStatus.ring/unseen is the only signal the host exposes.
import { spawn as defaultSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const CLOSE_BEHAVIORS = ["ask", "background", "quit"];
export const DEFAULT_SETTINGS = { closeBehavior: "ask", autoCheck: true };
/** A 16x16 PNG so the tray works without shipping an icon file (the packaged app has no `public/`). */
const TRAY_ICON = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVR42mNgoAZQ6v7/nxw8nA2ouYIdjxpATwNGYkqkBAAA8ZUh9xSKAPAAAAAASUVORK5CYII=";
const POLL_INTERVAL_MS = 4000;

const REAL_IO = {
  readFileSync: (...args) => fs.readFileSync(...args),
  writeFileSync: (...args) => fs.writeFileSync(...args),
  mkdirSync: (...args) => fs.mkdirSync(...args),
  renameSync: (...args) => fs.renameSync(...args),
};

/** The shared `<userData>/desktop.json` settings; unknown or damaged contents fall back to the defaults. */
export function readSettings(file, io = {}) {
  const read = { ...REAL_IO, ...io };
  try {
    const raw = JSON.parse(read.readFileSync(file, "utf8"));
    const settings = { ...DEFAULT_SETTINGS };
    if (raw && typeof raw === "object") {
      if (typeof raw.closeBehavior === "string" && CLOSE_BEHAVIORS.includes(raw.closeBehavior)) settings.closeBehavior = raw.closeBehavior;
      if (typeof raw.autoCheck === "boolean") settings.autoCheck = raw.autoCheck;
    }
    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Merge one patch into the settings file; returns the merged settings. Persistence is best effort. */
export function writeSettings(file, patch, io = {}) {
  const write = { ...REAL_IO, ...io };
  const merged = { ...readSettings(file, io), ...patch };
  try {
    write.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    write.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
    write.renameSync(tmp, file);
  } catch {
    /* a setting that cannot be stored still applies to this run */
  }
  return merged;
}

/**
 * What a close request does. Without a tray, "background" would leave no way back, so the window minimizes and the
 * explicit quit entry stays the way out (ADR 0046 §5). An explicit `quit` setting wins over the fallback.
 */
export function decideClose({ behavior = "ask", trayAvailable = false, quitting = false } = {}) {
  if (quitting) return "quit";
  if (!trayAvailable) return behavior === "quit" ? "quit" : "minimize";
  if (behavior === "background") return "hide";
  if (behavior === "quit") return "quit";
  return "ask";
}

/**
 * Notifications between two `/api/children` snapshots: a conversation that stopped working, and one that wants attention
 * (unseen output while nobody was looking). The first snapshot only seeds the baseline.
 */
export function diffChildren(previous, next) {
  if (!previous) return [];
  const events = [];
  for (const child of next) {
    const before = previous.get(child.id);
    if (!before) continue;
    if ((before.ring === "work" || before.ring === "think") && child.ring === "idle") events.push({ kind: "finished", child });
    else if (!before.unseen && child.unseen) events.push({ kind: "attention", child });
  }
  return events;
}

function snapshot(children) {
  const map = new Map();
  for (const child of children) {
    if (typeof child !== "object" || child === null || typeof child.id !== "string") continue;
    map.set(child.id, {
      id: child.id,
      title: typeof child.title === "string" ? child.title : "",
      cwd: typeof child.cwd === "string" ? child.cwd : "",
      sessionPath: typeof child.sessionPath === "string" ? child.sessionPath : undefined,
      ring: child.ring === "work" || child.ring === "think" ? child.ring : "idle",
      unseen: child.unseen === true,
    });
  }
  return map;
}

const TEXT = {
  zh: {
    trayShow: "显示 CGS Desktop",
    trayQuit: "退出",
    quitTitle: "退出 CGS Desktop？",
    quitBody: "有运行的会话会被中断。",
    quitDetail: "退出后，这些会话里的任务会停止。",
    quitOk: "退出",
    quitCancel: "取消",
    finishedTitle: "对话已完成",
    attentionTitle: "对话需要你",
    fallbackName: "一个对话",
  },
  en: {
    trayShow: "Show CGS Desktop",
    trayQuit: "Quit",
    quitTitle: "Quit CGS Desktop?",
    quitBody: "Running sessions will be interrupted.",
    quitDetail: "Their tasks stop when the app quits.",
    quitOk: "Quit",
    quitCancel: "Cancel",
    finishedTitle: "Conversation finished",
    attentionTitle: "Conversation needs you",
    fallbackName: "A conversation",
  },
};

export function textsFor(app) {
  const lang = app?.getPreferredSystemLanguages?.()[0] ?? "";
  return /^zh(?:[-_]|$)/i.test(lang) ? TEXT.zh : TEXT.en;
}

/** Command output over a short deadline, or undefined when the tool cannot run. */
function commandOutput(command, args, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let timer;
    try {
      child = defaultSpawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      finish(undefined);
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      finish(undefined);
    }, timeoutMs);
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", () => finish(undefined));
    child.on("close", () => finish(output));
  });
}

/**
 * Whether a Linux session has a StatusNotifierWatcher (ADR 0046 §5: D-Bus, not `XDG_CURRENT_DESKTOP`).
 * `true`/`false` when a tool answered, `undefined` when no probe tool exists — then tray creation itself decides.
 * `CGS_TRAY=1|0` overrides the probe (the Electron smoke uses it to exercise both paths under Xvfb).
 */
export async function probeTray({ env = process.env, platform = process.platform } = {}) {
  if (env.CGS_TRAY === "1") return true;
  if (env.CGS_TRAY === "0") return false;
  if (platform !== "linux") return true;
  const gdbus = await commandOutput("gdbus", [
    "call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus",
    "--method", "org.freedesktop.DBus.NameHasOwner", "org.kde.StatusNotifierWatcher",
  ]);
  if (gdbus !== undefined) return /true/.test(gdbus);
  const busctl = await commandOutput("busctl", [
    "--user", "call", "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "NameHasOwner",
    "s", "org.kde.StatusNotifierWatcher",
  ]);
  if (busctl !== undefined) return /true/.test(busctl);
  return undefined;
}

export function desktopSettingsFile(app) {
  return path.join(app.getPath("userData"), "desktop.json");
}

/**
 * Wires the tray, the close behaviour and the background notifications. Everything platform-specific is injected
 * (`Tray`, `Menu`, `Notification`, `dialog`) so the module has no Electron import and can be unit tested.
 */
export function startResident({
  app,
  Tray,
  Menu,
  Notification,
  dialog,
  ipcMain,
  nativeImage,
  requestHost,
  env = process.env,
  probe = probeTray,
  fs: fsOverride,
  platform = process.platform,
  createWindow,
} = {}) {
  const settingsFile = desktopSettingsFile(app);
  const io = { ...REAL_IO, ...fsOverride };
  let settings = readSettings(settingsFile, io);
  const texts = textsFor(app);
  let win;
  let tray;
  let trayState = "unknown"; // unknown | available | unavailable
  let quitting = false;
  let confirming = false;
  let promptOpen = false;
  let pollTimer;
  let baseline;
  let polling = false;

  const send = (channel, ...args) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  };

  const trayAvailable = () => trayState === "available";

  function attachWindow(window) {
    win = window;
    window.on("close", onClose);
    for (const event of ["show", "hide", "focus", "blur", "minimize", "restore"]) window.on(event, syncPolling);
    syncPolling();
  }

  function showWindow() {
    if (!win || win.isDestroyed()) {
      const created = createWindow?.();
      if (created) attachWindow(created);
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  /** Running work from the host's child list; anything the host cannot answer counts as none. */
  async function runningCount() {
    try {
      const answer = await requestHost("/api/children");
      const body = answer?.body;
      const children = body && typeof body === "object" && "children" in body ? body.children : undefined;
      if (!Array.isArray(children)) return 0;
      return children.filter((child) => child && typeof child === "object" && "ring" in child && child.ring !== "idle").length;
    } catch {
      return 0;
    }
  }

  async function confirmQuit() {
    const count = await runningCount();
    if (count === 0) return true;
    const options = {
      type: "warning",
      buttons: [texts.quitOk, texts.quitCancel],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: texts.quitTitle,
      message: texts.quitBody,
      detail: texts.quitDetail,
    };
    const answer = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return answer.response === 0;
  }

  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (confirming) return;
    confirming = true;
    void confirmQuit().then((accepted) => {
      confirming = false;
      if (!accepted) return;
      quitting = true;
      app.quit();
    });
  });

  /** Polls `/api/children` only while nobody can see the window; the first answer seeds the baseline. */
  function syncPolling() {
    const hidden = Boolean(win && !win.isDestroyed() && (!win.isVisible() || !win.isFocused()));
    if (hidden && !polling) {
      polling = true;
      baseline = undefined;
      pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
      pollTimer.unref?.();
      void poll();
    } else if (!hidden && polling) {
      polling = false;
      clearInterval(pollTimer);
      pollTimer = undefined;
      baseline = undefined;
    }
  }

  async function poll() {
    if (!polling) return;
    let answer;
    try {
      answer = await requestHost("/api/children");
    } catch {
      return; // the link is down; the next tick tries again
    }
    const body = answer?.body;
    const children = body && typeof body === "object" && "children" in body ? body.children : undefined;
    if (!Array.isArray(children) || !polling) return;
    const next = snapshot(children);
    if (baseline) {
      for (const event of diffChildren(baseline, [...next.values()])) notify(event);
    }
    baseline = next;
  }

  function notify({ kind, child }) {
    if (!Notification?.isSupported?.()) return;
    const title = kind === "finished" ? texts.finishedTitle : texts.attentionTitle;
    const notification = new Notification({ title, body: child.title || texts.fallbackName, silent: false });
    notification.on("click", () => {
      showWindow();
      send("cgs:shell:open-child", { id: child.id, sessionPath: child.sessionPath, cwd: child.cwd });
    });
    notification.show();
  }

  function answerClose(answer) {
    if (!promptOpen) return;
    promptOpen = false;
    const action = answer?.action;
    if (action !== "background" && action !== "quit" && action !== "cancel") return;
    if (answer?.remember === true && action !== "cancel") settings = writeSettings(settingsFile, { closeBehavior: action }, io);
    if (action === "background") win?.hide();
    else if (action === "quit") app.quit();
  }

  function onClose(event) {
    if (quitting) return;
    event.preventDefault();
    const action = decideClose({ behavior: settings.closeBehavior, trayAvailable: trayAvailable() });
    if (action === "quit") {
      app.quit();
      return;
    }
    if (action === "hide") {
      win?.hide();
      return;
    }
    if (action === "minimize") {
      win?.minimize();
      return;
    }
    if (promptOpen) return;
    promptOpen = true;
    send("cgs:shell:close-prompt");
    // The renderer may be gone (crash/reload); the app must not stay unclosable forever.
    setTimeout(() => {
      if (promptOpen && (!win || win.isDestroyed())) promptOpen = false;
    }, 5000).unref?.();
  }

  async function createTray() {
    const probed = await probe({ env, platform });
    if (probed === false) {
      trayState = "unavailable";
      return;
    }
    try {
      const image = nativeImage?.createFromDataURL?.(`data:image/png;base64,${TRAY_ICON}`);
      tray = new Tray(image);
      tray.setToolTip("CGS Desktop");
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: texts.trayShow, click: showWindow },
        { type: "separator" },
        { label: texts.trayQuit, click: () => app.quit() },
      ]));
      tray.on("click", showWindow);
      trayState = "available";
    } catch {
      trayState = "unavailable";
      tray?.destroy?.();
      tray = undefined;
    }
  }

  const menu = () => Menu.buildFromTemplate([
    {
      label: "CGS Desktop",
      submenu: [
        { label: texts.trayShow, click: showWindow },
        { type: "separator" },
        { label: texts.trayQuit, accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
      ],
    },
    { role: "editMenu" },
  ]);

  return {
    /** Probe the tray and install the quit guard; resolves once the tray state is known. */
    async start() {
      await app.whenReady();
      ipcMain.on("cgs:shell:close-answer", (_event, answer) => answerClose(answer));
      Menu.setApplicationMenu(menu());
      await createTray();
    },
    /** Called for each window the shell creates; the last one is the window tray and notifications act on. */
    attach(window) {
      attachWindow(window);
    },
    /** A quit that must not be confirmed again (the updater already asked); the sidecar is down by then. */
    allowQuit() {
      quitting = true;
    },
    /** A window was closed for real (crash/reload gap): stay alive while the tray is there. */
    stayResident() {
      return trayAvailable();
    },
    showWindow,
    quit: () => app.quit(),
    trayAvailable,
    closeBehavior: () => settings.closeBehavior,
    settings: () => ({ ...settings }),
    /** Used by tests and the smoke harness. */
    stop() {
      clearInterval(pollTimer);
      polling = false;
      tray?.destroy?.();
      tray = undefined;
    },
  };
}
