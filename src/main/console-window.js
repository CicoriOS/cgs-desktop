"use strict";
// The CGS web console (「打开 CGS 后台」/「客户端管理」) in an app window. Its session sends every request for the CGS
// origin to the agent, so the console works whenever the app does, relay included; other origins (OAuth providers,
// CDNs of the page) load normally.

const { BrowserWindow, session, net, shell } = require("electron");
const http = require("node:http");
const { Readable } = require("node:stream");

const PARTITION = "persist:cgs-console";
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer"]);

let consoleWindow = null;
let configuredFor = null;

/** One request to `origin`, forwarded over the agent socket; resolves a fetch Response. */
function forward(request, socketPath) {
  const url = new URL(request.url);
  return new Promise((resolve, reject) => {
    const headers = {};
    for (const [k, v] of request.headers) if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
    headers.host = url.host;
    const req = http.request({ socketPath, method: request.method, path: url.pathname + url.search, headers }, (res) => {
      const out = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (HOP_BY_HOP.has(k)) continue;
        for (const value of Array.isArray(v) ? v : [v]) out.append(k, value);
      }
      const empty = res.statusCode === 204 || res.statusCode === 304 || request.method === "HEAD";
      resolve(new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, statusText: res.statusMessage, headers: out }));
    });
    req.on("error", reject);
    if (request.body) Readable.fromWeb(request.body).pipe(req);
    else req.end();
  });
}

function consoleSession(origin, socketPath) {
  const ses = session.fromPartition(PARTITION);
  if (configuredFor !== origin) {
    if (configuredFor) ses.protocol.unhandle("https");
    ses.protocol.handle("https", (request) =>
      new URL(request.url).origin === origin ? forward(request, socketPath) : net.fetch(request, { bypassCustomProtocolHandlers: true }),
    );
    configuredFor = origin;
  }
  return ses;
}

/** Opens (or focuses and navigates) the console window at `url`. */
function openConsoleWindow({ url, socketPath, icon }) {
  const origin = new URL(url).origin;
  if (consoleWindow && !consoleWindow.isDestroyed()) {
    consoleWindow.loadURL(url);
    consoleWindow.focus();
    return consoleWindow;
  }
  consoleWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    icon,
    title: "CGS",
    autoHideMenuBar: true,
    webPreferences: { session: consoleSession(origin, socketPath), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const contents = consoleWindow.webContents;
  // Links to other sites open in the system browser; the console itself stays in this window.
  contents.setWindowOpenHandler(({ url: target }) => {
    try {
      if (new URL(target).origin === origin) return { action: "allow" };
      const { protocol } = new URL(target);
      if (protocol === "https:" || protocol === "http:" || protocol === "mailto:") shell.openExternal(target);
    } catch {
      // malformed: ignore
    }
    return { action: "deny" };
  });
  consoleWindow.on("closed", () => {
    consoleWindow = null;
  });
  consoleWindow.loadURL(url);
  return consoleWindow;
}

module.exports = { openConsoleWindow };
