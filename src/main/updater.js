"use strict";
// Self-update from GitHub releases (electron-updater, `build.publish` in package.json: CicoriOS/cgs-desktop). Packaged
// builds check at startup and every few hours, download in the background and install on the next quit; the renderer
// (main-preload.js) shows the state and can ask to check now or restart into the downloaded version.
//
// Release versions: 0.2.0, then 0.2.1, 0.2.2, ... (`npm run release:bump`, see README).

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * @typedef {{ status: "disabled" | "idle" | "checking" | "available" | "downloading" | "downloaded" | "latest" | "error",
 *   current: string, version: string | null, percent: number | null, error: string | null }} UpdateState
 */

class Updater {
  /** @param {{ app: import("electron").App, onState: (state: UpdateState) => void, autoUpdater?: any }} options */
  constructor({ app, onState, autoUpdater = null }) {
    this._app = app;
    this._onState = onState;
    this._enabled = app.isPackaged;
    this._updater = this._enabled ? autoUpdater || require("electron-updater").autoUpdater : null;
    this._timer = null;
    this._state = { status: this._enabled ? "idle" : "disabled", current: app.getVersion(), version: null, percent: null, error: null };
    if (!this._updater) return;
    const u = this._updater;
    u.autoDownload = true;
    u.autoInstallOnAppQuit = true;
    u.allowPrerelease = false;
    u.logger = { info: (m) => console.info(`[update] ${m}`), warn: (m) => console.warn(`[update] ${m}`), error: (m) => console.error(`[update] ${m}`), debug: () => {} };
    u.on("checking-for-update", () => this._set({ status: "checking", error: null }));
    u.on("update-available", (info) => this._set({ status: "available", version: info.version, percent: 0 }));
    u.on("update-not-available", () => this._set({ status: "latest", version: null, percent: null }));
    u.on("download-progress", (p) => this._set({ status: "downloading", percent: Math.round(p.percent) }));
    u.on("update-downloaded", (info) => this._set({ status: "downloaded", version: info.version, percent: 100 }));
    u.on("error", (err) => {
      // A failed check after a finished download keeps the downloaded state: the install still happens on quit.
      if (this._state.status === "downloaded") return;
      this._set({ status: "error", error: err instanceof Error ? err.message : String(err), percent: null });
    });
  }

  /** @returns {UpdateState} */
  state() {
    return { ...this._state };
  }

  _set(patch) {
    this._state = { ...this._state, ...patch };
    this._onState(this.state());
  }

  start() {
    if (!this._updater || this._timer) return;
    void this.check();
    this._timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this._timer.unref?.();
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  /** Check now (no-op while a check/download runs or one is ready). Never rejects; resolves the state. */
  async check() {
    if (!this._updater) return this.state();
    if (["checking", "downloading", "downloaded"].includes(this._state.status)) return this.state();
    try {
      await this._updater.checkForUpdates();
    } catch (err) {
      this._set({ status: "error", error: err instanceof Error ? err.message : String(err), percent: null });
    }
    return this.state();
  }

  /** Quit and start the downloaded version. */
  install() {
    if (!this._updater || this._state.status !== "downloaded") return false;
    this._updater.quitAndInstall(false, true);
    return true;
  }
}

module.exports = { Updater, CHECK_INTERVAL_MS };
