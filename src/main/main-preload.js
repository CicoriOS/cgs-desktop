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
const { contextBridge, ipcRenderer } = require("electron");

const ROOT_ID = "cgs-window-controls";
const OVERLAY_ID = "cgs-overlay-root";
const STYLE_ID = "cgs-window-controls-style";
const THEME_STYLE_ID = "cgs-theme-style";
const BLOCK_ID = "cgs-presets-block";
const OPENER_SELECTOR = "[data-topbar-right-group] button.shell-panel-opener";
const MODELS_PANEL_SELECTOR = "#settings-panel-models";
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

// Default to following the OS theme until the user picks one (ompweb stores the choice in localStorage "omp-theme").
try {
  if (window.location.protocol.startsWith("http") && window.localStorage.getItem("omp-theme") === null) {
    window.localStorage.setItem("omp-theme", "system");
  }
} catch {
  // storage unavailable: ompweb falls back to its own default
}

const ICONS = {
  minimize: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10" stroke="currentColor" stroke-width="1" fill="none"/></svg>',
  maximize: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" stroke-width="1" fill="none"/></svg>',
  restore:
    '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5V0.5h7v7h-2" stroke="currentColor" stroke-width="1" fill="none"/><rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" stroke-width="1" fill="none"/></svg>',
  close: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" stroke-width="1" fill="none"/></svg>',
  check: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.2 6.3L4.8 8.9L9.8 3.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
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
`;

let maximized = false;
let scheduled = false;
let cgsState = null;
let cgsLogoUrl = null;
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

function renderCgsUi() {
  ensurePresetsBlock();
  renderBubble();
  renderBranding();
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
  bridge.getState().then((state) => {
    if (state) {
      cgsState = state;
      renderCgsUi();
    }
  });
});
