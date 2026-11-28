// End-to-end run of CGS Desktop as a real desktop agent (ADR 0046/0047, cgsconnect/local-channel.md): the Electron main
// process from desktop/, the real sidecar (`cgs __cgs_worker_module` from a patched omp source tree), the shared daemon
// unit, a real `omp --mode rpc-ui` child and a fake CGS server (test/e2e/fake-cgs.mjs). Every numbered check of the task
// is one `runItem`; screenshots go to /tmp/e2e-*.png and the summary is printed at the end.
//
// Usage:
//   bun run build:desktop
//   xvfb-run -a electron test/e2e/main.mjs --no-sandbox          (or: bun run e2e:desktop)
//
// Isolation: HOME, XDG_*, PI_* and CGS_DAEMON_DIR are fresh temp dirs; the real ~/.cgs is never touched. The sidecar is
// the CGS_SIDECAR override (patched omp + the cgscli sidecar). The omp children need the CGS extension, which the release
// launcher seeds into <agentDir>/config.yml; this driver writes the same two entries before the sidecar starts. Override
// the paths with E2E_BUN / E2E_OMP_CLI / E2E_SIDECAR / E2E_EXTENSION.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, protocol } from "electron";
import { APP_URL, handleAppRequests, registerAppScheme } from "../../desktop/app-protocol.mjs";
import { shutdownLocalHost, startLocalHost } from "../../desktop/host-ipc.mjs";
import { registerWorkspaceIpc } from "../../desktop/workspace.mjs";
import { startFakeCgs } from "./fake-cgs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const bun = process.env.E2E_BUN?.trim() || "/mnt/workspace/dev/bun/bin/bun";
const ompCli = process.env.E2E_OMP_CLI?.trim() || "/tmp/p19/packages/coding-agent/src/cli.ts";
const sidecarPath = process.env.E2E_SIDECAR?.trim() || "/mnt/workspace/cgscli/packages/connect/src/desktop/sidecar.ts";
const extensionPath = process.env.E2E_EXTENSION?.trim() || "/mnt/workspace/cgscli/plugin/omp-extension/index.ts";
const distRoot = path.join(root, "dist");

// ---- isolation (before Electron, the sidecar or the daemon look at any path) -----------------------------------------
const home = fs.mkdtempSync(path.join(os.tmpdir(), "cgs-e2e-home-"));
const agentDir = path.join(home, ".cgs", "agent");
const daemonDir = path.join(home, "daemon");
const repo = path.join(home, "repo");
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) delete process.env[key];
Object.assign(process.env, {
  HOME: home,
  CGS_DAEMON_DIR: daemonDir,
  PI_CONFIG_DIR: ".cgs",
  PI_CODING_AGENT_DIR: agentDir,
  XDG_DATA_HOME: path.join(home, "xdg-data"),
  XDG_CONFIG_HOME: path.join(home, "xdg-config"),
  XDG_CACHE_HOME: path.join(home, "xdg-cache"),
  CGS_CLOUDFLARE: "0",
  CGS_SIDECAR: JSON.stringify([bun, ompCli, "__cgs_worker_module", sidecarPath]),
});
app.disableHardwareAcceleration();
app.setPath("userData", path.join(home, "userdata"));
registerAppScheme(protocol);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const started = Date.now();
const log = (...args) => console.log(`[e2e +${((Date.now() - started) / 1000).toFixed(1)}s]`, ...args);
const results = [];
const screenshots = [];
let fake;
let second;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(check, timeout, label) {
  const begin = Date.now();
  let last;
  while (Date.now() - begin < timeout) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(100);
  }
  throw new Error(`timed out after ${timeout}ms: ${label}${last ? ` (${last instanceof Error ? last.message : last})` : ""}`);
}

async function runItem(number, title, fn) {
  try {
    await fn();
    results.push({ number, title, ok: true });
    log(`PASS ${number}. ${title}`);
  } catch (error) {
    results.push({ number, title, ok: false, error });
    log(`FAIL ${number}. ${title}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}

// ---- the page --------------------------------------------------------------------------------------------------------
let win;

async function shot(name) {
  const file = `/tmp/e2e-${name}.png`;
  const image = await win.webContents.capturePage();
  fs.writeFileSync(file, image.toPNG());
  screenshots.push(file);
  log(`screenshot ${file}`);
  return file;
}

const page = (expression) => win.webContents.executeJavaScript(expression);
const sel = (selector) => JSON.stringify(selector);
const waitPage = (expression, timeout, label) => waitFor(() => page(expression), timeout, label ?? expression);
const bodyText = () => page("document.body.innerText");

async function click(selector) {
  const clicked = await page(`(() => { const el = document.querySelector(${sel(selector)}); if (!el) return false; el.click(); return true; })()`);
  if (!clicked) throw new Error(`no element for ${selector}`);
}

/** Clicks the first element matching the selector whose text matches the regex (for i18n labels). */
async function clickByText(selector, source) {
  const clicked = await page(`(() => {
    const re = new RegExp(${JSON.stringify(source)});
    const el = [...document.querySelectorAll(${sel(selector)})].find((node) => re.test(node.textContent || ""));
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`no ${selector} matching ${source}`);
}

/** React's value tracker ignores a plain assignment; the native setter plus an input event is a real edit. */
async function typeInto(selector, text) {
  const planted = await page(`(() => {
    const el = document.querySelector(${sel(selector)});
    if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.focus();
    return true;
  })()`);
  if (!planted) throw new Error(`no input for ${selector}`);
}

async function press(selector, key) {
  const pressed = await page(`(() => {
    const el = document.querySelector(${sel(selector)});
    if (!el) return false;
    el.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
    return true;
  })()`);
  if (!pressed) throw new Error(`no element for ${selector}`);
}

const hostCall = (method, params) =>
  page(`window.cgsDesktop.host.call(${JSON.stringify(method)}${params === undefined ? "" : `, ${JSON.stringify(params)}`})`);

/** One raw mux host request from the window (GET, or POST when a body is given). */
async function hostRequest(pathname, body) {
  return page(`new Promise((resolve, reject) => {
    const id = "e2e-" + Math.random().toString(36).slice(2);
    const off = window.cgsDesktop.host.onMessage((m) => {
      if (m.type === "res" && m.id === id) { off(); clearTimeout(timer); resolve({ status: m.status, body: m.body }); }
    });
    const timer = setTimeout(() => { off(); reject(new Error("timeout")); }, 15000);
    const message = { type: "req", id, path: ${JSON.stringify(pathname)} };
    ${body === undefined ? "" : `message.body = ${JSON.stringify(body)};`}
    if (!window.cgsDesktop.host.send(message)) { off(); clearTimeout(timer); reject(new Error("link_not_ready")); }
  })`);
}

/** Sends one RPC frame on a child stream and resolves the response with the same id (null after the timeout). */
async function sendFrame(childId, frame, timeout = 8000) {
  return page(`new Promise((resolve) => {
    const cid = ${JSON.stringify(childId)};
    const wanted = ${JSON.stringify(frame.id)};
    const text = ${JSON.stringify(JSON.stringify(frame))};
    const off = window.cgsDesktop.host.onMessage((m) => {
      if (m.type !== "frame" || m.cid !== cid) return;
      let f; try { f = JSON.parse(m.text); } catch { return; }
      if (f.type === "response" && f.id === wanted) { off(); clearTimeout(timer); resolve(f); }
    });
    const timer = setTimeout(() => { off(); resolve(null); }, ${timeout});
    if (!window.cgsDesktop.host.send({ type: "frame", cid, text })) { off(); clearTimeout(timer); resolve(null); }
  })`);
}

/** Collects `cgs_control` frames the window receives, for the control item's evidence. */
async function watchControlFrames() {
  await page(`window.__e2eControls = []; window.__e2eControlsOff = window.cgsDesktop.host.onMessage((m) => {
    if (m.type !== "frame") return;
    try { const f = JSON.parse(m.text); if (f.type === "cgs_control") window.__e2eControls.push(f); } catch {}
  }); true`);
}
const controlFrames = () => page("window.__e2eControls ?? []");

function createWindow() {
  const browser = new BrowserWindow({
    width: 1360,
    height: 880,
    show: true,
    frame: false,
    webPreferences: {
      preload: path.join(root, "desktop", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      additionalArguments: ["--cgs-system-locale=en"],
    },
  });
  browser.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) console.error(`renderer: ${message}`);
  });
  browser.webContents.on("did-fail-load", (_event, code, description) => console.error(`load failed: ${code} ${description}`));
  // The login gate calls window.open on the verification URL. A real browser would show the approval page; the fake
  // server approves on that GET, so fetching it here *is* the user's browser step.
  browser.webContents.setWindowOpenHandler(({ url }) => {
    void (async () => {
      try {
        const response = await fetch(url);
        log(`login: opened verification URL ${url} -> HTTP ${response.status}`);
      } catch (error) {
        log(`login: opening the verification URL failed: ${error instanceof Error ? error.message : error}`);
      }
    })();
    return { action: "deny" };
  });
  browser.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== new URL(APP_URL).origin) event.preventDefault();
  });
  void browser.loadURL(APP_URL);
  return browser;
}

// ---- processes -------------------------------------------------------------------------------------------------------
/** Every live process whose command line and environment match. Bounded to /proc, and the needles are unique to this run. */
function findProcesses({ cmdNeedle, envNeedle, ppid }) {
  const found = [];
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      if (cmdNeedle && !cmd.includes(cmdNeedle)) continue;
      if (ppid !== undefined) {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        if (parent !== ppid) continue;
      }
      if (envNeedle) {
        let environ = "";
        try {
          environ = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
        } catch {
          continue;
        }
        if (!environ.includes(envNeedle)) continue;
      }
      found.push({ pid, cmd });
    } catch {
      /* gone between readdir and read */
    }
  }
  return found;
}

function killPid(pid, signal = "SIGKILL") {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** The omp children of our daemon unit: `--mode rpc-ui` with this run's agent dir in the environment. */
const rpcChildren = () => findProcesses({ cmdNeedle: "--mode rpc-ui", envNeedle: `PI_CODING_AGENT_DIR=${agentDir}` });

/**
 * A second local channel on the same unit (local-channel.md sections 3-4): another real sidecar process, spoken to over
 * the same JSONL stdio protocol the Electron main process uses. It opens the same child and takes control through the
 * Host route; this is the "tiny script speaking the local channel protocol" the control check needs, with the protocol's
 * real implementation on both sides.
 */
class SecondClient {
  constructor() {
    this.lines = [];
    this.waits = new Set();
    this.stderr = "";
    this.buffer = "";
    this.child = spawn(bun, [ompCli, "__cgs_worker_module", sidecarPath], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      for (let i = this.buffer.indexOf("\n"); i >= 0; i = this.buffer.indexOf("\n")) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        if (!line.trim()) continue;
        try {
          this.lines.push(JSON.parse(line));
        } catch {
          /* not a protocol line */
        }
        for (const waiter of [...this.waits]) waiter();
      }
    });
    this.child.stderr.on("data", (chunk) => (this.stderr += chunk));
    this.exited = new Promise((resolve) => this.child.once("close", resolve));
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async waitFor(predicate, timeout, label) {
    const begin = Date.now();
    while (Date.now() - begin < timeout) {
      const hit = this.lines.find(predicate);
      if (hit) return hit;
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waits.delete(done);
          resolve();
        };
        const timer = setTimeout(done, 50);
        this.waits.add(done);
      });
    }
    throw new Error(`second client: timed out waiting for ${label}; lines: ${this.lines.map((m) => m.type).join(",")}; stderr: ${this.stderr.slice(-400)}`);
  }

  async controlState(wanted, timeout, label) {
    return this.waitFor(
      (m) => {
        if (m.type !== "frame" || m.cid !== "second") return false;
        try {
          const f = JSON.parse(m.text);
          return f.type === "cgs_control" && f.you === wanted;
        } catch {
          return false;
        }
      },
      timeout,
      label,
    );
  }

  async shutdown() {
    try {
      this.send({ type: "shutdown" });
      this.child.stdin.end();
    } catch {
      /* already gone */
    }
    const gone = await Promise.race([this.exited, sleep(8000).then(() => "timeout")]);
    if (gone === "timeout") killPid(this.child.pid);
    await this.exited.catch(() => {});
  }
}

// ---- fixtures --------------------------------------------------------------------------------------------------------
function makeRepo() {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# e2e workspace\n\nA temporary git repository.\n");
  fs.writeFileSync(path.join(repo, "src.txt"), "first line\n");
  const git = (...args) => execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.test", ...args], { cwd: repo, env: process.env });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
}

/** The first `.jsonl` under <agentDir>/sessions whose text contains `needle`. */
function findSession(needle) {
  const base = path.join(agentDir, "sessions");
  const stack = [base];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(".jsonl")) {
        try {
          if (fs.readFileSync(full, "utf8").includes(needle)) return full;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return undefined;
}

function seedAgentDir() {
  fs.mkdirSync(agentDir, { recursive: true });
  // What scripts/release-launcher.ts seeds: the omp children load the CGS extension from the agent dir's config, and the
  // default model is the fake server's (the cloud layout would write the same selector).
  fs.writeFileSync(
    path.join(agentDir, "config.yml"),
    `# seeded for the e2e run\nextensions:\n  - ${JSON.stringify(extensionPath)}\nmodelRoles:\n  default: ${fake.defaultSelector}\n`,
  );
}

// ---- items -----------------------------------------------------------------------------------------------------------
let childId;
let sessionPath;

async function item1() {
  await runItem(1, "signed-out start, browser login through the gate, account footer and configured unit", async () => {
    await waitPage(`document.querySelector('[data-host-state="signed-out"]') !== null`, 30000, "login gate");
    await shot("01-login-gate");
    const state = await hostCall("state");
    assert(state.phase === "signed-out", `sidecar state is ${state.phase}, expected signed-out`);
    assert((await bodyText()).includes("CGS Desktop"), "the gate does not show the shell brand");

    await click(".login-btn.primary");
    await waitFor(
      async () => (await page(`document.querySelector('.login-btn.primary.compact') !== null`)) || (await page(`document.querySelector('#sidebar') !== null`)),
      20000,
      "waiting screen or main UI",
    );
    if (await page(`document.querySelector('.login-btn.primary.compact') !== null`)) await shot("02-login-waiting");
    await waitFor(() => fake.state.device.opened, 20000, "the page opened the verification URL");
    await waitPage(`document.querySelector('#sidebar') !== null`, 40000, "main UI after login");
    log(`login: server saw ${JSON.stringify(fake.state.device)}, request log ${JSON.stringify(fake.requests.slice(0, 12))}`);
    assert(fake.state.device.approved, "the device flow never reached approved");
    assert(fake.state.device.openedAt > 0 && fake.state.device.approvedAt >= fake.state.device.openedAt, "approval did not follow the opened URL");
    assert(fake.state.device.polls >= 1, "the sidecar never polled the device session");

    await waitPage(`document.querySelector('#usage .usage-badge')?.textContent === "Pro"`, 30000, "account badge Pro");
    const account = await page(`({
      badge: document.querySelector('#usage .usage-badge')?.textContent,
      plan: document.querySelector('#usage .usage-plan')?.textContent,
      balance: document.querySelector('#usage .usage-balance .usage-value')?.textContent,
      user: document.querySelector('#account .name, #account-name, .account-name')?.textContent ?? ""
    })`);
    log(`account footer: ${JSON.stringify(account)}`);
    assert(account.balance === "$199.99", `balance is ${account.balance}, expected $199.99 from the fake usage endpoint`);
    assert(account.plan === "Pro Max", `plan is ${account.plan}, expected Pro Max`);
    const snapshot = await hostCall("account.snapshot");
    assert(snapshot?.username === "alice" && snapshot?.tier === "pro", `snapshot ${JSON.stringify(snapshot)}`);
    assert((await hostCall("state")).phase === "ready", "the sidecar is not ready after login");

    // The unit is configured: its host answers, and its account poller asked the fake server for tier and usage.
    const children = await hostRequest("/api/children");
    assert(children.status === 200, `/api/children answered ${children.status}`);
    await waitFor(() => fake.requests.includes("GET /api/device/tier") && fake.requests.includes("GET /api/device/usage"), 15000, "unit account polls");
    await shot("03-main-account");
  });
}

async function item2() {
  await runItem(2, "workspace via the UI, new conversation, streamed fake-model reply, sidebar ring, session file", async () => {
    await click("#new-ws");
    await waitPage(`document.querySelector('#ws-dialog input') !== null`, 10000, "workspace dialog");
    await typeInto("#ws-dialog input", repo);
    // The suggestion list is computed from the React state, so it is the proof the state (not just the DOM) moved before
    // Enter; it lists the directory itself once the typed path exists (`store.complete` only suggests directories).
    await waitFor(async () => ((await page(`document.querySelector('#ws-dialog input')?.value`)) === repo && (await page(`document.querySelector('#ws-list')?.innerText`))?.includes(repo)), 10000, "dialog suggests the typed directory");
    await press("#ws-dialog input", "Enter");
    await waitPage(`document.querySelector('#ws-dialog') === null`, 15000, "dialog closed");
    try {
      await waitFor(async () => {
        const response = await hostRequest("/api/children");
        return response.body?.children?.some((child) => child.cwd === repo);
      }, 30000, "child in the temporary workspace");
    } catch (error) {
      log(`no child yet; page text: ${JSON.stringify((await bodyText()).slice(-600))}`);
      const children = await hostRequest("/api/children").catch((failure) => ({ error: String(failure) }));
      log(`/api/children: ${JSON.stringify(children)}`);
      throw error;
    }
    log(`workspace: request log now ${JSON.stringify(fake.requests.filter((r) => r.includes("/api/")))}`);

    const prompt = "Describe the workspace in one short line.";
    await typeInto("#main textarea", prompt);
    await waitPage(`document.querySelector('#send') && !document.querySelector('#send').disabled`, 10000, "send enabled");
    await click("#send");

    // The ring is the status signal (ADR 0030): work while the model runs, idle once it settled.
    await waitPage(`document.querySelector('[data-s="work"]') !== null`, 15000, "work ring");
    // Streamed, not one blob: the reply text is visible while the run is still going.
    const partial = await waitFor(async () => {
      const text = await bodyText();
      return text.includes("FAKE-REPLY-ONE") ? text : undefined;
    }, 20000, "streamed reply prefix");
    assert(partial.includes("FAKE-REPLY-ONE"), "the transcript never showed the streamed reply");
    const ringWhere = await page(`({
      sidebar: !!document.querySelector('.sess.active [data-s="work"]'),
      composer: !!document.querySelector('#main [data-s="work"]'),
    })`);
    log(`ring during stream: ${JSON.stringify(ringWhere)}`);
    assert(ringWhere.sidebar && ringWhere.composer, "the reply appeared without the work rings; it may not have streamed");
    await shot("04-prompt-work");
    await waitFor(async () => !(await page(`document.querySelector('[data-s="work"]') !== null`)), 60000, "work ring gone");
    await shot("05-prompt-done");
    const done = await bodyText();
    assert(done.includes("FAKE-REPLY-ONE The temporary workspace is ready."), "the final reply text is missing from the transcript");
    assert(await page(`document.querySelector('[data-s="work"]') === null`), "a work ring is still present after the run");

    sessionPath = await waitFor(() => findSession("FAKE-REPLY-ONE"), 20000, "session file with the reply");
    log(`session file: ${sessionPath}`);
    assert(sessionPath.startsWith(path.join(agentDir, "sessions")), `session file ${sessionPath} is outside the agent dir`);
    assert(fs.readFileSync(sessionPath, "utf8").includes(prompt), "the session file does not contain the prompt");

    const chat = fake.state.chat.filter((entry) => entry.prompt.includes(prompt));
    assert(chat.length >= 1, "the fake provider never received the prompt");
    assert(chat.some((entry) => entry.authorized), "the provider request did not carry the client credential");
    assert(chat.some((entry) => entry.tools > 0), "the model request was not an agent request (no tools)");
    log(`provider request: stream=${chat[0].stream} tools=${chat[0].tools} authorized=${chat[0].authorized}`);

    // The conversation is listed, with the active row and an idle ring (only the age text remains).
    await waitPage(`document.querySelector('.sess.active') !== null`, 20000, "active session row");
    const row = await page(`(() => { const el = document.querySelector('.sess.active'); return el ? { text: el.innerText, ring: !!el.querySelector('.ring'), age: !!el.querySelector('.age') } : null; })()`);
    log(`sidebar row after the turn: ${JSON.stringify(row)}`);
    assert(row && !row.ring, "the active session row kept a ring after the run (expected idle)");

    const sessions = await hostRequest("/api/sessions");
    const listed = sessions.body?.workspaces?.find((w) => w.cwd === repo)?.sessions ?? [];
    assert(listed.some((s) => s.path === sessionPath), `the session is not listed in /api/sessions: ${JSON.stringify(listed.map((s) => s.path))}`);
  });
}

async function item3() {
  await runItem(3, "WorkspaceApi in the right panel: file list and git status after an edit", async () => {
    // The right toggle is the last direct icon button of the title bar.
    await page(`(() => { const buttons = [...document.querySelectorAll('#topbar > button.icon')]; buttons.at(-1)?.click(); return true; })()`);
    await waitPage(`document.querySelector('#right') !== null`, 10000, "right panel");
    await click(".right-tab:nth-child(3)");
    await waitPage(`document.querySelector('#right .tree') !== null`, 15000, "file tree");
    await waitFor(async () => (await page(`document.querySelector('#right')?.innerText`))?.includes("README.md"), 15000, "README.md in the file tree");
    const listing = await page(`window.cgsDesktop.workspace.list(${JSON.stringify(repo)}, ".")`);
    log(`WorkspaceApi list: ${JSON.stringify(listing).slice(0, 300)}`);
    assert(Array.isArray(listing) && listing.some((entry) => entry.name === "README.md"), "WorkspaceApi.list did not return README.md");
    const clean = await page(`window.cgsDesktop.workspace.gitStatus(${JSON.stringify(repo)})`);
    assert(clean && Array.isArray(clean.files) && clean.files.length === 0, `gitStatus before the edit: ${JSON.stringify(clean)}`);
    await shot("06-workspace-files");

    fs.appendFileSync(path.join(repo, "README.md"), "changed by the e2e run\n");
    const status = await waitFor(async () => {
      const value = await page(`window.cgsDesktop.workspace.gitStatus(${JSON.stringify(repo)})`);
      const readme = path.join(repo, "README.md");
      return value?.files?.some((file) => file.path === readme) ? value : undefined;
    }, 15000, "gitStatus sees the edit");
    log(`WorkspaceApi gitStatus after the edit: ${JSON.stringify(status)}`);

    await click(".right-tab:nth-child(2)");
    await waitFor(async () => {
      const right = await page(`document.querySelector('#right')?.innerText`);
      return right?.includes("README.md") ? right : undefined;
    }, 20000, "Git tab shows README.md changed");
    // Wait for the watcher to render the modified marker, with one manual refresh as a fallback (the panel has one too).
    try {
      await waitPage(`document.querySelector('#right .stat-letter[data-kind="modified"]') !== null`, 10000, "modified marker");
    } catch {
      await clickByText("#right .right-tabs button", "Refresh|刷新");
      await waitPage(`document.querySelector('#right .stat-letter[data-kind="modified"]') !== null`, 10000, "modified marker after refresh");
    }
    const changed = await page(`(() => [...document.querySelectorAll('#right .git-file')].map((row) => ({ name: row.querySelector('.chg-name')?.textContent, kind: row.querySelector('.stat-letter')?.dataset.kind })))()`);
    log(`Git tab rows: ${JSON.stringify(changed)}`);
    assert(changed.some((row) => row.name === "README.md" && row.kind === "modified"), "the Git tab does not show README.md as modified");
    await shot("07-workspace-git");
  });
}

async function item4() {
  await runItem(4, "control (ADR 0047): a second local channel takes the conversation, the red lock appears, a click takes it back, non-controller writes are dropped", async () => {
    const children = await hostRequest("/api/children");
    childId = children.body?.children?.[0]?.id;
    assert(childId, `no child to control: ${JSON.stringify(children.body)}`);
    await watchControlFrames();

    second = new SecondClient();
    try {
    await second.waitFor((m) => m.type === "hello", 20000, "second sidecar hello");
    second.send({ type: "open", cid: "second", path: `/ws?child=${encodeURIComponent(childId)}` });
    await second.waitFor((m) => m.type === "ready" && m.cid === "second", 20000, "second stream ready");
    await second.controlState(false, 10000, "second stream is a viewer (the window opened first)");
    log("control: second channel attached as viewer");

    // The control route is a Host request on the local channel: `req` with a body means POST (LocalChannel's rule).
    second.send({ type: "req", id: "second-take", path: `/api/children/${encodeURIComponent(childId)}/control`, body: { take: true } });
    const control = await second.waitFor((m) => m.type === "res" && m.id === "second-take", 15000, "control route answer");
    log(`control route: ${JSON.stringify(control)}`);
    assert(control.status === 200 && control.body?.controller, `control route answered ${control.status} ${JSON.stringify(control.body)}`);
    await second.controlState(true, 10000, "second channel is the controller");

    await waitPage(`document.querySelector('.control-lock') !== null`, 15000, "red lock overlay");
    const lockText = await page(`document.querySelector('.control-lock')?.innerText`);
    log(`lock overlay: ${JSON.stringify(lockText)}`);
    assert(/using this conversation|take over|接管/i.test(lockText ?? ""), `unexpected lock text: ${lockText}`);
    await shot("08-control-lock");

    // Host enforcement: a write frame from the viewer side never reaches omp; its id gets a refusal.
    const refusal = await sendFrame(childId, { type: "set_session_name", name: "must-not-apply", id: "e2e-denied-write" });
    log(`dropped write: ${JSON.stringify(refusal)}`);
    assert(refusal && refusal.success === false && /controlled by another client/i.test(String(refusal.error)), "the host did not refuse the non-controller write");
    const controls = await controlFrames();
    const latest = controls.at(-1);
    log(`window control frames: ${JSON.stringify(controls.slice(-2))}`);
    assert(latest && latest.you === false, "the window was not told it is a viewer");

    // Clicking the lock is the takeover gesture.
    await click(".control-lock");
    await waitPage(`document.querySelector('.control-lock') === null`, 15000, "lock overlay gone after the click");
    await second.controlState(false, 10000, "second channel demoted after the click");
    const after = await controlFrames();
    assert(after.some((frame) => frame.you === true), "the window was not told it controls the conversation again");
    // A write now goes through (the name is set, not refused).
    const accepted = await sendFrame(childId, { type: "set_session_name", name: "e2e conversation", id: "e2e-allowed-write" });
    log(`write after takeover: ${JSON.stringify(accepted)}`);
    assert(accepted && accepted.success !== false, "the controller's write was refused");
    await shot("09-control-restored");
    } finally {
      // Whatever failed, the second channel must not keep the window locked for the next items.
      if (second) {
        await second.shutdown().catch(() => {});
        second = undefined;
      }
      if (await page(`document.querySelector('.control-lock') !== null`)) {
        await click(".control-lock").catch(() => {});
        await waitFor(async () => !(await page(`document.querySelector('.control-lock') !== null`)), 10000, "lock gone after cleanup").catch(() => {});
      }
    }
  });
}

async function item5() {
  await runItem(5, "reload mid-run reattaches the stream; settings read device/usage/agents; sign-out returns to the gate with the unit unconfigured", async () => {
    await waitFor(async () => !(await page(`document.querySelector('.control-lock') !== null`)), 10000, "composer unlocked before the second prompt");
    const prompt = "SECOND-PROMPT: keep streaming while the window reloads.";
    await typeInto("#main textarea", prompt);
    await waitPage(`document.querySelector('#send') && !document.querySelector('#send').disabled`, 10000, "send enabled for the second prompt");
    await click("#send");
    await waitPage(`document.querySelector('.sess.active [data-s="work"]') !== null`, 15000, "sidebar ring work on the established session");
    await waitFor(async () => (await bodyText()).includes("FAKE-REPLY-TWO"), 20000, "second reply started");
    log("reload: stream is running, reloading the window now");
    // A marker from this document: after the reload it must be gone, so the checks below cannot pass on the old page.
    await page("window.__e2eBeforeReload = true");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 15000);
      win.webContents.once("did-finish-load", () => {
        clearTimeout(timer);
        resolve();
      });
      win.webContents.reload();
    });
    await waitFor(async () => (await page("window.__e2eBeforeReload === undefined")), 15000, "the reload replaced the document");
    await waitPage(`document.querySelector('#sidebar') !== null`, 30000, "app after the reload");
    await waitPage(`document.querySelector('.sess.active [data-s="work"]') !== null`, 20000, "the running stream is attached again (work ring)");
    await waitFor(async () => (await bodyText()).includes("FAKE-REPLY-TWO"), 20000, "stream reattached after the reload");
    await shot("10-reload-reattached");
    const midText = await bodyText();
    assert(midText.includes("FAKE-REPLY-TWO"), "the reloaded page did not show the running reply");
    await waitFor(async () => (await bodyText()).includes("FAKE-REPLY-TWO streamed while the window reloaded and reattached."), 40000, "full second reply");
    await waitFor(async () => !(await page(`document.querySelector('[data-s="work"]') !== null`)), 20000, "second work ring gone");
    const secondCalls = fake.state.chat.filter((entry) => entry.prompt.includes("SECOND-PROMPT"));
    log(`reload: provider calls for the second prompt ${JSON.stringify(secondCalls.map((c) => ({ stream: c.stream, reply: c.reply })))}`);
    assert(secondCalls.length === 1, `expected one provider call for the second prompt, got ${secondCalls.length}`);
    await shot("11-prompt-two-done");

    // Settings reads the three APIs on their real screens; each panel renders only on a successful read.
    await click("#side-user .gear");
    await waitPage(`document.querySelector('#settings') !== null`, 10000, "settings screen");
    await clickByText("#settings-nav .set-nav-item", "Devices|设备");
    await waitFor(async () => (await page(`document.querySelector('#settings-main')?.innerText`))?.includes("0.0.0"), 15000, "device panel version");
    const device = await hostCall("settings.device.read");
    log(`settings.device.read: ${JSON.stringify(device)}`);
    assert(device.version === "0.0.0" && device.remote === false, `device settings ${JSON.stringify(device)}`);
    await shot("12-settings-device");

    await clickByText("#settings-nav .set-nav-item", "Usage|用量");
    await waitPage(`document.querySelector('#settings-main .set-usage-overview') !== null`, 20000, "usage panel with entries");
    const usage = await hostCall("settings.usage");
    log(`settings.usage: currency=${usage.currency} entries=${usage.entries?.length}`);
    assert(Array.isArray(usage.entries) && usage.entries.length > 0, "settings.usage returned no entries after two prompts");
    assert(usage.entries.some((entry) => String(entry.model).toLowerCase().includes("qwen")), `usage models: ${usage.entries.map((e) => e.model)}`);
    await shot("13-settings-usage");

    await clickByText("#settings-nav .set-nav-item", "Subagents|子智能体");
    await waitPage(`document.querySelector('#settings-main .set-select') !== null`, 20000, "agents panel selects");
    const agents = await hostCall("settings.agents.read");
    log(`settings.agents.read: models=${JSON.stringify(agents.models?.map((m) => m.id))} main=${JSON.stringify(agents.layout?.main)}`);
    assert(agents.models?.some((model) => model.id === fake.defaultSelector), `agents models ${JSON.stringify(agents.models)} do not include ${fake.defaultSelector}`);
    assert(agents.layout?.main?.model === fake.defaultSelector, `layout main is ${JSON.stringify(agents.layout?.main)}`);
    await shot("14-settings-agents");
    const labels = await page(`[...document.querySelectorAll('#settings-main .set-select option')].map((o) => o.textContent)`);
    assert(labels.some((label) => /Qwen3 Coder/i.test(label ?? "")), `model options ${JSON.stringify(labels.slice(0, 10))} do not show the fake model`);
    await click(".set-back");
    await waitPage(`document.querySelector('#settings') === null`, 10000, "settings closed");
  });
}

async function item6() {
  await runItem(6, "sidecar restart: the link goes down and recovers with the conversation still listed", async () => {
    // The subscription must be installed on the current document: item 5 reloaded the window.
    await page(`window.__e2eStatuses = []; window.__e2eStatusOff = window.cgsDesktop.host.onStatus((status, detail) => window.__e2eStatuses.push({ status, error: detail?.error })); true`);
    const sidecars = findProcesses({ cmdNeedle: "__cgs_worker_module", ppid: process.pid });
    const target = sidecars.find((proc) => proc.cmd.includes(sidecarPath)) ?? sidecars[0];
    assert(target, `no sidecar child of the app: ${JSON.stringify(sidecars)}`);
    log(`killing sidecar pid ${target.pid}: ${target.cmd}`);
    killPid(target.pid, "SIGKILL");
    await waitPage(`document.querySelector('[data-host-state="down"]') !== null`, 15000, "link down page");
    const downText = await page(`document.querySelector('[data-host-state="down"]')?.innerText`);
    log(`link down page: ${JSON.stringify(downText?.slice(0, 120))}`);
    await shot("15-link-down");
    await waitPage(`document.querySelector('#sidebar') !== null`, 40000, "app again after the sidecar restart");
    const statuses = await page("window.__e2eStatuses ?? []");
    log(`link statuses: ${JSON.stringify(statuses)}`);
    assert(statuses.some((entry) => entry.status === "down"), "the page never saw the link go down");
    assert(statuses.slice(statuses.findIndex((entry) => entry.status === "down")).some((entry) => entry.status === "ready"), "the link never recovered");

    const sessions = await hostRequest("/api/sessions");
    const listed = sessions.body?.workspaces?.find((workspace) => workspace.cwd === repo)?.sessions ?? [];
    log(`after restart /api/sessions: ${JSON.stringify(listed.map((s) => s.path))}`);
    assert(listed.some((session) => session.path === sessionPath), "the conversation is no longer listed after the sidecar restart");
    await waitPage(`document.querySelectorAll('#sidebar .sess').length > 0`, 15000, "sidebar lists the conversation");
    const children = await hostRequest("/api/children");
    log(`after restart /api/children: ${JSON.stringify(children.body?.children?.map((c) => ({ cwd: c.cwd, sessionPath: c.sessionPath, ring: c.ring })))}`);
    await shot("16-recovered");
  });
}

async function signOut() {
  await runItem("5b", "sign-out returns to the gate; the unit is unconfigured and its children are stopped", async () => {
    // Sign-out lives in Settings > Devices, not in the sidebar footer.
    assert(!(await page(`document.querySelector('#side-user .signout') !== null`)), "the sidebar footer still has a sign-out button");
    if (!(await page(`document.querySelector('#settings') !== null`))) await click("#side-user .gear");
    await waitPage(`document.querySelector('#settings') !== null`, 10000, "settings screen");
    await clickByText("#settings-nav .set-nav-item", "Devices|设备");
    await clickByText("#settings-main .set-btn.danger", "Sign out|退出登录");
    await sleep(300);
    await clickByText("#settings-main .set-btn.danger", "Confirm|确认");
    await waitPage(`document.querySelector('[data-host-state="signed-out"]') !== null`, 30000, "gate after sign-out");
    await shot("17-signed-out");
    const state = await hostCall("state");
    log(`state after sign-out: ${JSON.stringify(state)}`);
    assert(state.phase === "signed-out", `sidecar state after sign-out is ${state.phase}`);
    const snapshot = await hostCall("account.snapshot");
    assert(snapshot === null, `account snapshot after sign-out: ${JSON.stringify(snapshot)}`);
    assert(!fs.existsSync(path.join(agentDir, "cgs", "credentials.json")), "credentials.json still exists after sign-out");
    assert(fake.state.logoutRevoked, "the fake server never received the logout revoke");
    const children = await hostRequest("/api/children");
    log(`/api/children after sign-out: ${JSON.stringify(children)}`);
    assert(children.status !== 200 && children.body?.error === "not_configured", "the unit still answers child requests after sign-out");
    await waitFor(() => rpcChildren().length === 0, 15000, "omp children stopped");
    log(`rpc children after sign-out: ${JSON.stringify(rpcChildren())}`);
  });
}

// ---- main ------------------------------------------------------------------------------------------------------------
// No top-level await: Electron emits `ready` only after the entry module settles.
app.whenReady().then(async () => {
  let code = 0;
  try {
    if (!fs.existsSync(path.join(distRoot, "index.html"))) throw new Error(`missing ${distRoot}/index.html: run \`bun run build:desktop\` first`);
    fake = await startFakeCgs();
    process.env.CGS_BASE_URL = fake.url;
    log(`fake CGS at ${fake.url}; isolated home ${home}`);
    makeRepo();
    seedAgentDir();

    // The page's shell wiring: CLI sync already done (the sidecar is the CGS_SIDECAR override), dev updater stubs.
    ipcMain.handle("cgs:shell:sync", () => ({ phase: "ready", bypassed: true }));
    ipcMain.handle("window:isMaximized", () => false);
    ipcMain.handle("cgs:updater:status", () => ({ phase: "idle" }));
    ipcMain.handle("cgs:updater:getAutoCheck", () => true);
    ipcMain.handle("cgs:updater:setAutoCheck", () => undefined);
    ipcMain.handle("cgs:updater:check", () => ({ version: app.getVersion() }));
    ipcMain.handle("fs:areDirectories", () => []);
    // The right panel's files and Git, exactly as main.mjs exposes them.
    registerWorkspaceIpc(ipcMain);

    handleAppRequests({ protocol, root: distRoot });
    startLocalHost({ env: process.env });
    win = createWindow();

    await item1();
    await item2();
    await item3();
    await item4();
    await item5();
    await item6();
    await signOut();
  } catch (error) {
    code = 1;
    log(`FATAL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    try {
      const logFile = path.join(home, "userdata", "logs", "sidecar.log");
      if (fs.existsSync(logFile)) log(`sidecar.log tail:\n${fs.readFileSync(logFile, "utf8").split("\n").slice(-30).join("\n")}`);
    } catch {
      /* no log */
    }
  } finally {
    const failed = results.filter((result) => !result.ok);
    if (failed.length) code = 1;
    log("==== summary ====");
    for (const result of results) log(`${result.ok ? "PASS" : "FAIL"} ${result.number}. ${result.title}${result.ok ? "" : `: ${result.error instanceof Error ? result.error.message : result.error}`}`);
    log(`screenshots: ${screenshots.join(" ")}`);
    log(`isolated home: ${home}`);
    log(`${results.filter((r) => r.ok).length}/${results.length} items passed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    try {
      if (second) await second.shutdown();
    } catch {
      /* best effort */
    }
    // Everything this run started is ours: the sidecar (shutdown sends its protocol message), the daemon unit and the
    // omp children (killed by their unique environment), the fake server.
    for (const proc of findProcesses({ cmdNeedle: "__cgs_worker_module", ppid: process.pid })) killPid(proc.pid);
    for (const proc of rpcChildren()) killPid(proc.pid);
    for (const proc of findProcesses({ envNeedle: `CGS_DAEMON_DIR=${daemonDir}` })) killPid(proc.pid);
    await shutdownLocalHost().catch(() => {});
    await fake?.close().catch(() => {});
    app.exit(code);
  }
});
