"use strict";
// Injects into ompweb's DOM:
//   1. Minimize / maximize-restore / close window controls, immediately right of `button.shell-panel-opener`
//      inside `[data-topbar-right-group]` (or floating at top-right on narrow/loading layouts).
//   2. Brand and tier display; the CGS account card and sign-in entry (below).
//   3. Branding (always, signed in or not): ompweb's mark and name are replaced by the CGS logo and "CGS Desktop", and an
//      accent-colour stylesheet (the new-api console purple) overrides ompweb's accent variables.
//   4. First-run default theme "system" (only when the user has not chosen one).
//   5. ompweb's `omp-*` localStorage prefs (language, theme, font size, UI scale, usage-widget prefs, ...) are mirrored
//      in <userData>/web-prefs.json: restored before ompweb's scripts run, deltas sent back, so they survive an origin
//      (port) change on top of the stable port from services.choosePort.
//   6. While signed in: a compact CGS balance/subscription row above the Settings footer in ompweb's sidebar and a CGS
//      account card at the top of Settings → 用量与分析 (`#settings-panel-usage`), fed by the main process
//      (`/api/device/usage`: every 5 min, on window focus, manual refresh).
const { contextBridge, ipcRenderer } = require("electron");

const ROOT_ID = "cgs-window-controls";
const OVERLAY_ID = "cgs-overlay-root";
const STYLE_ID = "cgs-window-controls-style";
const THEME_STYLE_ID = "cgs-theme-style";
const OPENER_SELECTOR = "[data-topbar-right-group] button.shell-panel-opener";
const USAGE_PANEL_SELECTOR = "#settings-panel-usage";
const SETTINGS_ROW_SELECTOR = "button.sidebar-settings-row";
const USAGE_ROW_ID = "cgs-usage-row";
const USAGE_CARD_ID = "cgs-usage-card";
// ompweb's brand mark (components/OmpWebLogo.tsx): <svg role="img" viewBox="0 0 64 64">.
const OMP_LOGO_SELECTOR = 'svg[role="img"][viewBox="0 0 64 64"]';
const BRAND_NAME = "CGS Desktop";
const LOGO_SCALE = 1.25;

const TIER_NAMES = { free: "Free", go: "Go", pro: "Pro", dedicated: "独享" };

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
  openLogin: () => ipcRenderer.invoke("cgs:open-login"),
  getUsage: () => ipcRenderer.invoke("cgs:get-usage"),
  refreshUsage: () => ipcRenderer.invoke("cgs:refresh-usage"),
  refreshAccount: () => ipcRenderer.invoke("cgs:refresh-account"),
  openConsole: (page) => ipcRenderer.invoke("cgs:open-console", page),
  logout: () => ipcRenderer.invoke("cgs:logout"),
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

/* CGS sign-in button (reuses ompweb's settings rows) */
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

/* CGS integration card: top of Settings → API Keys & Providers */
#cgs-providers-card {
  box-sizing: border-box;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0 0 16px;
  padding: 14px 16px;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
  border-radius: var(--radius-control, 10px);
  background: var(--bg-subtle, transparent);
  color: var(--text, CanvasText);
  font-size: 13px;
  line-height: 1.45;
}
.cgs-pc-head { display: flex; align-items: center; gap: 10px; }
.cgs-pc-logo { width: 35px; height: 35px; border-radius: 6px; flex-shrink: 0; object-fit: contain; }
.cgs-pc-heading { display: flex; flex-direction: column; min-width: 0; }
.cgs-pc-title { font-size: 14px; font-weight: 600; }
.cgs-pc-status { display: inline-flex; align-items: center; gap: 6px; color: var(--text-muted, GrayText); font-size: 12px; }
.cgs-pc-status::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--status-success, #2e9d57); }
.cgs-pc-status[data-tone="warning"]::before { background: var(--status-warning, #c18401); }
.cgs-pc-status[data-tone="error"]::before { background: var(--status-error, #d63a3a); }
.cgs-pc-status[data-tone="error"] { color: var(--status-error, #d63a3a); }
.cgs-pc-providers { display: flex; flex-wrap: wrap; gap: 6px; }
.cgs-pc-chip {
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
  background: var(--bg, transparent);
  color: var(--text-muted, GrayText);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
}
.cgs-pc-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.cgs-pc-btn {
  all: unset;
  box-sizing: border-box;
  padding: 5px 12px;
  border-radius: 8px;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.4));
  background: var(--bg, transparent);
  color: var(--text, CanvasText);
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}
.cgs-pc-btn:hover:not([aria-disabled="true"]) { border-color: var(--accent, #9453c9); }
.cgs-pc-btn:focus-visible { outline: 2px solid var(--accent, #9453c9); outline-offset: 2px; }
.cgs-pc-btn[aria-disabled="true"] { opacity: 0.5; cursor: default; }
.cgs-pc-btn[data-variant="primary"] { border-color: transparent; background: var(--accent-strong, var(--accent, #9453c9)); color: var(--on-accent, #fff); }
.cgs-pc-btn[data-variant="danger"] { margin-left: auto; color: var(--status-error, #d63a3a); border-color: color-mix(in srgb, var(--status-error, #d63a3a) 45%, transparent); }
.cgs-pc-btn[data-variant="danger"]:hover:not([aria-disabled="true"]) { background: color-mix(in srgb, var(--status-error, #d63a3a) 12%, transparent); border-color: var(--status-error, #d63a3a); }
#cgs-confirm {
  position: fixed;
  inset: 0;
  z-index: 2147483645;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  -webkit-app-region: no-drag;
}
.cgs-confirm-box {
  box-sizing: border-box;
  width: min(420px, calc(100vw - 32px));
  padding: 18px 20px;
  border-radius: 12px;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
  background: var(--bg-panel, Canvas);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
  color: var(--text, CanvasText);
  font-size: 13px;
  line-height: 1.55;
}
.cgs-confirm-box h3 { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
.cgs-confirm-box p { margin: 0 0 6px; color: var(--text-muted, GrayText); }
.cgs-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.cgs-confirm-actions .cgs-pc-btn[data-variant="danger"] { margin-left: 0; background: var(--status-error, #d63a3a); border-color: transparent; color: #fff; }
`;

let maximized = false;
let scheduled = false;
let cgsState = null;
let cgsLogoUrl = null;
let usageState = null; // { usage, stale, fetchedAt } from the main process; usage is null until the first success
let usageRefreshing = false;
let accountBusy = null; // "refresh" | "logout" while an account action from the providers card is running
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

  const toast = document.createElement("div");
  toast.id = "cgs-toast";
  toast.setAttribute("role", "status");
  toast.hidden = true;

  overlay.append(toast);
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

function showToast(text, ms = 3200) {
  const toast = document.getElementById("cgs-toast");
  if (!toast) return;
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, ms);
}

/**
 * ompweb loads its provider/model lists when Settings → API Keys & Providers mounts. After the CGS providers appeared or
 * vanished, ask /api/models (which makes ompweb reload its models when models.yml changed) and then re-mount the panel by
 * visiting another settings tab and coming back.
 */
function refreshOmpwebProviders() {
  if (!document.querySelector(PROVIDERS_PANEL_SELECTOR)) return;
  const remount = () => {
    const other = document.getElementById("settings-tab-models");
    if (!other || !document.querySelector(PROVIDERS_PANEL_SELECTOR)) return;
    other.click();
    setTimeout(() => document.getElementById("settings-tab-providers")?.click(), 50);
  };
  fetch("/api/models").catch(() => {}).finally(remount);
}

async function handleOpenLogin() {
  const wasSignedIn = Boolean(cgsState && cgsState.signedIn);
  const next = await bridge.openLogin();
  if (next) cgsState = next;
  renderCgsUi();
  if (next && Boolean(next.signedIn) !== wasSignedIn) refreshOmpwebProviders();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Re-render `node` only when `sig` changed (keeps the MutationObserver from looping on our own mutations). */
function sync(node, sig, build) {
  if (node.dataset.cgsSig === sig) return;
  node.dataset.cgsSig = sig;
  build(node);
}

function renderBranding() {
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

  // Brand: ompweb's mark is hidden and the CGS logo put next to it, and ompweb's name becomes "CGS Desktop", always (the
  // loading screen is ours already).
  if (isLoadingScreen()) return;
  for (const logo of document.querySelectorAll(OMP_LOGO_SELECTOR)) {
    const next = logo.nextElementSibling;
    if (!cgsLogoUrl) continue;
    if (!(next && next.classList.contains("cgs-brand-logo"))) {
      const img = document.createElement("img");
      img.className = "cgs-brand-logo";
      img.alt = "CGS";
      img.src = cgsLogoUrl;
      // 25% larger than ompweb's own mark (20 px in the sidebar header, 26 px on the welcome screen).
      const size = Number(logo.getAttribute("width") || "20") * LOGO_SCALE;
      img.width = size;
      img.height = size;
      logo.after(img);
    }
    logo.dataset.cgsReplaced = "1";
  }
  for (const word of document.querySelectorAll(".omp-wordmark")) {
    if (word.textContent !== BRAND_NAME) word.textContent = BRAND_NAME;
  }
  // Sidebar header: <button title="Show ompweb version"> holding <span><span>omp</span><span>web</span></span>.
  for (const button of document.querySelectorAll('button[title$="ompweb version"], button[title$="ompweb name"]')) {
    button.title = button.title.replace("ompweb", BRAND_NAME);
    const parts = button.querySelectorAll(":scope > span > span");
    if (parts.length === 2 && parts[0].textContent === "omp" && parts[1].textContent === "web") {
      // The narrow sidebar header fits "CGS" on one line (the full name is the window title).
      parts[0].textContent = "CGS";
      parts[1].textContent = "";
    }
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
  const tier = TIER_NAMES[usage.tier] || "";
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
    const tierName = TIER_NAMES[(usage && usage.tier) || cgsState.tier] || "";
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

// ---- Settings → API Keys & Providers: CGS integration card ----------------------------------------------------------
const PROVIDERS_PANEL_SELECTOR = "#settings-panel-providers";
const PROVIDERS_CARD_ID = "cgs-providers-card";
const CONFIRM_ID = "cgs-confirm";

/** In-page confirmation for 「退出账户」. Resolves true when confirmed. */
function confirmLogout() {
  return new Promise((resolve) => {
    document.getElementById(CONFIRM_ID)?.remove();
    const overlay = el("div");
    overlay.id = CONFIRM_ID;
    const box = el("div", "cgs-confirm-box");
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "退出 CGS 账户");
    box.append(
      el("h3", "", "退出 CGS 账户？"),
      el("p", "", "此设备上的 CGS 密钥将在服务器端吊销，无法再使用。"),
      el("p", "", "CGS 模型提供方（cgs-openai / cgs-anthropic / cgs-gemini）以及指向它们的默认模型设置将被移除；你自己修改过的其他设置不受影响。"),
      el("p", "", "之后可以随时重新登录。"),
    );
    const actions = el("div", "cgs-confirm-actions");
    const cancel = el("button", "cgs-pc-btn", "取消");
    cancel.type = "button";
    cancel.dataset.action = "cgs-logout-cancel";
    const confirm = el("button", "cgs-pc-btn", "退出账户");
    confirm.type = "button";
    confirm.dataset.action = "cgs-logout-confirm";
    confirm.dataset.variant = "danger";
    actions.append(cancel, confirm);
    box.append(actions);
    overlay.append(box);
    const done = (value) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        done(false);
      }
    };
    cancel.addEventListener("click", () => done(false));
    confirm.addEventListener("click", () => done(true));
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) done(false);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.append(overlay);
    cancel.focus();
  });
}

async function handleRefreshAccount() {
  if (accountBusy) return;
  accountBusy = "refresh";
  renderUsageUi();
  try {
    const next = await bridge.refreshAccount();
    if (next) {
      if (next.state) cgsState = next.state;
      if (next.usage) usageState = next.usage;
    }
  } catch {
    // the main process keeps the last values
  } finally {
    accountBusy = null;
    renderCgsUi();
  }
}

async function handleLogout() {
  if (accountBusy) return;
  if (!(await confirmLogout())) return;
  accountBusy = "logout";
  renderUsageUi();
  let result;
  try {
    result = await bridge.logout();
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  accountBusy = null;
  if (!result || !result.ok) {
    renderCgsUi();
    showToast(`退出失败：${(result && result.error) || "未知错误"}`, 6000);
    return;
  }
  cgsState = result.state;
  const usage = await bridge.getUsage().catch(() => null);
  usageState = usage || null;
  renderCgsUi();
  const problems = [];
  if (!result.serverRevoked) problems.push("已在本机退出，但服务器端密钥未能吊销，可在 CGS 后台删除");
  if (result.cleanupErrors && result.cleanupErrors.length > 0) problems.push(`部分本地配置未能清理：${result.cleanupErrors.join("；")}`);
  showToast(problems.length > 0 ? problems.join("。") : "已退出 CGS 账户，设备密钥已吊销", problems.length > 0 ? 9000 : 4000);
  refreshOmpwebProviders();
}

function pcButton(label, action, onClick, variant) {
  const button = el("button", "cgs-pc-btn", label);
  button.type = "button";
  button.dataset.action = action;
  if (variant) button.dataset.variant = variant;
  if (accountBusy) button.setAttribute("aria-disabled", "true");
  button.addEventListener("click", () => {
    if (!accountBusy) onClick();
  });
  return button;
}

function buildProvidersHead(state) {
  const head = el("div", "cgs-pc-head");
  if (cgsLogoUrl) {
    const img = el("img", "cgs-pc-logo");
    img.alt = "CGS";
    img.src = cgsLogoUrl;
    head.append(img);
  }
  const heading = el("div", "cgs-pc-heading");
  const title = el("div");
  title.style.cssText = "display:flex;align-items:center;gap:8px";
  title.append(el("span", "cgs-pc-title", "Cicori Good Service"));
  if (state.signedIn && state.tier) title.append(el("span", "cgs-uc-pill", TIER_NAMES[state.tier] || state.tier));
  heading.append(title);
  head.append(heading);
  return { head, heading };
}

function renderProvidersCard(card) {
  const state = cgsState;
  const usage = usageState && usageState.usage;
  const sig = JSON.stringify([state, usageState, accountBusy, Boolean(cgsLogoUrl), minuteBucket()]);
  sync(card, sig, () => {
    const { head, heading } = buildProvidersHead(state);
    const children = [head];
    const actions = el("div", "cgs-pc-actions");
    if (state.signedIn) {
      const stale = Boolean(usageState && usageState.stale);
      const status = el("span", "cgs-pc-status", stale ? "数据可能已过期" : "连接正常");
      status.dataset.tone = stale ? "warning" : "ok";
      if (stale) status.title = staleHint();
      heading.append(status);

      const account = el("div", "cgs-uc-account");
      account.append(el("strong", "", state.username || "CGS"));
      const balance = el("span", "cgs-uc-balance");
      balance.append(el("span", "cgs-uc-muted", "余额"), el("b", "", usage ? usage.balance.display || "—" : "—"));
      account.append(balance);
      account.append(el("span", "cgs-uc-muted", usage ? planText(usage) : "暂无用量数据"));
      children.push(account);

      if (Array.isArray(state.providers) && state.providers.length > 0) {
        const list = el("div", "cgs-pc-providers");
        for (const provider of state.providers) list.append(el("span", "cgs-pc-chip", `${provider.id} · ${provider.models} 个模型`));
        children.push(list);
      }
      actions.append(
        pcButton("打开 CGS 后台", "cgs-open-console", () => void bridge.openConsole()),
        pcButton("客户端管理", "cgs-manage-clients", () => void bridge.openConsole("clients")),
        pcButton(accountBusy === "refresh" ? "刷新中…" : "刷新", "cgs-refresh-account", () => void handleRefreshAccount()),
        pcButton(accountBusy === "logout" ? "正在退出…" : "退出账户", "cgs-logout", () => void handleLogout(), "danger"),
      );
    } else if (state.keyRejected) {
      const status = el("span", "cgs-pc-status", "密钥已失效");
      status.dataset.tone = "error";
      heading.append(status);
      children.push(el("div", "cgs-uc-muted", `${state.username ? `账户 ${state.username} 的` : ""}设备密钥已被服务器拒绝，请重新登录，或退出账户清理本机配置。`));
      actions.append(
        pcButton("重新登录", "cgs-login", () => void handleOpenLogin(), "primary"),
        pcButton("打开 CGS 后台", "cgs-open-console", () => void bridge.openConsole()),
        pcButton(accountBusy === "logout" ? "正在退出…" : "退出账户", "cgs-logout", () => void handleLogout(), "danger"),
      );
    } else {
      heading.append(el("span", "cgs-pc-status", "未登录"));
      children.push(el("div", "cgs-uc-muted", "登录后自动配置 CGS 模型（OpenAI / Anthropic / Gemini），并显示余额与订阅用量。"));
      actions.append(pcButton("登录 CGS", "cgs-login", () => void handleOpenLogin(), "primary"));
      heading.lastChild.dataset.tone = "warning";
    }
    children.push(actions);
    card.replaceChildren(...children);
  });
}

function ensureProvidersCard() {
  const panel = !isLoadingScreen() && cgsState ? document.querySelector(PROVIDERS_PANEL_SELECTOR) : null;
  const existing = document.getElementById(PROVIDERS_CARD_ID);
  if (!panel) {
    existing?.remove();
    return;
  }
  const card = existing || el("section");
  card.id = PROVIDERS_CARD_ID;
  // Directly below ompweb's heading block (the panel's first child), above its own cards.
  const first = panel.firstElementChild === card ? card.nextElementSibling : panel.firstElementChild;
  if (first && card.previousElementSibling !== first) first.after(card);
  else if (!first && card.parentElement !== panel) panel.append(card);
  renderProvidersCard(card);
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
  ensureProvidersCard();
}

function renderCgsUi() {
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
