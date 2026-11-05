"use strict";
// Main-process model behind the topbar CGS button and the "tier changed" bubble. Holds no UI; main.js forwards
// `snapshot()` to the renderer over IPC and calls the action methods from IPC handlers.

const { EventEmitter } = require("node:events");
const { getLoginState, applyPreset } = require("./config-writer");
const { PRESET_IDS, PRESET_NAMES, readState, updateState, decideBubble } = require("./state");
const { refreshTier } = require("./tier");

const POLL_INTERVAL_MS = 30 * 60 * 1000;

class CgsController extends EventEmitter {
  /** @param {{ agentDir: string, intervalMs?: number, refresh?: typeof refreshTier }} options */
  constructor({ agentDir, intervalMs = POLL_INTERVAL_MS, refresh = refreshTier }) {
    super();
    this.agentDir = agentDir;
    this.intervalMs = intervalMs;
    this._refresh = refresh;
    this._timer = null;
    this._inflight = null;
    this._revoked = false; // the server rejected the key (401): behave as signed out until a new login
    this._stopped = false;
  }

  /** Begin polling: one check now, then every `intervalMs`. */
  start() {
    this._stopped = false;
    this._schedule();
    return this.refresh();
  }

  stop() {
    this._stopped = true;
    this._unschedule();
    this._abort?.abort();
  }

  _schedule() {
    if (this._timer || this._stopped || this._revoked) return;
    this._timer = setInterval(() => void this.refresh(), this.intervalMs);
    this._timer.unref?.();
  }

  _unschedule() {
    clearInterval(this._timer);
    this._timer = null;
  }

  /** Check the tier now (coalesces concurrent calls). Never rejects; emits "change" afterwards. */
  refresh() {
    if (this._inflight) return this._inflight;
    this._abort = new AbortController();
    const run = async () => {
      try {
        const result = await this._refresh(this.agentDir, { signal: this._abort.signal });
        if (result.status === "unauthorized") {
          this._revoked = true;
          this._unschedule();
        } else if (result.status === "ok") {
          this._revoked = false;
          this._schedule();
        }
      } catch {
        // detection is best effort: retry next tick
      }
      this.emit("change", await this.snapshot());
    };
    this._inflight = run().finally(() => {
      this._inflight = null;
    });
    return this._inflight;
  }

  /** A CGS login just completed (popup or dropdown): trust the fresh credentials again and re-detect. */
  onLogin() {
    this._revoked = false;
    return this.refresh();
  }

  async snapshot() {
    const [login, state] = await Promise.all([getLoginState(this.agentDir), readState(this.agentDir)]);
    const signedIn = login.signedIn && !this._revoked;
    const tier = signedIn ? login.tier : null;
    return {
      signedIn,
      username: signedIn ? login.username : null,
      tier,
      appliedPreset: state.appliedPreset,
      presets: PRESET_IDS.map(id => ({ id, name: PRESET_NAMES[id] })),
      bubble: decideBubble({ signedIn, tier, appliedPreset: state.appliedPreset, dismissedTier: state.dismissedTier }),
    };
  }

  /** Apply a preset to config.yml (user-initiated only). */
  async applyPreset(id) {
    if (!PRESET_IDS.includes(id)) throw new Error(`unknown CGS preset: ${id}`);
    if (!(await this.snapshot()).signedIn) throw new Error("CGS presets require a CGS login");
    await applyPreset(this.agentDir, id);
    const snap = await this.snapshot();
    this.emit("change", snap);
    return snap;
  }

  /** 「保持当前」: do not show the bubble again for the current tier. */
  async dismissBubble() {
    const login = await getLoginState(this.agentDir);
    await updateState(this.agentDir, { dismissedTier: login.tier });
    const snap = await this.snapshot();
    this.emit("change", snap);
    return snap;
  }
}

module.exports = { CgsController, POLL_INTERVAL_MS };
