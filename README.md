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

