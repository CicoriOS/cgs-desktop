"use strict";
// Main-process model behind the topbar CGS button and the "tier changed" bubble. Holds no UI; main.js forwards
// `snapshot()` to the renderer over IPC and calls the action methods from IPC handlers.

const { EventEmitter } = require("node:events");
const { getLoginState, applyPreset } = require("./config-writer");
const { PRESET_IDS, PRESET_NAMES, readState, updateState, decideBubble } = require("./state");
const { refreshTier } = require("./tier");
const { refreshUsage } = require("./usage");

const POLL_INTERVAL_MS = 30 * 60 * 1000;
const USAGE_POLL_INTERVAL_MS = 5 * 60 * 1000;

class CgsController extends EventEmitter {
  /** @param {{ agentDir: string, intervalMs?: number, usageIntervalMs?: number, refresh?: typeof refreshTier, fetchUsage?: typeof refreshUsage }} options */
  constructor({ agentDir, intervalMs = POLL_INTERVAL_MS, usageIntervalMs = USAGE_POLL_INTERVAL_MS, refresh = refreshTier, fetchUsage = refreshUsage }) {
    super();
    this.agentDir = agentDir;
    this.intervalMs = intervalMs;
    this.usageIntervalMs = usageIntervalMs;
    this._refresh = refresh;
    this._fetchUsage = fetchUsage;
    this._timer = null;
    this._inflight = null;
    this._revoked = false; // the server rejected the key (401): behave as signed out until a new login
    this._stopped = false;
    this._usageTimer = null;
    this._usageInflight = null;
    this._usageAbort = null;
    this._usageAttemptAt = 0;
    this._usage = null; // last good usage payload (see usage.js normalizeUsage)
    this._usageStale = false; // the latest refresh failed; _usage is older than that
    this._usageFetchedAt = 0;
  }

  /** Begin polling: one check now, then every `intervalMs`. */
  start() {
    this._stopped = false;
    this._schedule();
    this._scheduleUsage();
    void this.refreshUsage();
    return this.refresh();
  }

  stop() {
    this._stopped = true;
    this._unschedule();
    clearInterval(this._usageTimer);
    this._usageTimer = null;
    this._abort?.abort();
    this._usageAbort?.abort();
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

  _scheduleUsage() {
    if (this._usageTimer || this._stopped || this._revoked) return;
    this._usageTimer = setInterval(() => void this.refreshUsage(), this.usageIntervalMs);
    this._usageTimer.unref?.();
  }

  /** The server rejected the key (401): behave as signed out until a new login, drop everything account-specific. */
  _markRevoked() {
    this._revoked = true;
    this._unschedule();
    clearInterval(this._usageTimer);
    this._usageTimer = null;
    this._usage = null;
    this._usageStale = false;
  }

  /** Check the tier now (coalesces concurrent calls). Never rejects; emits "change" afterwards. */
  refresh() {
    if (this._inflight) return this._inflight;
    this._abort = new AbortController();
    const run = async () => {
      try {
        const result = await this._refresh(this.agentDir, { signal: this._abort.signal });
        if (result.status === "unauthorized") {
          this._markRevoked();
          this.emit("usage", this.usageSnapshot());
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
    this._usage = null;
    this._usageStale = false;
    this._scheduleUsage();
    void this.refreshUsage();
    return this.refresh();
  }

  /** `{ usage, stale, fetchedAt }`: the last good usage (null when none / signed out), whether it is out of date. */
  usageSnapshot() {
    return { usage: this._revoked ? null : this._usage, stale: this._usageStale, fetchedAt: this._usageFetchedAt };
  }

  /**
   * Fetch the account usage now (coalesces concurrent calls) and emit "usage". `minAgeMs` skips the request when one
   * was attempted that recently (window-focus refreshes). Never rejects; resolves usageSnapshot(). A 401 behaves like
   * the tier check's: signed out, and "change" is emitted too. Network errors keep the last value, marked stale.
   */
  refreshUsage({ minAgeMs = 0 } = {}) {
    if (this._usageInflight) return this._usageInflight;
    if (this._revoked || (minAgeMs > 0 && Date.now() - this._usageAttemptAt < minAgeMs)) return Promise.resolve(this.usageSnapshot());
    this._usageAttemptAt = Date.now();
    this._usageAbort = new AbortController();
    const run = async () => {
      let result;
      try {
        result = await this._fetchUsage(this.agentDir, { signal: this._usageAbort.signal });
      } catch {
        result = { status: "error" };
      }
      if (result.status === "ok") {
        this._usage = result.usage;
        this._usageStale = false;
        this._usageFetchedAt = Date.now();
      } else if (result.status === "unauthorized") {
        this._markRevoked();
      } else if (result.status === "signed-out") {
        this._usage = null;
        this._usageStale = false;
      } else if (this._usage) {
        this._usageStale = true;
      }
      this.emit("usage", this.usageSnapshot());
      if (result.status === "unauthorized") this.emit("change", await this.snapshot());
      return this.usageSnapshot();
    };
    this._usageInflight = run().finally(() => {
      this._usageInflight = null;
    });
    return this._usageInflight;
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

module.exports = { CgsController, POLL_INTERVAL_MS, USAGE_POLL_INTERVAL_MS };
