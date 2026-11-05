"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cgsLogin", {
  ready: () => ipcRenderer.invoke("cgs-login:ready"),
  start: () => ipcRenderer.invoke("cgs-login:start"),
  cancel: () => ipcRenderer.invoke("cgs-login:cancel"),
  openLink: () => ipcRenderer.invoke("cgs-login:open-link"),
  copyLink: () => ipcRenderer.invoke("cgs-login:copy-link"),
  thirdParty: () => ipcRenderer.invoke("cgs-login:third-party"),
  close: () => ipcRenderer.invoke("cgs-login:close"),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("cgs-login:state", listener);
    return () => ipcRenderer.removeListener("cgs-login:state", listener);
  },
});
