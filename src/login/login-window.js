"use strict";
// Startup login popup. openLoginWindow({ agentDir, baseUrl }) → Promise<"cgs" | "closed">: signed in through CGS, or the
// window was closed without signing in.
// The renderer (login.html/js/css) is pure presentation; the whole device-login flow runs here in the
// main process and is pushed to the renderer as `state` snapshots over IPC.

const path = require("node:path");
const { app, BrowserWindow, clipboard, ipcMain, nativeImage, nativeTheme, shell } = require("electron");
const { runDeviceFlow, CgsError } = require("../cgs/device-flow");
const { completeLogin } = require("../cgs/config-writer");
const { requestRegisterCode, completeRegister, MESSAGES } = require("../cgs/register-flow");

const WIDTH = 440;
const HEIGHT = 580;
const SUCCESS_HOLD_MS = 1800;
const CH = {
  state: "cgs-login:state",
  start: "cgs-login:start",
  cancel: "cgs-login:cancel",
  openLink: "cgs-login:open-link",
  copyLink: "cgs-login:copy-link",
  close: "cgs-login:close",
  ready: "cgs-login:ready",
  registerOpen: "cgs-login:register-open",
  registerSubmit: "cgs-login:register-submit",
  registerVerify: "cgs-login:register-verify",
  registerResend: "cgs-login:register-resend",
  registerBack: "cgs-login:register-back",
  registerClose: "cgs-login:register-close",
};

let active = null;

function openLoginWindow({ agentDir, baseUrl }) {
  if (active) {
    if (!active.win.isDestroyed()) active.win.focus();
    return active.promise;
  }
  let win;
  const promise = new Promise(resolve => {
    win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      useContentSize: true,
      center: true,
      show: false,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#1e1e1e" : "#ffffff",
      title: "Cicori Good Service",
      icon: nativeImage.createFromPath(
        path.join(__dirname, "..", "..", "assets", process.platform === "win32" ? "icon.ico" : "icon.png"),
      ),
      webPreferences: {
        preload: path.join(__dirname, "login-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    win.setMenuBarVisibility(false);

    let state = { screen: "initial" };
    let verificationUrl = null;
    let flow = null; // AbortController of the running flow
    let settled = false;
    let closeTimer = null;
    let registering = false; // the email-registration flow is the one on screen
    let pending = null; // { email, password, sessionId, expiresAt, resendAt }: a code was mailed
    let draftEmail = "";

    const push = next => {
      state = next;
      if (!win.isDestroyed()) win.webContents.send(CH.state, state);
    };

    const finish = result => {
      if (settled) return;
      settled = true;
      flow?.abort();
      clearTimeout(closeTimer);
      active = null;
      for (const ch of Object.values(CH)) ipcMain.removeHandler(ch);
      if (!win.isDestroyed()) win.destroy();
      resolve(result);
    };

    const fromWindow = handler => (event, ...args) => {
      if (win.isDestroyed() || event.sender !== win.webContents) return undefined;
      return handler(...args);
    };

    // Writes the credentials into the agent directory, shows the account for a moment, then closes.
    async function saveAndFinish(result, controller) {
      await completeLogin({ agentDir, baseUrl, ...result, signal: controller.signal });
      if (controller.signal.aborted) return;
      push({ screen: "success", tier: result.tier, username: result.username });
      closeTimer = setTimeout(() => finish("cgs"), SUCCESS_HOLD_MS);
    }

    async function start() {
      flow?.abort();
      const controller = new AbortController();
      flow = controller;
      verificationUrl = null;
      registering = false;
      let opened = false;
      push({ screen: "progress", step: "creating" });
      try {
        const result = await runDeviceFlow({
          baseUrl,
          appVersion: app.getVersion(),
          signal: controller.signal,
          onProgress: p => {
            if (controller.signal.aborted) return;
            if (p.phase === "creating") push({ screen: "progress", step: "creating" });
            else if (p.phase === "solving") push({ screen: "progress", step: "solving" });
            else if (p.phase === "waiting") {
              verificationUrl = p.verificationUrl;
              push({ screen: "waiting", verificationUrl: p.verificationUrl, expiresAt: p.expiresAt });
              if (!opened) {
                opened = true;
                openExternalSafe(p.verificationUrl);
              }
            }
          },
        });
        push({ screen: "progress", step: "saving" });
        await saveAndFinish(result, controller);
      } catch (err) {
        if (controller.signal.aborted) return;
        push({ screen: "error", message: userMessage(err) });
      }
    }

    function cancel() {
      flow?.abort();
      flow = null;
      verificationUrl = null;
      // Cancelling a registration step returns to the form, not to the start screen.
      if (registering) backToRegister();
      else push({ screen: "initial" });
    }

    // ---- email registration -------------------------------------------------------------------
    // The password stays in this process between the form and the code screen; the renderer only ever
    // sees the email.
    function backToRegister(error) {
      flow?.abort();
      flow = null;
      push({ screen: "register", email: pending?.email || draftEmail, error });
      pending = null;
    }

    async function requestCode(email, password) {
      flow?.abort();
      const controller = new AbortController();
      flow = controller;
      registering = true;
      draftEmail = email;
      const steps = ["creating", "solving", "sending"];
      push({ screen: "progress", steps, step: "creating" });
      try {
        const sent = await requestRegisterCode({
          baseUrl,
          email,
          appVersion: app.getVersion(),
          signal: controller.signal,
          onProgress: p => {
            if (!controller.signal.aborted) push({ screen: "progress", steps, step: p.phase });
          },
        });
        if (controller.signal.aborted) return;
        pending = { email, password, ...sent };
        push({ screen: "verify", email, expiresAt: sent.expiresAt, resendAt: sent.resendAt });
      } catch (err) {
        if (controller.signal.aborted) return;
        pending = null;
        push({ screen: "register", email, error: userMessage(err) });
      }
    }

    function submitRegistration(form) {
      const email = typeof form?.email === "string" ? form.email.trim() : "";
      const password = typeof form?.password === "string" ? form.password : "";
      draftEmail = email;
      if (!validEmail(email)) return push({ screen: "register", email, error: MESSAGES.email_invalid });
      if (!validPassword(password)) return push({ screen: "register", email, error: MESSAGES.password_invalid });
      return requestCode(email, password);
    }

    function resendCode() {
      if (!pending) return undefined;
      if (Date.now() < pending.resendAt) return undefined;
      return requestCode(pending.email, pending.password);
    }

    async function verifyRegistration(code) {
      if (!pending) return;
      const current = pending;
      const digits = typeof code === "string" ? code.trim() : "";
      const verify = error => push({ screen: "verify", email: current.email, expiresAt: current.expiresAt, resendAt: current.resendAt, error });
      if (!/^\d{6}$/.test(digits)) return verify("请输入邮件中的 6 位数字验证码");
      flow?.abort();
      const controller = new AbortController();
      flow = controller;
      const steps = ["registering", "saving"];
      push({ screen: "progress", steps, step: "registering" });
      let result;
      try {
        result = await completeRegister({ baseUrl, sessionId: current.sessionId, code: digits, password: current.password, signal: controller.signal });
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof CgsError && err.restart) backToRegister(userMessage(err));
        else verify(userMessage(err));
        return;
      }
      if (controller.signal.aborted) return;
      pending = null;
      try {
        push({ screen: "progress", steps, step: "saving" });
        await saveAndFinish(result, controller);
      } catch (err) {
        if (controller.signal.aborted) return;
        // The account exists and the code is spent: go on with the ordinary login instead of asking for a code again.
        const reason = err instanceof CgsError ? err.userMessage : err?.message || "未知错误";
        push({ screen: "error", message: `账号已创建，但未能完成登录：${reason}。请使用刚注册的账号登录。` });
      }
    }

    ipcMain.handle(CH.ready, fromWindow(() => state));
    ipcMain.handle(CH.start, fromWindow(() => void start()));
    ipcMain.handle(CH.cancel, fromWindow(cancel));
    ipcMain.handle(CH.openLink, fromWindow(() => verificationUrl && openExternalSafe(verificationUrl)));
    ipcMain.handle(CH.copyLink, fromWindow(() => verificationUrl && clipboard.writeText(verificationUrl)));
    ipcMain.handle(CH.close, fromWindow(() => finish("closed")));
    ipcMain.handle(CH.registerOpen, fromWindow(() => { flow?.abort(); flow = null; pending = null; registering = true; push({ screen: "register" }); }));
    ipcMain.handle(CH.registerSubmit, fromWindow((form) => void submitRegistration(form)));
    ipcMain.handle(CH.registerVerify, fromWindow((code) => void verifyRegistration(code)));
    ipcMain.handle(CH.registerResend, fromWindow(() => void resendCode()));
    ipcMain.handle(CH.registerClose, fromWindow(() => { flow?.abort(); flow = null; pending = null; registering = false; push({ screen: "initial" }); }));
    ipcMain.handle(CH.registerBack, fromWindow(() => backToRegister()));

    // Block any navigation / new windows from the page.
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", e => e.preventDefault());
    win.once("ready-to-show", () => win.show());
    win.on("closed", () => finish("closed"));
    win.loadFile(path.join(__dirname, "login.html"));
  });
  active = { win, promise };
  return promise;
}

function openExternalSafe(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || u.protocol === "http:") {
      return Promise.resolve(shell.openExternal(u.href)).catch(() => {});
    }
  } catch {
    // fall through
  }
  return undefined;
}

function userMessage(err) {
  if (err instanceof CgsError) return err.userMessage;
  return `登录失败：${err?.message || "未知错误"}`;
}

function validEmail(email) {
  return email.length <= 50 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** The server's rule: 8 to 128 characters. */
function validPassword(password) {
  const length = [...password].length;
  return length >= 8 && length <= 128;
}

module.exports = { openLoginWindow };
