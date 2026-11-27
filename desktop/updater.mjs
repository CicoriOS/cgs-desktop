// Desktop updates (ADR 0046 §6): electron-updater against the GitHub provider configured in package.json `build.publish`.
// Only the user installs: the app checks at startup and every four hours, shows an available version as a red dot on the
// settings gear, downloads on request, and installs through `quitAndInstall` after stopping the sidecar. A development run
// (`app.isPackaged === false`) never touches the network.
import { createRequire } from "node:module";
import { desktopSettingsFile, readSettings, writeSettings } from "./resident.mjs";

export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** `UpdaterStatus.phase`; the renderer type in src/desktop/protocol.ts mirrors this. */
const EMPTY_STATUS = { phase: "idle" };

const require = createRequire(import.meta.url);

/** electron-updater is a production dependency; a missing module disables updates instead of breaking startup. */
export function loadAutoUpdater() {
  try {
    const module = require("electron-updater");
    return module?.autoUpdater;
  } catch {
    return undefined;
  }
}

const TEXT = {
  zh: {
    title: "重启并安装更新？",
    body: "有运行的会话会被中断。",
    detail: "安装会退出 CGS Desktop，重新打开后使用新版本。",
    install: "重启并安装",
    cancel: "取消",
  },
  en: {
    title: "Restart and install the update?",
    body: "Running sessions will be interrupted.",
    detail: "Installing quits CGS Desktop; it reopens on the new version.",
    install: "Restart and install",
    cancel: "Cancel",
  },
};

function textsFor(app) {
  const lang = app?.getPreferredSystemLanguages?.()[0] ?? "";
  return /^zh(?:[-_]|$)/i.test(lang) ? TEXT.zh : TEXT.en;
}

/** Maps electron-updater's events onto the four phases the renderer knows. */
export function reduceStatus(state, event, payload) {
  switch (event) {
    case "checking-for-update":
      return { phase: "idle" };
    case "update-available":
      return { phase: "available", version: payload?.version, percent: 0 };
    case "update-not-available":
      return { phase: "idle" };
    case "download-progress":
      return { phase: "downloading", version: state.version, percent: Math.round(Number(payload?.percent) || 0) };
    case "update-downloaded":
      return { phase: "downloaded", version: payload?.version ?? state.version, percent: 100 };
    case "error":
      // A failed check after a finished download keeps the downloaded state: the install is still valid.
      if (state.phase === "downloaded") return state;
      return { phase: "error", version: state.version, error: payload instanceof Error ? payload.message : String(payload) };
    default:
      return state;
  }
}

/**
 * `updater` preload API implementation (cgsconnect/local-channel.md §8). `shutdownHost` stops the sidecar before
 * `quitAndInstall` so the daemon lease is released rather than dropped when the process disappears.
 */
export function createUpdater({
  app,
  autoUpdater,
  requestHost,
  dialog,
  shutdownHost,
  env = process.env,
  settingsFile,
  intervalMs = CHECK_INTERVAL_MS,
} = {}) {
  const file = settingsFile ?? desktopSettingsFile(app);
  let settings = readSettings(file);
  const enabled = Boolean(app?.isPackaged) && env.CGS_UPDATER !== "0";
  const updater = enabled ? (autoUpdater ?? loadAutoUpdater()) : undefined;
  const texts = textsFor(app);
  const listeners = new Set();
  let state = { ...EMPTY_STATUS };
  let timer;

  const publish = (next) => {
    state = next;
    for (const listener of listeners) listener({ ...state });
    return state;
  };
  const emit = (event, payload) => publish(reduceStatus(state, event, payload));

  if (updater) {
    for (const event of ["checking-for-update", "update-available", "update-not-available", "download-progress", "update-downloaded", "error"]) {
      updater.on(event, (payload) => emit(event, payload));
    }
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
  }

  async function check() {
    const current = app?.getVersion?.() ?? "0.0.0";
    if (!enabled || !updater) return { version: current };
    if (state.phase === "downloading" || state.phase === "downloaded") {
      return { version: current, available: state.version };
    }
    try {
      await updater.checkForUpdates();
    } catch (error) {
      emit("error", error);
      throw error;
    }
    return {
      version: current,
      available: state.phase === "available" || state.phase === "downloading" || state.phase === "downloaded" ? state.version : undefined,
    };
  }

  async function download() {
    if (!enabled || !updater || state.phase !== "available") return;
    try {
      await updater.downloadUpdate();
    } catch (error) {
      emit("error", error);
      throw error;
    }
  }

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

  async function install() {
    if (!enabled || !updater || state.phase !== "downloaded") return;
    const count = await runningCount();
    if (count > 0) {
      const options = {
        type: "warning",
        buttons: [texts.install, texts.cancel],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: texts.title,
        message: texts.body,
        detail: texts.detail,
      };
      const answer = await dialog.showMessageBox(options);
      if (answer.response !== 0) return;
    }
    // Release the sidecar and its daemon lease first; quitAndInstall then replaces the app while nothing is writing.
    await shutdownHost?.();
    updater.quitAndInstall(false, true);
  }

  function startTimer() {
    clearInterval(timer);
    timer = undefined;
    if (!enabled || !updater || settings.autoCheck !== true) return;
    timer = setInterval(() => void check().catch(() => {}), intervalMs);
    timer.unref?.();
  }

  return {
    start() {
      // Only the startup check is gated by the setting; the settings screen can always ask explicitly.
      if (!enabled || !updater || settings.autoCheck !== true) return;
      void check().catch(() => {});
      startTimer();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
    check,
    download,
    install,
    status: () => ({ ...state }),
    getAutoCheck: async () => settings.autoCheck === true,
    setAutoCheck: async (next) => {
      settings = writeSettings(file, { autoCheck: next === true });
      startTimer();
      if (settings.autoCheck === true) void check().catch(() => {});
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** When a development build is running, updates are deliberately off. */
    enabled: () => enabled && Boolean(updater),
  };
}

/** `updater` IPC, mirrored in desktop/preload.cjs. */
export const UPDATER_CHANNELS = {
  check: "cgs:updater:check",
  getAutoCheck: "cgs:updater:getAutoCheck",
  setAutoCheck: "cgs:updater:setAutoCheck",
  status: "cgs:updater:status",
  download: "cgs:updater:download",
  install: "cgs:updater:install",
  changed: "cgs:updater:changed",
};

export function registerUpdaterIpc(ipcMain, updater) {
  ipcMain.handle(UPDATER_CHANNELS.check, () => updater.check());
  ipcMain.handle(UPDATER_CHANNELS.getAutoCheck, () => updater.getAutoCheck());
  ipcMain.handle(UPDATER_CHANNELS.setAutoCheck, (_event, enabled) => updater.setAutoCheck(enabled === true));
  ipcMain.handle(UPDATER_CHANNELS.status, () => updater.status());
  ipcMain.handle(UPDATER_CHANNELS.download, () => updater.download());
  ipcMain.handle(UPDATER_CHANNELS.install, () => updater.install());
}
