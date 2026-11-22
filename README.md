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
  `PUPPETEER_EXECUTABLE_PATH` and a system Chrome, downloads Chrome for Testing into `<config root>/puppeteer` on first use
  (~190 MB). `scripts/fetch-chromium.mjs` pre-fetches that exact build: the build id is read from the
  `PUPPETEER_REVISIONS` table embedded in the downloaded `omp` binary (so it always matches the bundled omp release;
  currently 150.0.7871.24 for omp v18.16.0 / puppeteer-core 25.3.0), the zip comes from the official
  `https://storage.googleapis.com/chrome-for-testing-public/<build>/<win64|linux64>/chrome-<platform>.zip` and is
  extracted (own zip reader, CRC-checked) to `vendor/<target>/chromium/chrome-win64/chrome.exe` (linux:
  `chrome-linux64/chrome`). `chromium/.build-id` is the completion marker and `manifest.json` records
  `chromium.{buildId,platform,url}`; an up-to-date install is skipped. `scripts/fetch-chromium.mjs --target <t>` runs it alone.

Set `GITHUB_TOKEN` to avoid API rate limits; `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` are honoured by both the API downloader
and `git`/`npm`/`bun`. The downloader uses Node's built-in proxy support: Node >= 24.5, or an older Node 24 started with
`NODE_USE_ENV_PROXY=1` (`NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:10808 npm run fetch:linux`).

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

### Linux AppImage

```sh
npm run dist:linux    # fetches linux-x64 upstreams, then builds dist/CGS-Desktop-<version>-x86_64.AppImage
```

Same layout as Windows (`vendor/linux-x64/*` → `resources/*`, per-platform `extraResources` in package.json). The app runs
omp in an environment of its own, never the user's: it starts the bundled `resources/omp/omp` (put first on PATH and passed
as `OMP_WEB_OMP_BIN`), uses its own config root `~/.cgs` (`PI_CONFIG_DIR`; a local omp or pi keeps `~/.omp`) with the
agent directory under userData (`~/.config/CGS Desktop/omp/agent`), drops every inherited `PI_*` / `OMP_*` variable and the
AppImage launcher's own, and points `XDG_DATA_HOME` at an empty directory next to it so a locally installed omp's XDG data is
never picked up (`buildEnv` in `src/main/services.js`). omp hard-codes its native-addon cache to `~/.omp/natives`, which
`PI_CONFIG_DIR` does not move, so `PI_NATIVES_DIR=~/.cgs/natives` is set too. (Patching `".omp"` in the release binary does not
work: the shipped executable runs embedded bytecode, so changing the bundled source text has no effect.) The one hard-coded
directory left is `~/.omp/browser-state`, used by omp's browser tool for saved page state. On a system without FUSE run
the AppImage with `--appimage-extract-and-run`; add `--no-sandbox` where Electron's sandbox is unavailable.


## Environment variables

| Variable | Effect |
|---|---|
| `CGS_BASE_URL` | CGS server (default `https://ai.tmp.cnklp.cn`), e.g. a local new-api for testing |
| `GITHUB_TOKEN` | used by `scripts/fetch-upstream.mjs` / `scripts/build-ompweb.mjs` for GitHub API and `git` calls |
| `HTTPS_PROXY` | proxy for the fetch / build scripts |

## Architecture

- `src/main/main.js`: single instance → `prepareAgentDir` (installs the CGS extension, config defaults) → starts services in
  parallel with the login check → the CGS login popup **whenever CGS is not signed in** (every build signs in through CGS;
  closing the popup unsigned quits the app; it offers the browser-approved login and email registration, see "Email
  registration" below) → frameless main window (loading screen first) on `http://127.0.0.1:<port>/`. External links
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
  - the sign-in entry and account card (see below); there is no topbar button, no preset picker and no tier-change bubble;
  - branding: ompweb's brand mark and name are replaced by the CGS logo and name, always (see Branding below);
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
    Signed out: CGS logo, short description and 「登录 CGS」 (the same device-link popup; the first login writes the default
    roles). Signed in: logo, username, tier badge, balance + current plan (from the usage snapshot, no
    second fetch), connection status (连接正常 / 数据可能已过期 / 密钥已失效), the registered providers
    (`cgs-claude` / `cgs-antigravity` / `cgs-codex` / `cgs-openai`, with model counts) and the buttons 「打开 CGS 后台」 (system browser,
    `<baseUrl>/dashboard`; the opened URL is logged as `[cgs] openExternal …`), 「客户端管理」 (`<baseUrl>/clients`),
    「刷新」 and 「退出账户」. When the server rejects the credential (401) the card shows 「密钥已失效」 with 「重新登录」 and 「退出账户」.
    IPC: `cgs:refresh-account`, `cgs:open-console` (page `dashboard` | `clients`), `cgs:logout` (`cgsDesktop.refreshAccount / openConsole / logout`).
  - **退出账户** (after an in-page confirmation): `CgsController.logout()` stops the polling, waits for requests in flight,
    calls `POST <baseUrl>/api/device/logout` with the client credential (200 revoked, 401 already revoked; a network error or 5xx
    only shows the toast 「已在本机退出，但服务器端密钥未能吊销，可在 CGS 后台删除」), then cleans up locally
    (`signOutLocally` in `src/cgs/config-writer.js`): deletes `<agentDir>/cgs/credentials.json`, removes
    `providers.cgs-*` from `models.yml`, removes from `config.yml` only the default-role keys that still point at `cgs-*`
    models (`modelRoles.default/task/web/smol`, `task.agentModelOverrides.reviewer/scout`, the `cgs-*` entries of
    `retry.fallbackChains.web`; values the user changed stay) and resets `state.json` (`defaultsApplied`, `lastKnownTier`) so the
    next login writes the default roles again. models.yml's mtime is bumped, which makes ompweb drop its model cache and restart its utility omp (the same
    path as after login; already running sessions keep their providers). The sidebar row and Usage card
    disappear, and ompweb's provider-usage widget and omp logo return. The login popup on the
    next launch follows the usual rule (only when no credentials of any kind are saved).
- Branding is CGS everywhere, signed in or not (`assets/`, regenerate with `npm run icons`, which rasterizes via Electron):
  `cgs-logo.svg` (from `~/new-api/web/public/logo.svg`) is the in-app brand logo, the login popup logo and the source of
  `icon.png` / `icon.ico` (exe, installer, AppImage, window and taskbar icon). The loading screen inlines the same logo.
  Title: `scripts/ompweb-compile.ts` rewrites the page title (which ompweb also uses as its app name) in the *built copy* of
  ompweb's `index.html` to "CGS Desktop" (the build fails if ompweb's title changes; the checkout stays untouched), and the
  preload swaps ompweb's mark and wordmark for the CGS logo, "CGS" in the sidebar header and "CGS Desktop" on the welcome
  screen. `buildOmpweb` records a hash of that script in `manifest.json`, so editing it rebuilds ompweb.
- `src/cgs/`, `src/login/`, `plugin/omp-cgs/`: CGS device-link login (popup supports light and dark), config writer, tier
  polling and the omp provider extension.

## Client credential and channels

- **A signed-in desktop is a *client*, not an API key.** Approving the device link registers a client on the server (dashboard
  → 「客户端」), and the poll returns its credential (`cgc_…`, `client_secret`) exactly once. It is stored as `clientSecret` in
  `<agentDir>/cgs/credentials.json` (0600; a record from earlier versions holding an `apiKey` counts as signed out). The
  client carries no quota of its own (requests bill the owning user), does not count against the API-key limit and has its own
  dashboard page showing device name, GeoIP location (from the connection address), OS version and client version. The OS and
  app version are sent at login (`platform`, `app_version`) and refreshed on every tier/usage request via `X-Client-OS` /
  `X-Client-Version` (`src/cgs/client-info.js`).
- **Four channels, only URL and credential differ.** `plugin/omp-cgs/index.js` registers one provider per omp transport, so
  each vendor's models keep that vendor's own client behaviour (wire format, fingerprint headers, tool-call style):

  | provider | omp `api` | URL the transport posts to | models |
  |---|---|---|---|
  | `cgs-claude` (Claude Code) | `anthropic-messages` | `<base>/v1/messages` | `claude-*` |
  | `cgs-antigravity` | `google-gemini-cli` | `<base>/v1internal:streamGenerateContent` | `gemini-*` |
  | `cgs-codex` | `openai-codex-responses` | `<base>/v1/codex/responses` | `gpt-*`, `o*`, `codex*`, `*astra*` |
  | `cgs-openai` (OpenAI-compatible) | `openai-completions` | `<base>/v1/chat/completions` | everything else |

  All four send the client credential as `Authorization: Bearer`; the Antigravity channel's `apiKey` is omp's JSON form
  `{"token": <credential>, "projectId": "cgs"}`.
- **Default roles** (written once at the first login, `DEFAULT_ROLES` in `src/cgs/config-writer.js`; edit freely afterwards in
  ompweb's AI model defaults or `config.yml`, later logins never overwrite them): search `cgs-antigravity/gemini-3.8-flash`
  (also the only entry of `retry.fallbackChains.web`), main agent `cgs-claude/claude-haiku-5-5`, task
  `cgs-openai/deepseek-v4.1-flash`, reviewer `cgs-codex/gpt-6-astra`, scout `cgs-claude/claude-haiku-5-5`. The old per-tier
  presets and the tier-change bubble are gone; the tier is only displayed.
- **Tool style per vendor** comes from omp's own `edit.modelVariants` (model-selector substring → edit mode), seeded on first
  run when absent: `claude → replace` (exact string replacement, Claude Code style), `gpt → apply_patch` (Codex style);
  other models keep omp's default. It is per model, so a user can set it per channel or per model in `config.yml`.
- **Balance and real prices in yuan.** `GET /api/device/usage` returns `balance.cny` / `cny_display` (wallet in ¥ at the site's
  `USDExchangeRate`, whatever the site's display type), shown by omp's usage view as a 「余额 (CNY)」 entry (omp's usage units
  have no CNY, so it is carried in `remaining` and the notes; a pay-as-you-go account with no subscription still gets a report).
  `GET /api/device/pricing` returns the user's real per-model prices (¥ per million tokens: input, output, cache read/write after
  the group ratio, `per_call` for per-request models). The plugin fetches it once at start (8 s timeout, best effort) and fills
  each model's `cost` with it; models the site does not price keep the catalog cost. omp prints its own `$` glyph before cost
  numbers, but the numbers are yuan.
- **Email registration** (the login popup's 「使用邮箱注册」): the app registers with email + password without a browser, through
  its own endpoints (`src/cgs/register-flow.js`, server `/api/device/register/*`, not the console's registration). Every code
  mail costs a proof of work like the login does (a resend solves a new one); the server mails a 6-digit code (60 s between
  mails per address, 5 wrong codes per registration), and entering it creates the account and returns the client credential,
  so the app is signed in at once. The password stays in the main process between the form and the code screen. A server
  without a mail provider writes the code to its log instead (`[desktop-register] … verification code for <email>: <code>`).
  Every build signs in through CGS: there is no third-party login, and closing the login popup unsigned quits the app.
