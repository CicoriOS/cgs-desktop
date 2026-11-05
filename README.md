# CGS Desktop

Windows Electron app that bundles the latest [omp](https://github.com/can1357/oh-my-pi) coding agent and the
[ompweb](https://github.com/kahme247/ompweb) web UI, plus the CGS (Cicori Good Service) provider plugin. At build time,
`omp` is downloaded from its latest release and `ompweb` is cloned and compiled from its newest `main` commit (no fork, no
patches to its source).

## Development

Requires Node 24+ (with `npm`), `git` and `bun` (`npm ci` inside the `ompweb` checkout also installs the Bun version
`ompweb` pins).

```sh
npm install
npm run fetch:linux   # prepares vendor/linux-x64/{omp,chromium,ompweb}; use `npm run fetch` on Windows
npm start
npm test
```

On Linux/WSL, if Electron aborts with a `chrome-sandbox` error, run `npm start -- --no-sandbox`.

`npm run fetch*` (`scripts/fetch-upstream.mjs` + `scripts/build-ompweb.mjs`):

- `omp`: asks GitHub for the latest `can1357/oh-my-pi` release, verifies the binary against `SHA256SUMS.txt` and skips the
  download when the tag in `vendor/<target>/manifest.json` matches.
- `ompweb`: clones (or fast-forwards) `https://github.com/kahme247/ompweb` into `vendor/src/ompweb`, runs `npm ci` + the
  SPA build (`scripts/build-client.ts`) and compiles `server/binary.ts` + the static root (`dist/`, `public/`,
  `lib/omp/session-edit-extension.mjs`, `node_modules/katex`, `licenses/`) into `vendor/<target>/ompweb/` via our own
  `scripts/ompweb-compile.ts`. Skips the rebuild when `manifest.json`'s `ompweb.commit` matches `HEAD` and the binary is
  present.
- `chromium`: omp's browser tool drives Chromium through **puppeteer-core** (not Playwright) and, absent
  `PUPPETEER_EXECUTABLE_PATH` and a system Chrome, downloads Chrome for Testing into `~/.omp/puppeteer` on first use
  (~190 MB). `scripts/fetch-chromium.mjs` pre-fetches that exact build: the build id is read from the
  `PUPPETEER_REVISIONS` table embedded in the downloaded `omp` binary (so it always matches the bundled omp release;
  currently 150.0.7871.24 for omp v18.16.0 / puppeteer-core 25.3.0), the zip comes from the official
  `https://storage.googleapis.com/chrome-for-testing-public/<build>/<win64|linux64>/chrome-<platform>.zip` and is
  extracted (own zip reader, CRC-checked) to `vendor/<target>/chromium/chrome-win64/chrome.exe` (linux:
  `chrome-linux64/chrome`). `chromium/.build-id` is the completion marker and `manifest.json` records
  `chromium.{buildId,platform,url}`; an up-to-date install is skipped. `scripts/fetch-chromium.mjs --target <t>` runs it alone.

Set `GITHUB_TOKEN` to avoid API rate limits; `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` are honoured by both the API downloader
and `git`/`npm`/`bun`.

## Packaging

```sh
npm run dist:win      # fetches win-x64 upstreams, then builds the NSIS installer into dist/
```

The installer bundles `vendor/win-x64/omp` → `resources/omp`, `vendor/win-x64/ompweb` → `resources/ompweb`,
`vendor/win-x64/chromium` → `resources/chromium` and `plugin/omp-cgs` → `resources/plugin/omp-cgs` (all as
`extraResources`, outside the asar so the executables can run;
`scripts/after-pack.js` copies ompweb's `node_modules/` because electron-builder never copies those directories itself).
Output: `dist/CGS Desktop-Setup-<version>.exe` (NSIS, per-user, x64) and `dist/win-unpacked/`. The bundled Chromium adds
about 149 MB to the installer (279 MB → 428 MB) and ~420 MB unpacked.

On Windows `npm run dist:win` just works. On Linux, electron-builder needs a way to run Windows tools (rcedit for the exe
icon/version resources, and the NSIS uninstaller stage). On WSL use Windows interop instead of Wine:

```sh
cmd.exe /c 'net use Z: \\wsl.localhost\<distro> /persistent:no'   # NSIS embeds Z:\... paths
PATH=$PWD/scripts/wsl-shim:$PATH USE_SYSTEM_WINE=true npm run dist:win
cmd.exe /c 'net use Z: /delete /y'
```

Behind a proxy, `npm install` / the build also need `ELECTRON_GET_USE_PROXY=1 GLOBAL_AGENT_HTTPS_PROXY=$HTTPS_PROXY`
(the Electron binary downloader ignores `HTTPS_PROXY` otherwise).


## Environment variables

| Variable | Effect |
|---|---|
| `CGS_BASE_URL` | CGS server (default `https://api.cicori.com`), e.g. a local new-api for testing |
| `GITHUB_TOKEN` | used by `scripts/fetch-upstream.mjs` / `scripts/build-ompweb.mjs` for GitHub API and `git` calls |
| `HTTPS_PROXY` | proxy for the fetch / build scripts |

## Architecture

- `src/main/main.js`: single instance → `prepareAgentDir` (installs the CGS extension, config defaults) → starts services in
  parallel with the login check → the CGS login popup **only when no credentials are saved** (neither CGS nor a
  third-party provider login) → frameless main window (loading screen first) on `http://127.0.0.1:<port>/`. External links
  open in the system browser. `nativeTheme.themeSource = "system"`, so Chromium's `prefers-color-scheme` follows the OS.
- `src/main/services.js`: spawns `ompweb --no-open -H 127.0.0.1 -p <port>`, waits for `Ready on`, then `ompweb host`. The port is
  **stable**: ompweb's localStorage/cookies are per origin, so a random port per launch would reset every UI preference.
  The first launch takes 39177 (a random free port when that is taken) and stores it in `<userData>/ompweb-port.json`; later
  launches reuse it. When the stored port is busy that launch uses a random free port and keeps the stored one (the prefs
  mirror below makes the origin change harmless).
  Env for both: `PI_CODING_AGENT_DIR=<userData>/omp/agent`, `OMP_WEB_OMP_BIN=<bundled omp>`, bundled omp dir prefixed to `PATH`,
  `PUPPETEER_EXECUTABLE_PATH=<resources>/chromium/chrome-win64/chrome.exe` (dev: `vendor/<target>/chromium/...`). That variable
  outranks omp's system-Chrome/Edge lookup and its Chrome-for-Testing download, so omp's browser tool launches only the
  bundled build, offline, and never a system browser. Its headless profile is omp's own throwaway `omp-chrome-profile-*`
  temp dir (deleted on close), never the user's Chrome profile. No omp settings key is involved.
  Logs go to `<userData>/logs/`; both processes are killed (process tree on Windows) on quit, and a crash shows an error dialog.
- `src/main/main-preload.js`: injected into ompweb (no source patches; a `MutationObserver` re-attaches everything after
  React re-renders). It adds
  - minimize / maximize-restore / close buttons right of ompweb's right-panel toggle (floating at the top-right when it is
    absent) and makes `.shell-topbar` draggable;
  - the **「CGS 预设」 block at the top of Settings → AI模型默认值** (`#settings-panel-models`, found by id so it works in every
    locale): Free / Go / Pro / 独享 radio buttons (current one checked, the detected tier tagged 推荐, disabled with a hint
    when signed out), the `<username> · <套餐>` account line, and a 「登录 CGS」 button when signed out. There is no topbar button;
  - the top-right tier-change bubble (切换 / 保持当前 / 查看预设; 查看预设 opens Settings at the block) and the switch toast;
  - logo: while signed in, ompweb's brand mark (sidebar, welcome header) is replaced by the CGS logo; signed out → omp's;
  - theme: on first run (no `omp-theme` in localStorage) the preference is set to ompweb's `system`, which tracks the OS
    light/dark setting live. While the stored preference is `system`, an injected stylesheet maps new-api's 「薰衣草梦」
    (lavender-dream, `web/src/styles/theme.css` + `theme-presets.css`) light/dark palettes onto ompweb's `--bg*`, `--text*`,
    `--accent*` … variables (primary light `oklch(0.5709 0.1808 306.89)` ≈ `#9453c9`, dark `oklch(0.6359 0.1699 307.95)`
    ≈ `#a76ad9`), independent of sign-in. A theme the user picked explicitly is never overridden or overwritten.
    Injected UI, loading screen and login popup use the same palette (via ompweb's variables / `prefers-color-scheme`);
  - **ompweb UI preferences survive restarts and origin changes**: every `omp-*` localStorage key (`omp-lang`, `omp-theme`,
    `omp-font-size`, `omp-ui-scale`, `omp-web:provider-usage-*`, …; not `omp-draft-*`) is mirrored in
    `<userData>/web-prefs.json` (`src/main/prefs.js`). The preload restores the file into localStorage synchronously
    (`ipcRenderer.sendSync`) before ompweb's scripts run and sends deltas back (a 1 s diff plus `pagehide`/`beforeunload`/
    `visibilitychange`; page scripts live in another world, so `Storage` cannot be wrapped). Once the file exists it is
    authoritative; before that the origin's own keys seed it. The first-run `omp-theme=system` default runs after the restore;
  - **CGS usage** (signed in only; data from `GET /api/device/usage`, `src/cgs/usage.js`, polled by `CgsController` every
    5 minutes, on window focus (at most every 15 s) and via the refresh buttons; exposed as `cgsDesktop.getUsage /
    refreshUsage / onUsage`): a compact row in the sidebar directly above ompweb's Settings footer (below its own provider-usage
    widget, found via `button.sidebar-settings-row`) with plan title/tier, `余额 <display>`, the first subscription's
    used/total bar with its reset time (`不限量` when `amount_total` is 0) and a daily-token-limit summary; and a card at the very
    top of Settings → 用量与分析 (`#settings-panel-usage`, by id) with the account, tier, balance and, per active
    subscription, used/total, reset period and next reset, end date and per-model daily token limits with bars. Without a
    subscription only the balance shows. A network error keeps the last value and marks it stale (dot / 「数据可能已过期」);
    a 401 is handled like signed-out (usage dropped, polling stops until the next login). While signed in, ompweb's own
    provider-usage widget (the `<section>` above the Settings footer, found structurally) is hidden because the CGS row replaces
    it, unless `/api/provider-usage` (fetched by the preload, decided from `reports[].provider`, not text) contains a
    non-`cgs*` provider (e.g. an Anthropic/Codex OAuth account): then the widget stays and only its `cgs*` rows are hidden.
    Signed out → the widget is untouched.
  - **CGS section at the top of Settings → API Keys & Providers** (`#settings-panel-providers`, by id; below ompweb's heading).
    Signed out: CGS logo, short description and 「登录 CGS」 (the same device-link popup; a successful login applies the preset
    by the usual first-login rule). Signed in: logo, username, tier badge, balance + current plan (from the usage snapshot, no
    second fetch), connection status (连接正常 / 数据可能已过期 / 密钥已失效), the registered providers
    (`cgs-openai` / `cgs-anthropic` / `cgs-gemini`, with model counts) and the buttons 「打开 CGS 后台」 (system browser,
    `<baseUrl>/dashboard`; the opened URL is logged as `[cgs] openExternal …`), 「管理预设」 (jumps to the CGS 预设 block),
    「刷新」 and 「退出账户」. When the server rejects the key (401) the card shows 「密钥已失效」 with 「重新登录」 and 「退出账户」.
    IPC: `cgs:refresh-account`, `cgs:open-console`, `cgs:logout` (`cgsDesktop.refreshAccount / openConsole / logout`).
  - **退出账户** (after an in-page confirmation): `CgsController.logout()` stops the polling, waits for requests in flight,
    calls `POST <baseUrl>/api/device/logout` with the device key (200 revoked, 401 already revoked; a network error or 5xx
    only shows the toast 「已在本机退出，但服务器端密钥未能吊销，可在 CGS 后台删除」), then cleans up locally
    (`signOutLocally` in `src/cgs/config-writer.js`): deletes `<agentDir>/cgs/credentials.json`, removes
    `providers.cgs-*` from `models.yml`, removes from `config.yml` only the preset-managed keys that still point at `cgs-*`
    models (`modelRoles.default/task/web/smol/scout`, the `cgs-*` entries of `retry.fallbackChains.web`; values the user
    changed stay) and resets `state.json` (`appliedPreset`, `lastKnownTier`, `dismissedTier`) so the next login re-applies
    the preset. models.yml's mtime is bumped, which makes ompweb drop its model cache and restart its utility omp (the same
    path as after login; already running sessions keep their providers). The sidebar row, Usage card and tier bubble
    disappear, ompweb's provider-usage widget and omp logo return and the presets are greyed out. The login popup on the
    next launch follows the usual rule (only when no credentials of any kind are saved).
- Branding assets (`assets/`, regenerate with `npm run icons`, which rasterizes via Electron): `omp-logo.svg` / `icon.png` /
  `icon.ico` are ompweb's default mark (`vendor/src/ompweb/public/icon.svg`) used for the exe/installer icon, the default
  window/taskbar icon and the loading screen; `cgs-logo.svg` / `cgs-icon.png` / `cgs-icon.ico` come from
  `~/new-api/web/public/logo.svg` and are the window/taskbar icon while signed in (switched at runtime on tier
  detection / 401), the in-app brand logo and the login popup logo (always CGS).
- `src/cgs/`, `src/login/`, `plugin/omp-cgs/`: CGS device-link login (popup supports light and dark), config writer, tier
  polling and the omp provider extension.
