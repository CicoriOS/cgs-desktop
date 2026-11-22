"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cgsLogin", {
  ready: () => ipcRenderer.invoke("cgs-login:ready"),
  start: () => ipcRenderer.invoke("cgs-login:start"),
  cancel: () => ipcRenderer.invoke("cgs-login:cancel"),
  openLink: () => ipcRenderer.invoke("cgs-login:open-link"),
  copyLink: () => ipcRenderer.invoke("cgs-login:copy-link"),
  close: () => ipcRenderer.invoke("cgs-login:close"),
  registerOpen: () => ipcRenderer.invoke("cgs-login:register-open"),
  registerSubmit: form => ipcRenderer.invoke("cgs-login:register-submit", { email: form.email, password: form.password }),
  registerVerify: code => ipcRenderer.invoke("cgs-login:register-verify", code),
  registerResend: () => ipcRenderer.invoke("cgs-login:register-resend"),
  registerBack: () => ipcRenderer.invoke("cgs-login:register-back"),
  registerClose: () => ipcRenderer.invoke("cgs-login:register-close"),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("cgs-login:state", listener);
    return () => ipcRenderer.removeListener("cgs-login:state", listener);
  },
});
