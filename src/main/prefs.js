"use strict";
// Mirror of ompweb's `omp-*` localStorage keys (language, theme, font size, UI scale, usage-widget prefs, ...) in
// <userData>/web-prefs.json. ompweb keeps them per origin; the mirror lets them survive an origin change (the app
// normally keeps a stable port, see services.choosePort, but falls back to another one when it is taken).
// main-preload.js restores the file into localStorage before ompweb's scripts run and sends deltas back.

const fs = require("node:fs");
const path = require("node:path");

// Keep in sync with PREF_KEY_PATTERN in main-preload.js (a test compares the two). Drafts are bulky and per-session.
const PREF_KEY_PATTERN = /^omp-(?!draft-|uploads-draft-)/;
const MAX_VALUE_CHARS = 128 * 1024;

const isPrefKey = (key) => typeof key === "string" && key.length <= 256 && PREF_KEY_PATTERN.test(key);
const isPrefValue = (value) => typeof value === "string" && value.length <= MAX_VALUE_CHARS;

class PrefsStore {
  /** @param {string} file */
  constructor(file) {
    this.file = file;
    this._data = undefined; // undefined = not read yet; null = no (usable) file; object = file contents
  }

  /** The stored prefs, or null when nothing was ever saved (the renderer then seeds the file from its localStorage). */
  load() {
    if (this._data === undefined) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
        const data = {};
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          for (const [key, value] of Object.entries(raw)) if (isPrefKey(key) && isPrefValue(value)) data[key] = value;
          this._data = data;
        } else {
          this._data = null;
        }
      } catch {
        this._data = null;
      }
    }
    return this._data === null ? null : { ...this._data };
  }

  /** Merge a renderer delta `{ set: {key: value}, remove: [key] }`; invalid entries are ignored. Persists atomically. */
  apply(delta) {
    const data = this.load() || {};
    let changed = false;
    const set = delta && typeof delta.set === "object" && delta.set ? delta.set : {};
    for (const [key, value] of Object.entries(set)) {
      if (isPrefKey(key) && isPrefValue(value) && data[key] !== value) {
        data[key] = value;
        changed = true;
      }
    }
    for (const key of Array.isArray(delta && delta.remove) ? delta.remove : []) {
      if (isPrefKey(key) && key in data) {
        delete data[key];
        changed = true;
      }
    }
    if (!changed) return;
    this._data = data;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
      fs.renameSync(tmp, this.file);
    } catch {
      // best effort: the in-memory copy still serves later loads this run
    }
  }
}

module.exports = { PrefsStore, PREF_KEY_PATTERN, isPrefKey };
