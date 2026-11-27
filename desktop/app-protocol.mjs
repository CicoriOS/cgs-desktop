// The packaged page's transport (ADR 0046 §1): a standard, secure `cgs://` scheme over the built `dist/` instead of
// `file://`. Chromium refuses ES modules from `file://` (origin null), and the SPA is module code; a standard scheme also
// gives the page a real origin for its own origin checks.
import fs from "node:fs/promises";
import path from "node:path";

export const APP_SCHEME = "cgs";
/** The page a packaged app loads. The dev shell keeps its Vite URL from `CGS_DEV_URL`. */
export const APP_URL = `${APP_SCHEME}://app/index.html`;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

/** Must run before `app.whenReady()` (Electron's scheme registration window). */
export function registerAppScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  ]);
}

/** Serves `root` under `cgs://app/`; only paths inside `root` are read. */
export function handleAppRequests({ protocol, root }) {
  const base = path.resolve(root);
  protocol.handle(APP_SCHEME, async (request) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    const target = path.normalize(path.join(base, pathname));
    if (target !== base && !target.startsWith(`${base}${path.sep}`)) return new Response("not found", { status: 404 });
    try {
      const data = await fs.readFile(target);
      return new Response(data, { headers: { "content-type": TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}
