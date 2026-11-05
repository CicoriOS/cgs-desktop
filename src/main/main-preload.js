"use strict";
// Injects into ompweb's DOM:
//   1. Minimize / maximize-restore / close window controls, immediately right of `button.shell-panel-opener`
//      inside `[data-topbar-right-group]` (or floating at top-right on narrow/loading layouts).
//   2. A 「CGS 预设」 block at the top of Settings → AI模型默认值 (`#settings-panel-models`): preset radio buttons,
//      account line, login button. Re-attached by a MutationObserver after React re-renders / navigation.
//   3. The top-right tier-change bubble (切换 / 保持当前 / 查看预设) and the preset-switch toast.
//   4. Branding: while signed in, ompweb's sidebar/brand logo is replaced by the CGS logo and an accent-colour
//      stylesheet (the new-api console purple) overrides ompweb's accent variables; signed out → ompweb defaults.
//   5. First-run default theme "system" (only when the user has not chosen one).
//   6. ompweb's `omp-*` localStorage prefs (language, theme, font size, UI scale, usage-widget prefs, ...) are mirrored
//      in <userData>/web-prefs.json: restored before ompweb's scripts run, deltas sent back, so they survive an origin
//      (port) change on top of the stable port from services.choosePort.
//   7. While signed in: a compact CGS balance/subscription row above the Settings footer in ompweb's sidebar and a CGS
//      account card at the top of Settings → 用量与分析 (`#settings-panel-usage`), fed by the main process
//      (`/api/device/usage`: every 5 min, on window focus, manual refresh).
const { contextBridge, ipcRenderer } = require("electron");

const ROOT_ID = "cgs-window-controls";
const OVERLAY_ID = "cgs-overlay-root";
const STYLE_ID = "cgs-window-controls-style";
const THEME_STYLE_ID = "cgs-theme-style";
const BLOCK_ID = "cgs-presets-block";
const OPENER_SELECTOR = "[data-topbar-right-group] button.shell-panel-opener";
const MODELS_PANEL_SELECTOR = "#settings-panel-models";
const USAGE_PANEL_SELECTOR = "#settings-panel-usage";
const SETTINGS_ROW_SELECTOR = "button.sidebar-settings-row";
const USAGE_ROW_ID = "cgs-usage-row";
const USAGE_CARD_ID = "cgs-usage-card";
// ompweb's brand mark (components/OmpWebLogo.tsx): <svg role="img" viewBox="0 0 64 64">.
const OMP_LOGO_SELECTOR = 'svg[role="img"][viewBox="0 0 64 64"]';

const PRESET_NAMES = { free: "Free", go: "Go", pro: "Pro", dedicated: "独享" };

// new-api web console default preset "lavender-dream" (web/src/styles/theme.css base + theme-presets.css):
//   light --primary oklch(0.5709 0.1808 306.89) ≈ #9453c9; dark --primary oklch(0.6359 0.1699 307.95) ≈ #a76ad9
// mapped onto ompweb's theme variables for its "system" preference (resolves to data-theme="light" / "dark").
const THEME_CSS = `
html[data-theme="light"]:root:root {
  --bg: oklch(1 0 0);
  --bg-panel: oklch(0.97 0 0);
  --bg-hover: oklch(0.95 0 0);
  --bg-selected: color-mix(in oklch, oklch(0.5709 0.1808 306.89) 12%, oklch(1 0 0));
  --border: oklch(0.93 0 0);
  --text: oklch(0.145 0 0);
  --text-muted: oklch(0.49 0 0);
  --text-dim: oklch(0.5 0 0);
  --accent: oklch(0.5709 0.1808 306.89);
  --accent-strong: oklch(0.5709 0.1808 306.89);
  --accent-hover: oklch(0.5 0.1808 306.89);
  --user-bg: color-mix(in oklch, oklch(0.5709 0.1808 306.89) 8%, oklch(1 0 0));
  --tool-bg: oklch(0.975 0 0);
  --bg-subtle: oklch(0.97 0 0);
  --on-accent: oklch(1 0 0);
}
html[data-theme="dark"]:root:root {
  color-scheme: dark;
  --bg: oklch(0.235 0 0);
  --bg-panel: oklch(0.225 0 0);
  --bg-hover: oklch(0.305 0 0);
  --bg-selected: color-mix(in oklch, oklch(0.6359 0.1699 307.95) 20%, oklch(0.235 0 0));
  --border: oklch(1 0 0 / 10%);
  --text: oklch(0.965 0 0);
  --text-muted: oklch(0.78 0 0);
  --text-dim: oklch(0.7 0 0);
  --accent: oklch(0.6359 0.1699 307.95);
  --accent-strong: oklch(0.54 0.1699 307.95);
  --accent-hover: oklch(0.72 0.15 307.95);
  --user-bg: oklch(0.285 0 0);
  --tool-bg: oklch(0.26 0 0);
  --bg-subtle: oklch(1 0 0 / 5%);
  --on-accent: oklch(1 0 0);
}
`;

function storedTheme() {
  try {
    return window.localStorage.getItem("omp-theme");
  } catch {
    return null;
  }
}

const bridge = {
  getState: () => ipcRenderer.invoke("cgs:get-state"),
  applyPreset: (id) => ipcRenderer.invoke("cgs:apply-preset", id),
  dismissBubble: () => ipcRenderer.invoke("cgs:dismiss-bubble"),
  openLogin: () => ipcRenderer.invoke("cgs:open-login"),
  getUsage: () => ipcRenderer.invoke("cgs:get-usage"),
  refreshUsage: () => ipcRenderer.invoke("cgs:refresh-usage"),
  onUsage: (callback) => {
    const listener = (_event, snap) => callback(snap);
    ipcRenderer.on("cgs:usage", listener);
    return () => ipcRenderer.removeListener("cgs:usage", listener);
  },
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("cgs:state", listener);
    return () => ipcRenderer.removeListener("cgs:state", listener);
  },
};

try {
  contextBridge.exposeInMainWorld("cgsDesktop", bridge);
} catch {
  // contextIsolation disabled in a test harness: ignore
}

// ---- ompweb prefs mirror --------------------------------------------------------------------------------------------
// ompweb keeps its preferences in localStorage `omp-*` keys, scoped to the page origin. The main process mirrors them in
// a JSON file: the file is authoritative once it exists (restored here, before ompweb's scripts read localStorage);
// before that, this origin's own keys seed it. Page scripts run in another world, so Storage cannot be wrapped from
// here: changes are found by diffing every second (and on unload/hide) and sent as deltas.
// Keep in sync with PREF_KEY_PATTERN in prefs.js (a test compares the two). Drafts are bulky and per session.
const PREF_KEY_PATTERN = /^omp-(?!draft-|uploads-draft-)/;
const PREFS_FLUSH_MS = 1000;
let prefsMirror = {};

function readLocalPrefs() {
  const out = {};
  const storage = window.localStorage;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    const value = key !== null && PREF_KEY_PATTERN.test(key) ? storage.getItem(key) : null;
    if (value !== null) out[key] = value;
  }
  return out;
}

function restorePrefs() {
  const saved = ipcRenderer.sendSync("cgs:prefs-load");
  if (!saved || typeof saved !== "object") return;
  const storage = window.localStorage;
  for (const key of Object.keys(readLocalPrefs())) if (!(key in saved)) storage.removeItem(key);
  for (const [key, value] of Object.entries(saved)) {
    if (PREF_KEY_PATTERN.test(key) && typeof value === "string" && storage.getItem(key) !== value) storage.setItem(key, value);
  }
  prefsMirror = { ...saved };
}

function flushPrefs() {
  try {
    const now = readLocalPrefs();
    const set = {};
    const remove = [];
    for (const [key, value] of Object.entries(now)) if (prefsMirror[key] !== value) set[key] = value;
    for (const key of Object.keys(prefsMirror)) if (!(key in now)) remove.push(key);
    if (remove.length === 0 && Object.keys(set).length === 0) return;
    prefsMirror = now;
    ipcRenderer.send("cgs:prefs-save", { set, remove });
  } catch {
    // storage unavailable: nothing to mirror
  }
}

const isAppPage = window.location.protocol.startsWith("http");
try {
  if (isAppPage) restorePrefs();
} catch {
  // storage unavailable: ompweb falls back to its own defaults
}

// Default to following the OS theme until the user picks one (ompweb stores the choice in localStorage "omp-theme").
try {
  if (isAppPage && window.localStorage.getItem("omp-theme") === null) {
    window.localStorage.setItem("omp-theme", "system");
  }
} catch {
  // storage unavailable: ompweb falls back to its own default
}

if (isAppPage) {
  flushPrefs();
  setInterval(flushPrefs, PREFS_FLUSH_MS);
  window.addEventListener("pagehide", flushPrefs);
  window.addEventListener("beforeunload", flushPrefs);
  document.addEventListener("visibilitychange", flushPrefs);
}

const ICONS = {
  minimize: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10" stroke="currentColor" stroke-width="1" fill="none"/></svg>',
  maximize: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" stroke-width="1" fill="none"/></svg>',
  restore:
    '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5V0.5h7v7h-2" stroke="currentColor" stroke-width="1" fill="none"/><rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" stroke-width="1" fill="none"/></svg>',
  close: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" stroke-width="1" fill="none"/></svg>',
  check: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.2 6.3L4.8 8.9L9.8 3.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
  refresh:
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>',
};

// Colours come from ompweb's theme variables (so light/dark/custom themes all work); the fallbacks follow the OS scheme.
const CSS = `
.shell-topbar { -webkit-app-region: drag; }
.shell-topbar button, .shell-topbar input, .shell-topbar textarea, .shell-topbar select, .shell-topbar a,
.shell-topbar [role="button"], .shell-topbar [role="menu"], .shell-topbar [role="menuitem"], .shell-topbar [role="combobox"],
.shell-topbar [role="tab"], .shell-topbar [contenteditable="true"], .shell-topbar [data-no-drag],
[role="menu"], [role="listbox"], [role="dialog"], [data-radix-popper-content-wrapper] { -webkit-app-region: no-drag; }
#${ROOT_ID} { display: inline-flex; align-items: center; gap: 2px; flex: none; margin-left: 4px; -webkit-app-region: no-drag; }
#${ROOT_ID}.cgs-floating { position: fixed; top: 0; right: 0; z-index: 2147483647; margin: 0; padding-left: 4px; background: color-mix(in srgb, var(--bg-panel, Canvas) 88%, transparent); border-bottom-left-radius: 6px; }
body:has(#${ROOT_ID}.cgs-floating) .settings-header { padding-right: 148px; }
#${ROOT_ID} button.cgs-win-btn { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 32px; cursor: default; color: inherit; border-radius: 6px; -webkit-app-region: no-drag; }
#${ROOT_ID}.cgs-floating button.cgs-win-btn { border-radius: 0; height: 30px; color: var(--text, CanvasText); }
#${ROOT_ID} button.cgs-win-btn:hover { background: rgba(127, 127, 127, 0.22); }
#${ROOT_ID} button.cgs-win-btn:active { background: rgba(127, 127, 127, 0.34); }
#${ROOT_ID} button.cgs-win-btn[data-action="close"]:hover { background: #e81123; color: #fff; }
#${ROOT_ID} button.cgs-win-btn[data-action="close"]:active { background: #f1707a; color: #fff; }
#${ROOT_ID} button.cgs-win-btn:focus-visible { outline: 2px solid var(--accent, #3b82f6); outline-offset: -2px; }

img.cgs-brand-logo { display: block; flex-shrink: 0; }
[data-cgs-replaced="1"] { display: none !important; }

#${OVERLAY_ID} {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", sans-serif;
  color: var(--text, CanvasText);
  -webkit-app-region: no-drag;
}

/* Settings → AI模型默认值 block (reuses ompweb's .settings-card rows) */
#${BLOCK_ID} { flex-wrap: wrap; }
#${BLOCK_ID} .cgs-block-account { color: var(--text-muted, GrayText); font-size: 12px; }
#${BLOCK_ID} .cgs-block-account strong { color: var(--text, CanvasText); font-weight: 600; }
#${BLOCK_ID} .settings-card-control { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; justify-content: flex-end; }
.cgs-preset-btn {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.35));
  background: var(--bg-subtle, transparent);
  color: var(--text, CanvasText);
  font-size: 13px;
  line-height: 1.3;
  cursor: pointer;
  user-select: none;
}
.cgs-preset-btn:hover:not(:disabled) { border-color: var(--accent, #9453c9); }
.cgs-preset-btn:focus-visible { outline: 2px solid var(--accent, #9453c9); outline-offset: 1px; }
.cgs-preset-btn:disabled { opacity: 0.5; cursor: default; }
.cgs-preset-btn[aria-checked="true"] { border-color: var(--accent, #9453c9); color: var(--accent, #9453c9); font-weight: 600; }
.cgs-preset-btn .cgs-check { display: inline-flex; width: 12px; height: 12px; }
.cgs-tag-recommend {
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent, #9453c9) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent, #9453c9) 42%, transparent);
  color: var(--accent, #9453c9);
  font-size: 11px;
  font-weight: 500;
}
.cgs-login-btn {
  all: unset;
  box-sizing: border-box;
  padding: 5px 12px;
  border-radius: 8px;
  background: var(--accent-strong, var(--accent, #9453c9));
  color: var(--on-accent, #fff);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  user-select: none;
}
.cgs-login-btn:hover { filter: brightness(1.08); }
.cgs-login-btn:focus-visible { outline: 2px solid var(--accent, #9453c9); outline-offset: 2px; }

#cgs-tier-bubble {
  position: fixed;
  top: 50px;
  right: 16px;
  z-index: 2147483645;
  width: 320px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--bg-panel, Canvas);
  border: 1px solid var(--border, rgba(127, 127, 127, 0.4));
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
  color: var(--text, CanvasText);
  font-size: 13px;
  line-height: 1.45;
}
#cgs-tier-bubble[hidden] { display: none !important; }
.cgs-bubble-msg { margin: 0 0 10px; }
.cgs-bubble-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.cgs-bubble-link {
  all: unset;
  margin-right: auto;
  font-size: 12px;
  color: var(--accent, #9453c9);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.cgs-bubble-link:focus-visible { outline: 2px solid var(--accent, #9453c9); outline-offset: 2px; }
.cgs-bubble-btn {
  all: unset;
  box-sizing: border-box;
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  user-select: none;
}
.cgs-bubble-btn:focus-visible { outline: 2px solid var(--accent, #9453c9); outline-offset: 2px; }
.cgs-bubble-btn-secondary {
  background: var(--bg-subtle, rgba(127, 127, 127, 0.12));
  border: 1px solid var(--border, rgba(127, 127, 127, 0.4));
  color: var(--text, CanvasText);
}
.cgs-bubble-btn-secondary:hover { background: rgba(127, 127, 127, 0.22); }
.cgs-bubble-btn-primary {
  background: var(--accent-strong, var(--accent, #9453c9));
  border: 1px solid var(--accent, #9453c9);
  color: var(--on-accent, #fff);
}
.cgs-bubble-btn-primary:hover { background: var(--accent-hover, var(--accent, #7e3fb3)); }

#cgs-toast {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 2147483646;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--bg-panel, Canvas);
  border: 1px solid var(--accent, #9453c9);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  color: var(--text, CanvasText);
  font-size: 12px;
}
#cgs-toast[hidden] { display: none !important; }

/* CGS balance / subscription row: sidebar, right above the Settings footer (and ompweb's own usage widget above it) */
#cgs-usage-row {
  box-sizing: border-box;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  padding: 7px 12px 8px;
  border-top: 1px solid var(--border, rgba(127, 127, 127, 0.25));
  background: var(--bg-panel, transparent);
  color: var(--text-muted, GrayText);
  font-size: 11px;
  line-height: 1.35;
  -webkit-app-region: no-drag;
}
.cgs-ur-head, .cgs-ur-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.cgs-ur-line { justify-content: space-between; gap: 8px; }
.cgs-ur-badge {
  flex-shrink: 0;
  padding: 0 5px;
  border-radius: 4px;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
  background: var(--bg, transparent);
  color: var(--accent, #9453c9);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10px;
  font-weight: 700;
  line-height: 1.7;
}
.cgs-ur-plan { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text, CanvasText); font-weight: 600; }
.cgs-ur-balance { color: var(--text, CanvasText); font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; }
.cgs-ur-pct { flex-shrink: 0; font-family: var(--font-mono, ui-monospace, monospace); font-weight: 700; white-space: nowrap; font-variant-numeric: tabular-nums; }
.cgs-ur-meta { display: flex; justify-content: space-between; gap: 8px; min-width: 0; color: var(--text-dim, GrayText); font-size: 10px; }
.cgs-ur-meta > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.cgs-ur-meta > span:last-child { flex-shrink: 0; }
.cgs-ur-limits { color: var(--text-dim, GrayText); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cgs-bar { height: 3px; border-radius: 2px; overflow: hidden; background: color-mix(in srgb, var(--text-dim, gray) 28%, transparent); }
.cgs-bar > i { display: block; height: 100%; border-radius: 2px; background: var(--accent, #9453c9); }
/* ompweb's ProviderUsageBar (the <section> right above the Settings footer) is hidden while signed in: the CGS row replaces it */
[data-cgs-hidden-usage="1"] { display: none !important; }
.cgs-stale-dot { flex-shrink: 0; width: 6px; height: 6px; border-radius: 50%; background: var(--status-warning, #c18401); }
.cgs-icon-btn {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  color: var(--text-dim, GrayText);
  cursor: pointer;
}
.cgs-icon-btn:hover:not(:disabled) { background: var(--bg-hover, rgba(127, 127, 127, 0.18)); color: var(--text, CanvasText); }
.cgs-icon-btn:focus-visible { outline: 2px solid var(--accent, #9453c9); outline-offset: 1px; }
.cgs-icon-btn[aria-busy="true"] { cursor: default; }
.cgs-icon-btn[aria-busy="true"] svg { animation: cgs-spin 0.9s linear infinite; }
@keyframes cgs-spin { to { transform: rotate(360deg); } }

/* CGS account card: top of Settings → 用量与分析 */
#cgs-usage-card {
  box-sizing: border-box;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin: 0 0 16px;
  padding: 14px 16px;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
  border-radius: var(--radius-control, 10px);
  background: var(--bg-subtle, transparent);
  color: var(--text, CanvasText);
  font-size: 13px;
  line-height: 1.45;
}
.cgs-uc-head { display: flex; align-items: center; gap: 8px; }
.cgs-uc-title { font-size: 14px; font-weight: 600; }
.cgs-uc-spacer { flex: 1; }
.cgs-uc-muted { color: var(--text-muted, GrayText); font-size: 12px; }
.cgs-uc-account { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
.cgs-uc-account strong { font-weight: 600; }
.cgs-uc-pill {
  padding: 1px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent, #9453c9) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent, #9453c9) 42%, transparent);
  color: var(--accent, #9453c9);
  font-size: 11px;
  font-weight: 500;
}
.cgs-uc-balance { display: inline-flex; align-items: baseline; gap: 6px; }
.cgs-uc-balance b { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.cgs-uc-sub { display: flex; flex-direction: column; gap: 6px; padding-top: 12px; border-top: 1px solid var(--border, rgba(127, 127, 127, 0.3)); }
.cgs-uc-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; min-width: 0; }
.cgs-uc-row > span:first-child { min-width: 0; overflow-wrap: anywhere; }
.cgs-uc-row b { font-weight: 600; font-variant-numeric: tabular-nums; }
.cgs-uc-sub .cgs-bar { height: 6px; border-radius: 3px; }
.cgs-uc-sub .cgs-bar > i { border-radius: 3px; }
.cgs-uc-facts { display: flex; flex-wrap: wrap; gap: 2px 16px; color: var(--text-muted, GrayText); font-size: 12px; }
.cgs-uc-limits { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.cgs-uc-limit { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3px 12px; align-items: baseline; font-size: 12px; }
.cgs-uc-limit .cgs-bar { grid-column: 1 / -1; }
.cgs-uc-model { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono, ui-monospace, monospace); }
.cgs-uc-num { color: var(--text-muted, GrayText); font-variant-numeric: tabular-nums; white-space: nowrap; }
`;

let maximized = false;
let scheduled = false;
let cgsState = null;
let cgsLogoUrl = null;
let usageState = null; // { usage, stale, fetchedAt } from the main process; usage is null until the first success
let usageRefreshing = false;
let toastTimer = null;

function isLoadingScreen() {
  return window.location.protocol === "file:";
}

function makeWinButton(action, label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cgs-win-btn";
  button.dataset.action = action;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", onClick);
  return button;
}

function buildControls() {
  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.append(
    makeWinButton("minimize", "最小化", () => ipcRenderer.send("cgs:window-minimize")),
    makeWinButton("maximize", "最大化", () => ipcRenderer.send("cgs:window-toggle-maximize")),
    makeWinButton("close", "关闭", () => ipcRenderer.send("cgs:window-close")),
  );
  root.addEventListener("dblclick", (event) => event.stopPropagation());
  return root;
}

function buildOverlay() {
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;

  const bubble = document.createElement("div");
  bubble.id = "cgs-tier-bubble";
  bubble.setAttribute("role", "status");
  bubble.hidden = true;

  const toast = document.createElement("div");
  toast.id = "cgs-toast";
  toast.setAttribute("role", "status");
  toast.hidden = true;

  overlay.append(bubble, toast);
  return overlay;
}

function renderIcons(root) {
  root.querySelector('[data-action="minimize"]').innerHTML = ICONS.minimize;
  const max = root.querySelector('[data-action="maximize"]');
  max.innerHTML = maximized ? ICONS.restore : ICONS.maximize;
  const label = maximized ? "还原" : "最大化";
  max.title = label;
  max.setAttribute("aria-label", label);
  root.querySelector('[data-action="close"]').innerHTML = ICONS.close;
}

function showToast(text) {
  const toast = document.getElementById("cgs-toast");
  if (!toast) return;
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}

async function handleSelectPreset(presetId) {
  const next = await bridge.applyPreset(presetId);
  if (next) cgsState = next;
  renderCgsUi();
  const name = PRESET_NAMES[presetId] || presetId;
  showToast(`已切换到 ${name} 预设（新会话生效）`);
}

async function handleDismissBubble() {
  const next = await bridge.dismissBubble();
  if (next) cgsState = next;
  renderCgsUi();
}

async function handleOpenLogin() {
  const next = await bridge.openLogin();
  if (next) cgsState = next;
  renderCgsUi();
}

/** Opens ompweb Settings → AI模型默认值 (via ompweb's own sidebar row / tab buttons) and reveals the presets block. */
function handleViewPresets() {
  const reveal = () => {
    const block = document.getElementById(BLOCK_ID);
    if (block) block.scrollIntoView({ block: "center", behavior: "smooth" });
    return Boolean(block);
  };
  const selectTab = () => {
    const tab = document.getElementById("settings-tab-models");
    if (!tab) return false;
    if (tab.getAttribute("aria-selected") !== "true") tab.click();
    return true;
  };
  if (!document.getElementById("settings-tab-models")) {
    const row = document.querySelector(".sidebar-settings-row");
    if (row) row.click();
  }
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if ((selectTab() && (ensure(), reveal())) || tries > 40) clearInterval(timer);
  }, 100);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function presetsOf(state) {
  return Array.isArray(state.presets) ? state.presets : Object.entries(PRESET_NAMES).map(([id, name]) => ({ id, name }));
}

/** Re-render `node` only when `sig` changed (keeps the MutationObserver from looping on our own mutations). */
function sync(node, sig, build) {
  if (node.dataset.cgsSig === sig) return;
  node.dataset.cgsSig = sig;
  build(node);
}

function buildPresetsBlock() {
  const block = el("div", "settings-card");
  block.id = BLOCK_ID;
  block.dataset.cgsPresets = "1";
  return block;
}

function renderPresetsBlock(block) {
  const state = cgsState;
  const sig = JSON.stringify(state ? [state.signedIn, state.username, state.tier, state.appliedPreset, state.presets] : null);
  sync(block, sig, () => {
    const text = el("div", "settings-card-text");
    const title = el("div");
    title.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:4px";
    title.append(el("span", "settings-card-title", "CGS 预设"));
    const desc = el("span", "settings-card-desc cgs-block-account");
    if (state && state.signedIn) {
      const tierLabel = PRESET_NAMES[state.tier] || state.tier || "Free";
      const strong = el("strong", "", state.username || "CGS");
      desc.append(strong, document.createTextNode(` · ${tierLabel}`));
      desc.dataset.tier = state.tier || "";
    } else {
      desc.textContent = "登录 CGS 后可切换预设";
    }
    text.append(title, desc);

    const control = el("span", "settings-card-control");
    control.setAttribute("role", "radiogroup");
    control.setAttribute("aria-label", "CGS 预设");
    if (state) {
      for (const preset of presetsOf(state)) {
        const btn = el("button", "cgs-preset-btn");
        btn.type = "button";
        btn.setAttribute("role", "radio");
        btn.dataset.preset = preset.id;
        const checked = state.appliedPreset === preset.id;
        btn.setAttribute("aria-checked", checked ? "true" : "false");
        if (checked) {
          const check = el("span", "cgs-check");
          check.innerHTML = ICONS.check;
          btn.append(check);
        }
        btn.append(el("span", "", preset.name));
        if (state.signedIn && state.tier === preset.id) btn.append(el("span", "cgs-tag-recommend", "推荐"));
        if (state.signedIn) {
          btn.addEventListener("click", () => void handleSelectPreset(preset.id));
        } else {
          btn.disabled = true;
          btn.title = "登录 CGS 后可用";
        }
        control.append(btn);
      }
    }
    if (!state || !state.signedIn) {
      const loginBtn = el("button", "cgs-login-btn", "登录 CGS");
      loginBtn.type = "button";
      loginBtn.dataset.action = "cgs-login";
      loginBtn.addEventListener("click", () => void handleOpenLogin());
      control.append(loginBtn);
    }
    block.replaceChildren(text, control);
  });
}

function ensurePresetsBlock() {
  const panel = isLoadingScreen() ? null : document.querySelector(MODELS_PANEL_SELECTOR);
  const existing = document.getElementById(BLOCK_ID);
  if (!panel) {
    existing?.remove();
    return;
  }
  const list = panel.children.length > 1 && panel.children[1].id !== BLOCK_ID ? panel.children[1] : panel;
  const block = existing || buildPresetsBlock();
  if (block.parentElement !== list || list.firstElementChild !== block) list.prepend(block);
  renderPresetsBlock(block);
}

function renderBubble() {
  const bubble = document.getElementById("cgs-tier-bubble");
  if (!bubble) return;
  const info = !isLoadingScreen() && cgsState && cgsState.bubble ? cgsState.bubble : null;
  if (!info) {
    bubble.hidden = true;
    if (bubble.firstChild) bubble.replaceChildren();
    delete bubble.dataset.cgsSig;
    return;
  }
  sync(bubble, JSON.stringify(info), () => {
    bubble.dataset.tier = info.tier;
    const msg = el("p", "cgs-bubble-msg", `检测到你的 CGS 套餐已变更为 ${info.name}，推荐切换到 ${info.name} 预设`);

    const actions = el("div", "cgs-bubble-actions");
    const viewBtn = el("button", "cgs-bubble-link", "查看预设");
    viewBtn.type = "button";
    viewBtn.dataset.action = "cgs-bubble-view";
    viewBtn.addEventListener("click", () => handleViewPresets());

    const keepBtn = el("button", "cgs-bubble-btn cgs-bubble-btn-secondary", "保持当前");
    keepBtn.type = "button";
    keepBtn.dataset.action = "cgs-bubble-dismiss";
    keepBtn.addEventListener("click", () => void handleDismissBubble());

    const switchBtn = el("button", "cgs-bubble-btn cgs-bubble-btn-primary", "切换");
    switchBtn.type = "button";
    switchBtn.dataset.action = "cgs-bubble-switch";
    switchBtn.addEventListener("click", () => void handleSelectPreset(info.tier));

    actions.append(viewBtn, keepBtn, switchBtn);
    bubble.replaceChildren(msg, actions);
  });
  bubble.hidden = false;
}

function renderBranding() {
  const signedIn = Boolean(cgsState && cgsState.signedIn) && !isLoadingScreen();

  // Lavender palette only while ompweb's theme preference is "system" (an explicit user choice is never overridden).
  const wantTheme = !isLoadingScreen() && storedTheme() === "system";
  const themeStyle = document.getElementById(THEME_STYLE_ID);
  if (wantTheme && !themeStyle) {
    const style = document.createElement("style");
    style.id = THEME_STYLE_ID;
    style.textContent = THEME_CSS;
    (document.head || document.documentElement).append(style);
  } else if (!wantTheme && themeStyle) {
    themeStyle.remove();
  }

  // Brand logo: hide ompweb's mark and put the CGS logo next to it while signed in; restore when signed out.
  for (const logo of document.querySelectorAll(OMP_LOGO_SELECTOR)) {
    const next = logo.nextElementSibling;
    const hasImg = next && next.classList.contains("cgs-brand-logo");
    if (signedIn && cgsLogoUrl) {
      if (!hasImg) {
        const img = document.createElement("img");
        img.className = "cgs-brand-logo";
        img.alt = "CGS";
        img.src = cgsLogoUrl;
        const size = logo.getAttribute("width") || "20";
        img.width = Number(size);
        img.height = Number(size);
        logo.after(img);
      }
      logo.dataset.cgsReplaced = "1";
    } else {
      if (hasImg) next.remove();
      delete logo.dataset.cgsReplaced;
    }
  }
  if (!signedIn) {
    for (const img of document.querySelectorAll("img.cgs-brand-logo")) img.remove();
  }
}

// ---- CGS usage (sidebar row + Settings → 用量与分析 card) -------------------------------------------------------------

const RESET_LABELS = { never: "不重置", daily: "每日重置", weekly: "每周重置", monthly: "每月重置", custom: "按周期重置" };

const pad2 = (n) => String(n).padStart(2, "0");
const fmtDate = (sec) => {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const fmtTime = (sec) => {
  const d = new Date(sec * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const fmtDateTime = (sec) => `${fmtDate(sec)} ${fmtTime(sec)}`;

/** "3 天后" / "5 小时后" / "12 分钟后" for a unix-seconds instant. */
function fmtIn(sec) {
  const minutes = Math.round((sec * 1000 - Date.now()) / 60000);
  if (minutes <= 0) return "即将";
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} 小时后` : `${Math.round(hours / 24)} 天后`;
}

/** Token counts: 1234 → "1.2K", 100000000 → "100M". */
function fmtCount(n) {
  const value = Number(n) || 0;
  const scaled = (divisor, unit) => `${Math.round((value / divisor) * 10) / 10}${unit}`;
  if (value >= 1e9) return scaled(1e9, "B");
  if (value >= 1e6) return scaled(1e6, "M");
  if (value >= 1e3) return scaled(1e3, "K");
  return String(Math.round(value));
}

const percentOf = (used, total) => (total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0);
const percentText = (p) => (p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`);
const toneOf = (p) => (p >= 80 ? "var(--status-error)" : p >= 50 ? "var(--status-warning)" : "var(--accent)");
const minuteBucket = () => Math.floor(Date.now() / 60000);

const usedText = (sub) => sub.usedDisplay || String(sub.amountUsed);
const totalText = (sub) => sub.totalDisplay || String(sub.amountTotal);

function makeBar(percent) {
  const bar = el("div", "cgs-bar");
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", String(Math.round(percent)));
  const fill = document.createElement("i");
  fill.style.width = `${percent}%`;
  fill.style.background = toneOf(percent);
  bar.append(fill);
  return bar;
}

function limitsOf(sub) {
  return sub.dailyTokenLimits.map((l) => ({ ...l, percent: percentOf(l.used, l.limit) }));
}

function staleHint() {
  return usageState && usageState.fetchedAt ? `数据可能已过期（上次更新 ${fmtTime(usageState.fetchedAt / 1000)}）` : "数据可能已过期";
}

function buildRefreshButton() {
  const button = el("button", "cgs-icon-btn");
  button.type = "button";
  button.dataset.action = "cgs-usage-refresh";
  button.title = "刷新 CGS 用量";
  button.setAttribute("aria-label", "刷新 CGS 用量");
  button.innerHTML = ICONS.refresh;
  if (usageRefreshing) {
    button.setAttribute("aria-busy", "true");
    button.setAttribute("aria-disabled", "true");
  }
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    void handleRefreshUsage();
  });
  return button;
}

async function handleRefreshUsage() {
  if (usageRefreshing) return;
  usageRefreshing = true;
  renderUsageUi();
  try {
    const snap = await bridge.refreshUsage();
    if (snap) usageState = snap;
  } catch {
    // the main process keeps the last value; nothing to show
  } finally {
    usageRefreshing = false;
    renderUsageUi();
  }
}

/** The plan title (+ tier) of the primary subscription, or the tier alone when there is none. */
function planText(usage) {
  const tier = PRESET_NAMES[usage.tier] || "";
  const sub = usage.subscriptions[0];
  if (!sub) return `${tier || "CGS"} · 无订阅`;
  const title = sub.planTitle || "订阅";
  const text = tier && !title.toLowerCase().includes(tier.toLowerCase()) ? `${title} · ${tier}` : title;
  return usage.subscriptions.length > 1 ? `${text} +${usage.subscriptions.length - 1}` : text;
}

function buildUsageRow() {
  const row = el("div");
  row.id = USAGE_ROW_ID;
  row.dataset.cgsUsage = "row";
  return row;
}

function renderUsageRow(row) {
  const snap = usageState;
  const usage = snap.usage;
  const sig = JSON.stringify([usage, snap.stale, usageRefreshing, minuteBucket()]);
  sync(row, sig, () => {
    const sub = usage.subscriptions[0] || null;
    const percent = sub && !sub.unlimited ? percentOf(sub.amountUsed, sub.amountTotal) : 0;
    const limits = sub ? limitsOf(sub).filter((l) => l.limit > 0) : [];
    const worstLimit = limits.reduce((worst, l) => (!worst || l.percent > worst.percent ? l : worst), null);

    const head = el("div", "cgs-ur-head");
    head.append(el("span", "cgs-ur-badge", "CGS"), el("span", "cgs-ur-plan", planText(usage)));
    if (snap.stale) {
      const dot = el("span", "cgs-stale-dot");
      dot.title = staleHint();
      head.append(dot);
    }
    head.append(buildRefreshButton());
    const children = [head];

    const line = el("div", "cgs-ur-line");
    line.append(el("span", "cgs-ur-balance", `余额 ${usage.balance.display || "—"}`));
    if (sub) {
      const tag = el("span", "cgs-ur-pct", sub.unlimited ? "不限量" : percentText(percent));
      if (!sub.unlimited) tag.style.color = toneOf(percent);
      line.append(tag);
    }
    children.push(line);

    if (sub) {
      if (!sub.unlimited) children.push(makeBar(percent));
      const meta = el("div", "cgs-ur-meta");
      const usedLabel = sub.unlimited ? `已用 ${usedText(sub)}` : `${usedText(sub)} / ${totalText(sub)}`;
      let when = "";
      if (sub.resetPeriod !== "never" && sub.nextResetAt > 0) when = `${fmtIn(sub.nextResetAt)}重置`;
      else if (sub.endTime > 0) when = `${fmtDate(sub.endTime)} 到期`;
      meta.append(el("span", "", usedLabel));
      if (when) meta.append(el("span", "", when));
      children.push(meta);
      if (worstLimit) {
        children.push(el("div", "cgs-ur-limits", `日限额 ${limits.length} 个模型 · 最高 ${percentText(worstLimit.percent)}`));
      }
    }
    row.title = [
      `${planText(usage)} · 余额 ${usage.balance.display || "—"}`,
      ...(sub ? [sub.unlimited ? `已用 ${usedText(sub)}（不限量）` : `${usedText(sub)} / ${totalText(sub)}（${percentText(percent)}）`] : []),
      ...(snap.stale ? [staleHint()] : []),
    ].join("\n");
    row.classList.toggle("cgs-stale", Boolean(snap.stale));
    row.replaceChildren(...children);
  });
}

/** The row sits directly above ompweb's pinned Settings footer, i.e. below its provider-usage widget (if shown). */
function ensureUsageRow() {
  const show = !isLoadingScreen() && cgsState && cgsState.signedIn && usageState && usageState.usage;
  const settingsButton = show ? document.querySelector(SETTINGS_ROW_SELECTOR) : null;
  const footer = settingsButton && settingsButton.parentElement;
  const existing = document.getElementById(USAGE_ROW_ID);
  if (!footer || !footer.parentElement) {
    existing?.remove();
    return;
  }
  const row = existing || buildUsageRow();
  if (row.nextElementSibling !== footer || row.parentElement !== footer.parentElement) footer.before(row);
  renderUsageRow(row);
}

function buildSubscriptionBlock(sub) {
  const block = el("div", "cgs-uc-sub");
  const percent = sub.unlimited ? 0 : percentOf(sub.amountUsed, sub.amountTotal);

  const title = el("div", "cgs-uc-row");
  title.append(el("b", "", sub.planTitle || `订阅 #${sub.id}`), el("span", "cgs-uc-muted", RESET_LABELS[sub.resetPeriod]));
  const used = el("div", "cgs-uc-row");
  used.append(
    el("span", "", sub.unlimited ? `已用 ${usedText(sub)} · 不限量` : `已用 ${usedText(sub)} / ${totalText(sub)}`),
    sub.unlimited ? el("span") : Object.assign(el("b", "", percentText(percent)), { style: `color:${toneOf(percent)}` }),
  );
  block.append(title, used);
  if (!sub.unlimited) block.append(makeBar(percent));

  const facts = el("div", "cgs-uc-facts");
  if (sub.resetPeriod !== "never" && sub.nextResetAt > 0) facts.append(el("span", "", `下次重置 ${fmtDateTime(sub.nextResetAt)}（${fmtIn(sub.nextResetAt)}）`));
  facts.append(el("span", "", sub.endTime > 0 ? `到期 ${fmtDate(sub.endTime)}` : "长期有效"));
  block.append(facts);

  const limits = limitsOf(sub);
  if (limits.length > 0) {
    const list = el("div", "cgs-uc-limits");
    list.append(el("div", "cgs-uc-muted", "每日 Token 限额"));
    for (const l of limits) {
      const item = el("div", "cgs-uc-limit");
      const model = el("span", "cgs-uc-model", l.model);
      model.title = l.model;
      const num = el("span", "cgs-uc-num", l.limit > 0 ? `${fmtCount(l.used)} / ${fmtCount(l.limit)}` : `${fmtCount(l.used)} · 不限量`);
      if (l.resetAt > 0) num.title = `${fmtDateTime(l.resetAt)} 重置`;
      item.append(model, num);
      if (l.limit > 0) item.append(makeBar(l.percent));
      list.append(item);
    }
    block.append(list);
  }
  return block;
}

function renderUsageCard(card) {
  const snap = usageState;
  const usage = snap && snap.usage;
  const sig = JSON.stringify([cgsState.username, cgsState.tier, snap, usageRefreshing, minuteBucket()]);
  sync(card, sig, () => {
    const head = el("div", "cgs-uc-head");
    head.append(el("span", "cgs-uc-title", "CGS 账户与订阅"), el("span", "cgs-uc-spacer"));
    if (usage && snap.stale) {
      const stale = el("span", "cgs-uc-muted", "数据可能已过期");
      stale.title = staleHint();
      head.append(stale);
    } else if (usage && snap.fetchedAt) {
      head.append(el("span", "cgs-uc-muted", `更新于 ${fmtTime(snap.fetchedAt / 1000)}`));
    }
    head.append(buildRefreshButton());

    const account = el("div", "cgs-uc-account");
    const tierName = PRESET_NAMES[(usage && usage.tier) || cgsState.tier] || "";
    const nameWrap = el("span");
    nameWrap.append(el("strong", "", (usage && usage.username) || cgsState.username || "CGS"));
    account.append(nameWrap);
    if (tierName) account.append(el("span", "cgs-uc-pill", tierName));
    const children = [head, account];

    if (!usage) {
      children.push(el("div", "cgs-uc-muted", usageRefreshing ? "正在获取用量…" : "暂时无法获取用量数据，请稍后点击右上角刷新。"));
    } else {
      const balance = el("div", "cgs-uc-balance");
      balance.append(el("span", "cgs-uc-muted", "余额"), el("b", "", usage.balance.display || "—"));
      account.append(balance);
      if (usage.subscriptions.length === 0) {
        children.push(el("div", "cgs-uc-muted", "暂无生效中的订阅，按余额计费。"));
      } else {
        for (const sub of usage.subscriptions) children.push(buildSubscriptionBlock(sub));
      }
    }
    card.replaceChildren(...children);
  });
}

function ensureUsageCard() {
  const panel = !isLoadingScreen() && cgsState && cgsState.signedIn ? document.querySelector(USAGE_PANEL_SELECTOR) : null;
  const existing = document.getElementById(USAGE_CARD_ID);
  if (!panel) {
    existing?.remove();
    return;
  }
  const card = existing || el("section");
  card.id = USAGE_CARD_ID;
  if (panel.firstElementChild !== card) panel.prepend(card);
  renderUsageCard(card);
}

// Provider reports ompweb shows in its usage widget (same `/api/provider-usage` it polls), fetched to decide from data
// (report.provider), not text, whether anything other than CGS is in there.
let providerReports = null;
let providerReportsAt = 0;
let providerReportsInflight = false;
const PROVIDER_REPORTS_MIN_AGE_MS = 30_000;
const isCgsProvider = (report) => String((report && report.provider) || "").startsWith("cgs");

function refreshProviderReports() {
  if (providerReportsInflight || Date.now() - providerReportsAt < PROVIDER_REPORTS_MIN_AGE_MS) return;
  providerReportsInflight = true;
  providerReportsAt = Date.now();
  fetch("/api/provider-usage")
    .then((response) => (response.ok ? response.json() : null))
    .then((snapshot) => {
      providerReports = snapshot && Array.isArray(snapshot.reports) ? snapshot.reports : [];
    })
    .catch(() => {})
    .finally(() => {
      providerReportsInflight = false;
      renderUsageUi();
    });
}

/**
 * ompweb's ProviderUsageBar renders a <section> directly above the Settings footer (SessionSidebar.tsx); its aria-label is
 * localized, so it is matched structurally. While signed in it is hidden unless a non-CGS provider has a report; then only
 * the cgs-* rows are hidden (rows map 1:1, in order, to report.provider). Signed out → everything restored untouched.
 */
function syncProviderUsageVisibility() {
  const signedIn = !isLoadingScreen() && Boolean(cgsState && cgsState.signedIn);
  const settingsButton = document.querySelector(SETTINGS_ROW_SELECTOR);
  const footer = settingsButton && settingsButton.parentElement;
  let widget = footer ? footer.previousElementSibling : null;
  if (widget && widget.id === USAGE_ROW_ID) widget = widget.previousElementSibling;
  if (widget && !(widget.tagName === "SECTION" && widget.hasAttribute("aria-label"))) widget = null;
  const hide = new Set();
  if (signedIn && widget) {
    refreshProviderReports();
    const thirdParty = providerReports !== null && providerReports.some((report) => !isCgsProvider(report));
    if (!thirdParty) {
      hide.add(widget);
    } else {
      const rows = widget.querySelectorAll("button.provider-usage-row");
      if (rows.length === providerReports.length) {
        rows.forEach((row, i) => {
          if (isCgsProvider(providerReports[i]) && row.parentElement) hide.add(row.parentElement);
        });
      }
    }
  }
  for (const node of document.querySelectorAll('[data-cgs-hidden-usage="1"]')) {
    if (!hide.has(node)) delete node.dataset.cgsHiddenUsage;
  }
  for (const node of hide) if (node.dataset.cgsHiddenUsage !== "1") node.dataset.cgsHiddenUsage = "1";
}

function renderUsageUi() {
  syncProviderUsageVisibility();
  ensureUsageRow();
  ensureUsageCard();
}

function renderCgsUi() {
  ensurePresetsBlock();
  renderBubble();
  renderBranding();
  renderUsageUi();
}

function ensure() {
  scheduled = false;
  if (!document.documentElement) return;
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).append(style);
  }
  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = buildControls();
    renderIcons(root);
  }
  const opener = document.querySelector(OPENER_SELECTOR);
  if (opener) {
    if (root.previousElementSibling !== opener || root.parentElement !== opener.parentElement) opener.after(root);
    root.classList.remove("cgs-floating");
  } else if (root.parentElement !== document.body || !root.classList.contains("cgs-floating")) {
    if (!document.body) return;
    root.classList.add("cgs-floating");
    document.body.append(root);
  }
  if (document.body && !document.getElementById(OVERLAY_ID)) {
    document.body.append(buildOverlay());
  }
  renderCgsUi();
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(ensure);
}

function setMaximized(value) {
  maximized = value;
  const root = document.getElementById(ROOT_ID);
  if (root) renderIcons(root);
}

ipcRenderer.on("cgs:window-state", (_event, state) => setMaximized(Boolean(state && state.maximized)));
bridge.onState((state) => {
  cgsState = state;
  renderCgsUi();
});
bridge.onUsage((snap) => {
  usageState = snap;
  renderUsageUi();
});

window.addEventListener("DOMContentLoaded", () => {
  ensure();
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  // ompweb flips data-theme / class on OS changes and on user picks: re-evaluate whether to override.
  new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
  ipcRenderer.invoke("cgs:window-get-state").then((state) => setMaximized(Boolean(state && state.maximized)));
  ipcRenderer.invoke("cgs:get-logo").then((url) => {
    if (url) {
      cgsLogoUrl = url;
      renderCgsUi();
    }
  });
  bridge.getUsage().then((snap) => {
    if (snap) {
      usageState = snap;
      renderUsageUi();
    }
  });
  // Relative times ("3 小时后重置") age while nothing else changes.
  setInterval(renderUsageUi, 60_000);
  bridge.getState().then((state) => {
    if (state) {
      cgsState = state;
      renderCgsUi();
    }
  });
});
