"use strict";
// Main-process model behind the topbar CGS button and the "tier changed" bubble. Holds no UI; main.js forwards
// `snapshot()` to the renderer over IPC and calls the action methods from IPC handlers.

const { EventEmitter } = require("node:events");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { getLoginState, readCredentials, signOutLocally, applyPreset, CGS_PROVIDERS } = require("./config-writer");
const { revokeDeviceKey } = require("./account");
const { PRESET_IDS, PRESET_NAMES, readState, updateState, decideBubble } = require("./state");
const { refreshTier } = require("./tier");
const { refreshUsage } = require("./usage");

const POLL_INTERVAL_MS = 30 * 60 * 1000;
const USAGE_POLL_INTERVAL_MS = 5 * 60 * 1000;

class CgsController extends EventEmitter {
  /** @param {{ agentDir: string, intervalMs?: number, usageIntervalMs?: number, refresh?: typeof refreshTier, fetchUsage?: typeof refreshUsage, revoke?: typeof revokeDeviceKey, pluginDir?: string | null }} options `pluginDir`: the bundled extension, used to count the models per provider. */
  constructor({ agentDir, intervalMs = POLL_INTERVAL_MS, usageIntervalMs = USAGE_POLL_INTERVAL_MS, refresh = refreshTier, fetchUsage = refreshUsage, revoke = revokeDeviceKey, pluginDir = null }) {
    super();
    this.agentDir = agentDir;
    this.intervalMs = intervalMs;
    this.usageIntervalMs = usageIntervalMs;
    this._refresh = refresh;
    this._fetchUsage = fetchUsage;
    this._revoke = revoke;
    this._pluginDir = pluginDir;
    this._plugin = null;
    this._loggingOut = false;
    this._logoutInflight = null;
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
    if (this._loggingOut) return Promise.resolve();
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

  /** The providers the bundled extension registers for these credentials, with their model counts ([] when unknown). */
  async _providerCounts(creds) {
    if (!creds || !this._pluginDir) return [];
    try {
      this._plugin ??= import(pathToFileURL(path.join(this._pluginDir, "index.js")).href);
      const plugin = await this._plugin;
      const providers = plugin.buildProviders({ baseUrl: creds.baseUrl, apiKey: creds.apiKey, models: Array.isArray(creds.models) ? creds.models : [] });
      return CGS_PROVIDERS.filter(id => providers[id]).map(id => ({ id, models: providers[id].models.length }));
    } catch {
      this._plugin = null;
      return [];
    }
  }

  async snapshot() {
    const [login, state, creds] = await Promise.all([getLoginState(this.agentDir), readState(this.agentDir), readCredentials(this.agentDir)]);
    const signedIn = login.signedIn && !this._revoked;
    // Credentials are still on disk but the server rejected the key: the Settings card offers 重新登录 / 退出账户.
    const keyRejected = login.signedIn && this._revoked && !this._loggingOut;
    const tier = signedIn ? login.tier : null;
    return {
      signedIn,
      keyRejected,
      username: signedIn || keyRejected ? login.username : null,
      baseUrl: signedIn || keyRejected ? creds?.baseUrl ?? null : null,
      providers: signedIn ? await this._providerCounts(creds) : [],
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

  /**
   * 「退出账户」. Stops the polling and waits for requests in flight (a late tier refresh would otherwise write
   * credentials.json back), asks the server to revoke the device key (best effort: 200 and 401 both mean it is gone;
   * a network error or 5xx only sets `serverRevoked: false`), then removes everything local (see signOutLocally).
   * Resolves { serverRevoked, server, cleanup } and emits "usage" and "change" (signed out). Rejects only when
   * credentials.json could not be deleted; the account then stays signed in and polling resumes.
   */
  logout() {
    this._logoutInflight ??= this._logout().finally(() => {
      this._logoutInflight = null;
    });
    return this._logoutInflight;
  }

  async _logout() {
    this._loggingOut = true;
    this._markRevoked();
    this._abort?.abort();
    this._usageAbort?.abort();
    await Promise.allSettled([this._inflight, this._usageInflight]);
    try {
      const creds = await readCredentials(this.agentDir);
      const remote = creds ? await this._revoke({ baseUrl: creds.baseUrl, apiKey: creds.apiKey }) : { status: "no-credentials" };
      const cleanup = await signOutLocally(this.agentDir);
      this._usageFetchedAt = 0;
      this._loggingOut = false;
      this.emit("usage", this.usageSnapshot());
      this.emit("change", await this.snapshot());
      return { serverRevoked: remote.status !== "error", server: remote, cleanup };
    } catch (err) {
      // credentials.json is still there: carry on as signed in (a revoked key shows up as 401 on the next check)
      this._loggingOut = false;
      this._revoked = false;
      this._scheduleUsage();
      this._schedule();
      void this.refresh();
      throw err;
    }
  }
}

module.exports = { CgsController, POLL_INTERVAL_MS, USAGE_POLL_INTERVAL_MS };
